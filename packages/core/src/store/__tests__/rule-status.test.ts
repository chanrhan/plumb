import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRuleStatuses } from '../../checks/index.js';
import type { CheckFailure, RuleStatusRecord } from '../../types/index.js';
import { ValidationError } from '../index.js';
import { makeTempStore, proposalFor, RECORD_RULE, REFUND_RULE, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

const AT = '2026-10-02T09:00:00.000Z';
const CHECK = REFUND_RULE.checks[0] ?? { kind: 'acceptance' as const, ref: 'x' };

const FAILURE: CheckFailure = {
  check: CHECK,
  anchor: { block: 'payment', file: CHECK.ref, line: 12 },
  message: 'expected 7 to be 30',
};

function statusRecord(overrides: Partial<RuleStatusRecord> = {}): RuleStatusRecord {
  return {
    ruleId: REFUND_RULE.id,
    detail: { status: 'unchecked', reason: 'check-missing' },
    since: AT,
    commit: 'a1b2c3d',
    checkedAt: AT,
    history: ['unchecked'],
    ...overrides,
  };
}

describe('store.ruleStatus', () => {
  it('write(records) → 규칙별 rule-status/<ruleId>.json → get · list 왕복', async () => {
    const a = statusRecord();
    const b = statusRecord({
      ruleId: RECORD_RULE.id,
      detail: { status: 'fail', failures: [FAILURE] },
      history: ['pass-unverified', 'fail'],
    });
    const written = await t.store.ruleStatus.write([b, a]);
    expect(written).toEqual([b, a]);

    expect((await readdir(t.store.paths.ruleStatusDir)).sort()).toEqual([
      'pay.payment-record.json',
      'pay.refund-window.json',
    ]);
    expect(await t.store.ruleStatus.get(REFUND_RULE.id)).toEqual(a);
    expect(await t.store.ruleStatus.get(RECORD_RULE.id)).toEqual(b);
    // list는 규칙 ID 순
    expect(await t.store.ruleStatus.list()).toEqual([b, a]);
  });

  it('없는 규칙은 undefined, 빈 폴더는 []', async () => {
    expect(await t.store.ruleStatus.get(REFUND_RULE.id)).toBeUndefined();
    expect(await t.store.ruleStatus.list()).toEqual([]);
  });

  it('다시 쓰면 덮어쓴다 (규칙당 파일 하나)', async () => {
    await t.store.ruleStatus.write([statusRecord()]);
    await t.store.ruleStatus.write([statusRecord({ detail: { status: 'pass-unverified', reason: 'no-injection' } })]);
    expect((await t.store.ruleStatus.get(REFUND_RULE.id))?.detail).toEqual({
      status: 'pass-unverified',
      reason: 'no-injection',
    });
    expect(await readdir(t.store.paths.ruleStatusDir)).toEqual(['pay.refund-window.json']);
  });

  it('failures 없는 fail은 저장소도 거부한다 — 전부 검증한 뒤 쓰므로 같은 묶음의 다른 기록도 안 쓰인다', async () => {
    await expect(
      t.store.ruleStatus.write([
        statusRecord(),
        { ...statusRecord({ ruleId: RECORD_RULE.id }), detail: { status: 'fail', failures: [] } },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.ruleStatus.write([{ ...statusRecord(), detail: { status: 'fail' } }])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await readdir(t.store.paths.ruleStatusDir)).toEqual([]);
  });

  it('스키마 밖 모양은 ValidationError (알 수 없는 reason · 날짜 아님 · 규칙 ID 형식)', async () => {
    await expect(
      t.store.ruleStatus.write([{ ...statusRecord(), detail: { status: 'unchecked', reason: 'llm-said-so' } }]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.ruleStatus.write([statusRecord({ since: 'yesterday' })])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(t.store.ruleStatus.write([{ ...statusRecord(), ruleId: 'no-dot' }])).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('computeRuleStatuses → write → get: 승인된 규칙의 검사 파일이 없으면 ⬜ check-missing', async () => {
    await t.store.proposals.write(proposalFor(REFUND_RULE));
    await t.store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: 'p-0001', by: 'dev' });
    const rules = await t.store.rules.list();

    const records = computeRuleStatuses({
      rules,
      approvalStates: new Map([[REFUND_RULE.id, 'approved']]),
      results: [],
      quarantined: [],
      previous: new Map(),
      fileExists: () => false,
      now: new Date(AT),
      commit: 'a1b2c3d',
    });
    await t.store.ruleStatus.write(records);

    expect(await t.store.ruleStatus.get(REFUND_RULE.id)).toEqual({
      ruleId: REFUND_RULE.id,
      detail: { status: 'unchecked', reason: 'check-missing' },
      since: AT,
      commit: 'a1b2c3d',
      checkedAt: AT,
      history: ['unchecked'],
    });
  });
});
