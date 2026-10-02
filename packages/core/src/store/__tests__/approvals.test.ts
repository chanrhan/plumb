import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockConfig } from '../../types/index.js';
import {
  hashProposal,
  hashRulesFile,
  isHighRisk,
  ProposalChangedError,
  ProposalNotFoundError,
  RuleNotFoundError,
  requiresPriorApproval,
  ValidationError,
} from '../index.js';
import { makeTempStore, proposalFor, RECORD_RULE, REFUND_RULE, type TempStore } from './fixtures.js';

const HIGH_RISK_BLOCKS: Record<string, BlockConfig> = {
  payment: { include: ['src/domains/payment/**'], risk: 'high' },
};

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

async function approveAdd(rule = RECORD_RULE, id: `p-${string}` = 'p-0001') {
  const proposal = await t.store.proposals.write(proposalFor(rule, { id }));
  const result = await t.store.approvals.approve({ ruleId: rule.id, proposalId: proposal.id, by: 'dev' });
  if (!result.applied) throw new Error('예상 밖: 사전 승인');
  return result;
}

describe('approve', () => {
  it('add: rules.yaml에 추가, approvals 한 줄(rulesHash = 반영 후 파일 해시), 제안 applied', async () => {
    const result = await approveAdd();

    expect(result.rule).toEqual(RECORD_RULE);
    expect(await t.store.rules.list()).toEqual([RECORD_RULE]);
    expect(result.rulesHash).toBe(await hashRulesFile(t.store.paths));
    expect(result.approval).toEqual({
      ruleId: RECORD_RULE.id,
      proposalId: 'p-0001',
      action: 'approve',
      at: expect.stringMatching(/^2026-10-02T/),
      by: 'dev',
      proposalHash: hashProposal(proposalFor(RECORD_RULE)),
      rulesHash: result.rulesHash,
    });
    expect(result.proposal.applied).toBe('applied');
    expect(await t.store.approvals.history(RECORD_RULE.id)).toEqual([result.approval]);
  });

  it('note는 줄에 남는다', async () => {
    const proposal = await t.store.proposals.write(proposalFor(RECORD_RULE));
    const result = await t.store.approvals.approve({
      ruleId: RECORD_RULE.id,
      proposalId: proposal.id,
      by: 'dev',
      note: '첫 규칙',
    });
    expect(result.applied && result.approval.note).toBe('첫 규칙');
  });

  it('같은 제안을 두 번 승인할 수 없다 (이미 처리됨)', async () => {
    await approveAdd();
    await expect(
      t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: 'dev' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await t.store.rules.list()).toHaveLength(1);
    expect(await t.store.approvals.history(RECORD_RULE.id)).toHaveLength(1);
  });

  it('add인데 규칙이 이미 있으면 ValidationError, 아무것도 쓰지 않는다', async () => {
    const first = await approveAdd();
    await t.store.proposals.write(proposalFor(RECORD_RULE, { id: 'p-0002' }));
    await expect(
      t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0002', by: 'dev' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await hashRulesFile(t.store.paths)).toBe(first.rulesHash);
    expect(await t.store.approvals.history(RECORD_RULE.id)).toHaveLength(1);
  });

  it('strengthen: 교체. 해시가 바뀌고 두 번째 줄이 쌓인다', async () => {
    const first = await approveAdd();
    const stronger = { ...RECORD_RULE, statement: `${RECORD_RULE.statement} (멱등)` };
    await t.store.proposals.write(
      proposalFor(stronger, { id: 'p-0002', changeKind: 'strengthen', before: RECORD_RULE }),
    );

    const result = await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0002', by: 'dev' });

    expect(result.applied).toBe(true);
    expect(await t.store.rules.list()).toEqual([stronger]);
    expect(result.applied && result.rulesHash).not.toBe(first.rulesHash);
    expect((await t.store.approvals.history(RECORD_RULE.id)).map((a) => a.proposalId)).toEqual(['p-0001', 'p-0002']);
  });

  it('strengthen · delete 대상이 없으면 RuleNotFoundError', async () => {
    await t.store.proposals.write(proposalFor(RECORD_RULE, { changeKind: 'strengthen', before: RECORD_RULE }));
    await expect(
      t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: 'dev' }),
    ).rejects.toBeInstanceOf(RuleNotFoundError);
  });

  it('일반 영역 delete: 즉시 제거', async () => {
    await approveAdd();
    await t.store.proposals.write(
      proposalFor(RECORD_RULE, { id: 'p-0002', changeKind: 'delete', before: RECORD_RULE, after: null }),
    );

    const result = await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0002', by: 'dev' });

    expect(result.applied).toBe(true);
    expect(result.applied && result.rule).toBeNull();
    expect(await t.store.rules.list()).toEqual([]);
  });

  it('boundary: 블록 변경 교체 (일반 영역)', async () => {
    await approveAdd();
    const moved = { ...RECORD_RULE, block: 'ledger' };
    await t.store.proposals.write(proposalFor(moved, { id: 'p-0002', changeKind: 'boundary', before: RECORD_RULE }));
    const result = await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0002', by: 'dev' });
    expect(result.applied).toBe(true);
    expect((await t.store.rules.get(RECORD_RULE.id))?.block).toBe('ledger');
  });

  describe('고위험', () => {
    it('규칙 risk: high의 relax → requiresPriorApproval, 아무것도 쓰지 않는다', async () => {
      const added = await approveAdd(REFUND_RULE);
      const relaxed = {
        ...REFUND_RULE,
        statement: 'WHEN 환불 요청이 결제 후 30일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
      };
      await t.store.proposals.write(proposalFor(relaxed, { id: 'p-0002', changeKind: 'relax', before: REFUND_RULE }));

      const result = await t.store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: 'p-0002', by: 'dev' });

      expect(result).toMatchObject({ applied: false, requiresPriorApproval: true });
      expect(await t.store.rules.list()).toEqual([REFUND_RULE]); // 승인 전까지 기존 규칙 유효
      expect(await hashRulesFile(t.store.paths)).toBe(added.rulesHash);
      expect(await t.store.approvals.history(REFUND_RULE.id)).toHaveLength(1);
      expect((await t.store.proposals.get(REFUND_RULE.id, 'p-0002'))?.applied).toBe('provisional');
    });

    it('블록 선언(config.blocks.<id>.risk)으로도 고위험 — delete · boundary', async () => {
      await t.cleanup();
      t = await makeTempStore({ blocks: HIGH_RISK_BLOCKS });
      await approveAdd(); // RECORD_RULE은 risk: normal이지만 payment 블록
      await t.store.proposals.write(
        proposalFor(RECORD_RULE, { id: 'p-0002', changeKind: 'delete', before: RECORD_RULE, after: null }),
      );
      await t.store.proposals.write(
        proposalFor({ ...RECORD_RULE, block: 'ledger' }, { id: 'p-0003', changeKind: 'boundary', before: RECORD_RULE }),
      );

      const del = await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0002', by: 'dev' });
      const boundary = await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0003', by: 'dev' });

      expect(del.applied).toBe(false);
      expect(boundary.applied).toBe(false);
      expect(await t.store.rules.list()).toEqual([RECORD_RULE]);
    });

    it('고위험이라도 add · strengthen은 즉시 적용', async () => {
      await t.cleanup();
      t = await makeTempStore({ blocks: HIGH_RISK_BLOCKS });
      await approveAdd(REFUND_RULE);
      const stronger = { ...REFUND_RULE, statement: `${REFUND_RULE.statement} 그리고 기록한다` };
      await t.store.proposals.write(
        proposalFor(stronger, { id: 'p-0002', changeKind: 'strengthen', before: REFUND_RULE }),
      );
      const result = await t.store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: 'p-0002', by: 'dev' });
      expect(result.applied).toBe(true);
      expect(await t.store.rules.list()).toEqual([stronger]);
    });

    it('isHighRisk · requiresPriorApproval 판정', () => {
      const normal = proposalFor(RECORD_RULE);
      expect(isHighRisk(normal, {})).toBe(false);
      expect(isHighRisk(normal, { blocks: HIGH_RISK_BLOCKS })).toBe(true);
      expect(isHighRisk(proposalFor(REFUND_RULE), {})).toBe(true);
      expect(requiresPriorApproval(proposalFor(REFUND_RULE), {})).toBe(false); // add
      expect(requiresPriorApproval(proposalFor(REFUND_RULE, { changeKind: 'relax', before: REFUND_RULE }), {})).toBe(
        true,
      );
      expect(requiresPriorApproval(proposalFor(RECORD_RULE, { changeKind: 'relax', before: RECORD_RULE }), {})).toBe(
        false,
      );
      // before가 고위험 블록이고 after가 다른 블록으로 옮기는 boundary도 사전 승인
      const out = proposalFor({ ...RECORD_RULE, block: 'ledger' }, { changeKind: 'boundary', before: RECORD_RULE });
      expect(requiresPriorApproval(out, { blocks: HIGH_RISK_BLOCKS })).toBe(true);
    });
  });

  it('expectedProposalHash가 다르면 ProposalChangedError (409)', async () => {
    const proposal = await t.store.proposals.write(proposalFor(RECORD_RULE));
    await expect(
      t.store.approvals.approve({
        ruleId: RECORD_RULE.id,
        proposalId: proposal.id,
        by: 'dev',
        expectedProposalHash: 'stale',
      }),
    ).rejects.toBeInstanceOf(ProposalChangedError);
    const ok = await t.store.approvals.approve({
      ruleId: RECORD_RULE.id,
      proposalId: proposal.id,
      by: 'dev',
      expectedProposalHash: hashProposal(proposal),
    });
    expect(ok.applied).toBe(true);
  });

  it('제안 없음 → ProposalNotFoundError, by 비어 있음 → ValidationError', async () => {
    await expect(t.store.approvals.approve({ ruleId: 'pay.x', proposalId: 'p-0', by: 'dev' })).rejects.toBeInstanceOf(
      ProposalNotFoundError,
    );
    await t.store.proposals.write(proposalFor(RECORD_RULE));
    await expect(
      t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: ' ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('reject', () => {
  it('사유 필수. 줄에는 reason이 있고 rulesHash는 없다. rules.yaml은 그대로', async () => {
    const added = await approveAdd();
    await t.store.proposals.write(
      proposalFor(RECORD_RULE, { id: 'p-0002', changeKind: 'strengthen', before: RECORD_RULE }),
    );

    await expect(
      t.store.approvals.reject({ ruleId: RECORD_RULE.id, proposalId: 'p-0002', by: 'dev', reason: '' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const result = await t.store.approvals.reject({
      ruleId: RECORD_RULE.id,
      proposalId: 'p-0002',
      by: 'dev',
      reason: '중복 규칙',
    });

    expect(result.approval).toEqual({
      ruleId: RECORD_RULE.id,
      proposalId: 'p-0002',
      action: 'reject',
      at: expect.any(String),
      by: 'dev',
      reason: '중복 규칙',
      proposalHash: expect.any(String),
    });
    expect(result.approval).not.toHaveProperty('rulesHash');
    expect(result.proposal.applied).toBe('rejected');
    expect(await hashRulesFile(t.store.paths)).toBe(added.rulesHash);
    const lines = (await readFile(t.store.paths.approvals(RECORD_RULE.id), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '')).toEqual(result.approval);
  });

  it('기각한 제안은 다시 승인할 수 없다', async () => {
    await t.store.proposals.write(proposalFor(RECORD_RULE));
    await t.store.approvals.reject({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: 'dev', reason: '아직' });
    await expect(
      t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: 'dev' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await t.store.rules.list()).toEqual([]);
  });
});
