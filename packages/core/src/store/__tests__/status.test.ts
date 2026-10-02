import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckRun, ReviewQueueItem } from '../../types/index.js';
import { EMPTY_RULES_HASH, hashRulesFile, serializeRulesDocument, toStatusResponse } from '../index.js';
import { makeTempStore, proposalFor, RECORD_RULE, REFUND_RULE, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

function checkRun(runId: `c-${string}`, finishedAt: string): CheckRun {
  return {
    runId,
    commit: 'a1b2c3d',
    startedAt: finishedAt,
    finishedAt,
    runner: { exitCode: 0 },
    results: [],
    quarantined: [],
    counts: { junit: 0, static: 0 },
    storeStatus: 'ok',
  };
}

describe('storeStatus', () => {
  it('방금 만든 저장소: 승인 기록 없음 + 빈 rules.yaml → ok', async () => {
    const status = await t.store.status();
    expect(status).toEqual({
      project: 'testbed',
      status: 'ok',
      rulesHash: EMPTY_RULES_HASH,
      lastApproval: null,
      rulesCount: 0,
      approvedCount: 0,
      unconfirmed: 0,
      longestPendingDays: null,
      lastCheck: null,
      reviewQueue: 0,
    });
  });

  it('승인 기록 없이 rules.yaml에 내용이 있으면 unverified', async () => {
    await writeFile(t.store.paths.rules, serializeRulesDocument([RECORD_RULE]));
    const status = await t.store.status();
    expect(status.status).toBe('unverified');
    expect(status.rulesCount).toBe(1);
    expect(status.approvedCount).toBe(0);
  });

  it('마지막 승인의 해시 = 현재 해시 → ok. 손으로 고치면 tampered, 기각이 그것을 덮어 주지 않는다', async () => {
    await t.store.proposals.write(proposalFor(RECORD_RULE));
    await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: 'dev' });
    expect((await t.store.status()).status).toBe('ok');

    await writeFile(t.store.paths.rules, serializeRulesDocument([{ ...RECORD_RULE, risk: 'high' }]));
    expect((await t.store.status()).status).toBe('tampered');

    // 기각 줄에는 rulesHash가 없으므로 변조 상태가 유지된다
    await t.store.proposals.write(proposalFor(REFUND_RULE, { id: 'p-0002' }));
    await t.store.approvals.reject({ ruleId: REFUND_RULE.id, proposalId: 'p-0002', by: 'dev', reason: '보류' });
    expect((await t.store.status()).status).toBe('tampered');

    // 다음 승인이 새 해시를 기록하면 다시 ok
    await t.store.proposals.write(proposalFor(REFUND_RULE, { id: 'p-0003' }));
    await t.store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: 'p-0003', by: 'dev' });
    const after = await t.store.status();
    expect(after.status).toBe('ok');
    expect(after.rulesHash).toBe(await hashRulesFile(t.store.paths));
    expect(after.lastApproval?.proposalId).toBe('p-0003');
    expect(after.rulesCount).toBe(2);
    expect(after.approvedCount).toBe(2);
  });

  it('approvedCount: rules.yaml에 있으면서 마지막 기록이 approve인 규칙만', async () => {
    await t.store.proposals.write(proposalFor(RECORD_RULE));
    await t.store.approvals.approve({ ruleId: RECORD_RULE.id, proposalId: 'p-0001', by: 'dev' });
    // 기각된 다른 규칙은 rules.yaml에 없다
    await t.store.proposals.write(proposalFor(REFUND_RULE, { id: 'p-0002' }));
    await t.store.approvals.reject({ ruleId: REFUND_RULE.id, proposalId: 'p-0002', by: 'dev', reason: '보류' });

    const status = await t.store.status();
    expect(status.rulesCount).toBe(1);
    expect(status.approvedCount).toBe(1);
  });

  it('unconfirmed = provisional 제안 수, longestPendingDays = 가장 오래된 것의 체류 일수', async () => {
    await t.store.proposals.write(proposalFor(RECORD_RULE, { id: 'p-0001', proposedAt: '2026-09-20T09:00:00.000Z' }));
    await t.store.proposals.write(proposalFor(REFUND_RULE, { id: 'p-0002', proposedAt: '2026-10-01T23:00:00.000Z' }));
    await t.store.proposals.write(
      proposalFor(REFUND_RULE, {
        id: 'p-0003',
        proposedAt: '2026-09-01T00:00:00.000Z',
        applied: 'pending',
        requiresPriorApproval: true,
      }),
    );

    const status = await t.store.status();

    expect(status.unconfirmed).toBe(2); // pending은 세지 않는다
    expect(status.longestPendingDays).toBe(12); // 09-20 09:00 → 10-02 09:00:01
  });

  it('lastCheck: checks/의 가장 최근 finishedAt', async () => {
    const { writeFile: write } = await import('node:fs/promises');
    await write(t.store.paths.check('c-0001'), JSON.stringify(checkRun('c-0001', '2026-10-01T10:00:00.000Z')));
    await write(t.store.paths.check('c-0002'), JSON.stringify(checkRun('c-0002', '2026-10-02T08:00:00.000Z')));
    await write(t.store.paths.check('c-0003'), JSON.stringify(checkRun('c-0003', '2026-10-01T23:00:00.000Z')));

    const status = await t.store.status();

    expect(status.lastCheck?.runId).toBe('c-0002');
    expect(toStatusResponse(status).lastCheck).toEqual({ commit: 'a1b2c3d', finishedAt: '2026-10-02T08:00:00.000Z' });
  });

  it('reviewQueue: resolvedAt 없는 항목 수', async () => {
    const item = (id: `q-${string}`, resolvedAt?: string): ReviewQueueItem => ({
      id,
      kind: 'dispute',
      ruleIds: [RECORD_RULE.id],
      summary: '…',
      createdAt: '2026-10-01T00:00:00.000Z',
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
    });
    await writeFile(t.store.paths.reviewQueueItem('q-0001'), JSON.stringify(item('q-0001')));
    await writeFile(
      t.store.paths.reviewQueueItem('q-0002'),
      JSON.stringify(item('q-0002', '2026-10-01T01:00:00.000Z')),
    );

    expect((await t.store.status()).reviewQueue).toBe(1);
  });

  it('toStatusResponse: GET /api/status 모양', async () => {
    await t.store.proposals.write(proposalFor(RECORD_RULE));
    const response = toStatusResponse(await t.store.status());
    expect(response).toEqual({
      project: 'testbed',
      store: { status: 'ok' },
      unconfirmed: { total: 1, provisionalRules: 1, reviewQueue: 0 },
    });
  });
});
