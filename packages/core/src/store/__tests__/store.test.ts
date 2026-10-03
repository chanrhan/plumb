/**
 * 이슈 #31 "완료 증거" 시나리오 통합 테스트:
 * init → proposal(add) → approve → rules.yaml에 규칙 1개 · approvals 1줄 · status ok → rules.yaml을 손으로 고침 → status tampered
 * → reject(사유 없음)는 오류.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as storeApi from '../index.js';
import { ValidationError } from '../index.js';
import { makeTempStore, proposalFor, REFUND_RULE, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore({ blocks: { payment: { include: ['src/domains/payment/**'], risk: 'high' } } });
});

afterEach(() => t.cleanup());

describe('보호 저장소 — init → propose → approve → tamper', () => {
  it('승인 없이 rules.yaml을 바꾸면 tampered', async () => {
    const { store, storeDir } = t;

    // init: 빈 rules.yaml · meta.json · 폴더
    expect(await readFile(join(storeDir, 'rules.yaml'), 'utf8')).toBe('version: 1\nrules: []\n');
    const meta = JSON.parse(await readFile(join(storeDir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ version: 1, project: 'testbed' });
    expect((await store.status()).status).toBe('ok');
    expect(await store.rules.list()).toEqual([]);

    // proposal(add) — 에이전트/CLI가 쓰는 유일한 경로
    const proposal = await store.proposals.write(proposalFor(REFUND_RULE));
    expect(await store.proposals.list(REFUND_RULE.id)).toEqual([proposal]);
    expect(await store.rules.list()).toEqual([]); // 제안은 rules.yaml을 바꾸지 않는다
    const beforeApprove = await store.status();
    expect(beforeApprove.unconfirmed).toBe(1);
    expect(beforeApprove.longestPendingDays).toBe(1); // 10-01 05:00 제안, 10-02 09:00 기준

    // approve — 고위험 블록이지만 add는 사전 승인 대상이 아니다
    const result = await store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: proposal.id, by: 'test' });
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error('unreachable');

    // rules.yaml에 규칙 1개
    expect(await store.rules.list()).toEqual([REFUND_RULE]);
    expect(await store.rules.get(REFUND_RULE.id)).toEqual(REFUND_RULE);
    const yamlText = await readFile(join(storeDir, 'rules.yaml'), 'utf8');
    expect(yamlText).toContain('- id: pay.refund-window');
    expect(yamlText).toContain('statement: WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다');

    // approvals 1줄, 반영 후 해시 포함
    const lines = (await readFile(join(storeDir, 'approvals', 'pay.refund-window.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '');
    expect(line).toMatchObject({ ruleId: REFUND_RULE.id, proposalId: 'p-0001', action: 'approve', by: 'test' });
    expect(line.rulesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.approvals.history(REFUND_RULE.id)).toEqual([line]);

    // 제안 파일은 applied
    expect((await store.proposals.get(REFUND_RULE.id, proposal.id))?.applied).toBe('applied');

    // status ok
    const ok = await store.status();
    expect(ok.status).toBe('ok');
    expect(ok.rulesCount).toBe(1);
    expect(ok.approvedCount).toBe(1);
    expect(ok.unconfirmed).toBe(0);
    expect(ok.longestPendingDays).toBeNull();
    expect(ok.lastCheck).toBeNull();
    expect(ok.rulesHash).toBe(line.rulesHash);

    // rules.yaml을 손으로 고친다 (승인 없이) → tampered
    await writeFile(join(storeDir, 'rules.yaml'), yamlText.replace('7일', '30일'));
    const tampered = await store.status();
    expect(tampered.status).toBe('tampered');
    expect(tampered.rulesHash).not.toBe(line.rulesHash);
    expect(tampered.lastApproval?.rulesHash).toBe(line.rulesHash);

    // reject(사유 없음)는 오류
    const second = await store.proposals.write(
      proposalFor(
        { ...REFUND_RULE, statement: '다른 진술' },
        { id: 'p-0002', changeKind: 'strengthen', before: REFUND_RULE },
      ),
    );
    await expect(
      store.approvals.reject({ ruleId: REFUND_RULE.id, proposalId: second.id, by: 'test', reason: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.approvals.reject({ ruleId: REFUND_RULE.id, proposalId: second.id, by: 'test', reason: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // 실패한 기각은 아무것도 남기지 않는다
    expect(await store.approvals.history(REFUND_RULE.id)).toHaveLength(1);
    expect((await store.proposals.get(REFUND_RULE.id, second.id))?.applied).toBe('provisional');
  });

  it('Store 표면에는 rules 쓰기가 없다 — rules.yaml을 바꾸는 길은 approvals.approve뿐', () => {
    expect(Object.keys(t.store.rules).sort()).toEqual(['get', 'list']);
    expect(Object.keys(t.store.proposals).sort()).toEqual(['get', 'list', 'write']);
    expect(Object.keys(t.store.approvals).sort()).toEqual(['approve', 'history', 'reject']);
    expect(Object.keys(t.store.checks).sort()).toEqual(['latest', 'list', 'write']);
    expect(Object.keys(t.store.contracts).sort()).toEqual(['approve', 'get', 'list']);
    expect(Object.keys(t.store.ruleStatus).sort()).toEqual(['get', 'list', 'write']);
    expect(Object.keys(t.store.views).sort()).toEqual(['list', 'read', 'write']);
    expect(Object.keys(t.store.codeOpens).sort()).toEqual(['append', 'count', 'list', 'summary']);
    // 실행 상태 · 검토 대기열(#86) — 쓰기는 오케스트레이터 몫이고 rules.yaml과 무관하다
    expect(Object.keys(t.store.runs).sort()).toEqual(['active', 'get', 'list', 'nextId', 'write']);
    expect(Object.keys(t.store.reviewQueue).sort()).toEqual(['enqueue', 'list', 'nextId']);
    expect(Object.keys(t.store).sort()).toEqual([
      'approvals',
      'checks',
      'codeOpens',
      'contracts',
      'init',
      'paths',
      'proposals',
      'reviewQueue',
      'ruleStatus',
      'rules',
      'runs',
      'status',
      'views',
    ]);
    expect('writeRules' in storeApi).toBe(false);
    expect('updateProposal' in storeApi).toBe(false);
  });
});
