import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashProposal, ValidationError } from '../index.js';
import { makeTempStore, proposalFor, RECORD_RULE, REFUND_RULE, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

describe('proposals', () => {
  it('write: 검증 뒤 proposals/<ruleId>/<p-id>.json에 쓴다', async () => {
    const proposal = await t.store.proposals.write(proposalFor(REFUND_RULE));
    const onDisk = JSON.parse(await readFile(t.store.paths.proposal(REFUND_RULE.id, 'p-0001'), 'utf8'));
    expect(onDisk).toEqual(proposal);
    expect(await t.store.proposals.get(REFUND_RULE.id, 'p-0001')).toEqual(proposal);
    expect(await t.store.proposals.get(REFUND_RULE.id, 'p-9999')).toBeUndefined();
  });

  it('write: after에 YAML 축약(checks 문자열 · depends_on 생략)을 받아 Rule로 정규화한다', async () => {
    const { depends_on: _d, checks: _c, ...rest } = REFUND_RULE;
    const input = {
      ...proposalFor(REFUND_RULE),
      after: {
        ...rest,
        depends_on: ['pay.payment-record'],
        checks: ['test/acceptance/refund-window.property.spec.ts'],
      },
    };
    const proposal = await t.store.proposals.write(input);
    expect(proposal.after).toEqual(REFUND_RULE);
  });

  it('write: 스키마 위반 → ValidationError (경로: 메시지)', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['after.id ≠ ruleId', proposalFor(REFUND_RULE, { ruleId: 'pay.other' }), 'after.id'],
      ['delete인데 after 있음', proposalFor(REFUND_RULE, { changeKind: 'delete' }), 'after'],
      ['add인데 after null', proposalFor(REFUND_RULE, { after: null }), 'after'],
      ['add인데 before 있음', proposalFor(REFUND_RULE, { before: REFUND_RULE }), 'before'],
      ['잘못된 제안 ID', proposalFor(REFUND_RULE, { id: 'x-1' as never }), 'id'],
      ['잘못된 proposedBy', proposalFor(REFUND_RULE, { proposedBy: 'agent' as never }), 'proposedBy'],
      ['시각 형식', proposalFor(REFUND_RULE, { proposedAt: '어제' }), 'proposedAt'],
      ['알 수 없는 키', { ...proposalFor(REFUND_RULE), extra: 1 }, 'extra'],
    ];
    for (const [label, input, path] of cases) {
      const error = await t.store.proposals.write(input).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message, label).toContain(path);
    }
    expect(await t.store.proposals.list()).toEqual([]);
  });

  it('list: 전체 또는 규칙 하나, proposedAt 오름차순', async () => {
    const a = await t.store.proposals.write(
      proposalFor(REFUND_RULE, { id: 'p-0002', proposedAt: '2026-10-01T07:00:00.000Z' }),
    );
    const b = await t.store.proposals.write(
      proposalFor(REFUND_RULE, { id: 'p-0001', proposedAt: '2026-10-01T05:00:00.000Z' }),
    );
    const c = await t.store.proposals.write(
      proposalFor(RECORD_RULE, { id: 'p-0003', proposedAt: '2026-09-30T00:00:00.000Z' }),
    );

    expect(await t.store.proposals.list()).toEqual([c, b, a]);
    expect(await t.store.proposals.list(REFUND_RULE.id)).toEqual([b, a]);
    expect(await t.store.proposals.list('pay.none')).toEqual([]);
  });

  it('hashProposal: 키 순서와 무관, 내용이 다르면 다르다', () => {
    const p = proposalFor(REFUND_RULE);
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as typeof p;
    expect(hashProposal(reordered)).toBe(hashProposal(p));
    expect(hashProposal({ ...p, proposedAt: '2026-10-01T05:00:01.000Z' })).not.toBe(hashProposal(p));
    expect(hashProposal(p)).toMatch(/^[0-9a-f]{64}$/);
  });
});
