/**
 * 이슈 #34 "완료 증거": 임시 저장소를 `PLUMB_TARGET`으로 두고 route handler 함수를 직접 부른다.
 * 목록 빈 배열 → 제안 작성(코어 API) → 목록 1(provisional) → approve 200 → 승인 상태 → `plumb check` 기록(코어 API로 `checks/` ·
 * `rule-status/`) → 상태 열 🔴 + 커밋 · 시각 + 실패 file:line (#47) → reject 사유 없음 400 → 없는 id 404.
 * 인증(401)은 #33 미들웨어의 몫이라 여기 없다.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApiError,
  type Approval,
  type ApproveResponse,
  type CheckFailure,
  type CheckRef,
  hashProposal,
  loadConfig,
  openStore,
  type Proposal,
  type Rule,
  type RuleDetailResponse,
  type RuleListResponse,
  type Store,
} from '@plumb/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REFUND_CHECK: CheckRef = { kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' };

const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: ['pay.payment-record'],
  checks: [REFUND_CHECK],
  decision: 'D-0001',
};

/** `plumb check`가 남기는 모양의 기록 (checks/ + rule-status/). 상태 열의 원자료 */
const CHECK_COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const CHECKED_AT = '2026-10-02T09:00:05.000Z';
const REFUND_FAILURE: CheckFailure = {
  check: REFUND_CHECK,
  anchor: { file: 'test/acceptance/refund-window.property.spec.ts', line: 42 },
  message: 'expected 8 to be less than 8',
  counterexample: '[8]',
  seed: '42',
};

function proposalFor(rule: Rule, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-0001',
    ruleId: rule.id,
    changeKind: 'add',
    proposedBy: 'cli',
    proposedAt: '2026-10-01T05:00:00.000Z',
    after: rule,
    requiresPriorApproval: false,
    applied: 'provisional',
    ...overrides,
  };
}

const ROLE = { model: 'test-model', maxTurns: 1, maxBudgetUsd: 0 };

let dir: string;
let store: Store;
let routes: {
  list: typeof import('@/app/api/rules/route');
  detail: typeof import('@/app/api/rules/[id]/route');
  approve: typeof import('@/app/api/rules/[id]/approve/route');
  reject: typeof import('@/app/api/rules/[id]/reject/route');
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new NextRequest(`http://127.0.0.1:4817${path}`);
const post = (path: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:4817${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-ui-rules-'));
  await writeFile(
    join(dir, 'plumb.config.json'),
    JSON.stringify({
      service: '.',
      adapter: 'nextjs',
      store: '.plumb-store',
      roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
      stopBlockLimit: 3,
      blocks: { payment: { include: ['src/domains/payment/**'], risk: 'high' } },
    }),
  );
  process.env.PLUMB_TARGET = dir;
  const { config, root } = await loadConfig({ target: dir });
  store = openStore(config, root);
  await store.init();

  routes = {
    list: await import('@/app/api/rules/route'),
    detail: await import('@/app/api/rules/[id]/route'),
    approve: await import('@/app/api/rules/[id]/approve/route'),
    reject: await import('@/app/api/rules/[id]/reject/route'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('규칙 API — 목록 → 제안 → 승인 → 기각 오류 → 404', () => {
  it('비어 있을 때 목록은 빈 배열, 미확인 0건', async () => {
    const res = await routes.list.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RuleListResponse;
    expect(body.rules).toEqual([]);
    expect(body.unconfirmed).toBe(0);
    expect(body.longestPendingDays).toBeUndefined();
    expect(body.queueLimit).toEqual({ exceeded: false, maxUnconfirmed: 20, maxDays: 14 });
  });

  it('제안을 쓰면(코어 API) 목록 1 · provisional · ⚠ · ⚡, 상세는 diff 전부 +', async () => {
    await store.proposals.write(proposalFor(REFUND_RULE));

    const list = (await (await routes.list.GET()).json()) as RuleListResponse;
    expect(list.rules).toHaveLength(1);
    expect(list.rules[0]).toMatchObject({
      id: 'pay.refund-window',
      block: 'payment',
      blockKnown: true,
      kind: 'business',
      statement: REFUND_RULE.statement,
      status: 'unchecked',
      approval: 'provisional',
      highRisk: true,
      pendingProposal: 'p-0001',
    });
    expect(list.unconfirmed).toBe(1);
    expect(list.longestPendingDays).toBeGreaterThanOrEqual(0);

    const res = await routes.detail.GET(get('/api/rules/pay.refund-window'), ctx('pay.refund-window'));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as RuleDetailResponse;
    expect(detail.rule).toBeUndefined(); // 승인 전까지 rules.yaml에 없다
    expect(detail.approval).toBe('provisional');
    expect(detail.proposal?.id).toBe('p-0001');
    expect(detail.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.diff.length).toBeGreaterThan(0);
    expect(detail.diff.every((line) => line.op === '+')).toBe(true);
    expect(detail.approvals).toEqual([]);
    expect(detail.depends).toEqual([{ ruleId: 'pay.payment-record', status: 'unchecked', exists: false }]);
    expect(detail.checks).toEqual([{ check: REFUND_RULE.checks[0], exists: false }]);
    expect(detail.status).toEqual({ status: 'unchecked', reason: 'check-missing' });
    expect(detail.decision).toEqual({ missing: 'D-0001' });
    expect(detail.decisionFile).toMatchObject({ id: 'D-0001', exists: false });
    expect(detail.highRisk).toBe(true);
  });

  it('승인 전: 잘못된 본문 400 · 다른 proposalId 409', async () => {
    const bad = await routes.approve.POST(
      post('/api/rules/pay.refund-window/approve', '{not json'),
      ctx('pay.refund-window'),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiError).code).toBe('invalid-body');

    const stale = await routes.approve.POST(
      post('/api/rules/pay.refund-window/approve', { proposalId: 'p-9999', proposalHash: 'x' }),
      ctx('pay.refund-window'),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ApiError).code).toBe('proposal-changed');

    const changed = await routes.approve.POST(
      post('/api/rules/pay.refund-window/approve', { proposalId: 'p-0001', proposalHash: 'deadbeef' }),
      ctx('pay.refund-window'),
    );
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as ApiError).code).toBe('proposal-changed');
  });

  it('approve 200 → 승인 상태 · rules.yaml에 규칙 · 승인자 ui · 미확인 0', async () => {
    const proposal = await store.proposals.get('pay.refund-window', 'p-0001');
    if (proposal === undefined) throw new Error('unreachable');
    const res = await routes.approve.POST(
      post('/api/rules/pay.refund-window/approve', { proposalId: 'p-0001', proposalHash: hashProposal(proposal) }),
      ctx('pay.refund-window'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApproveResponse;
    expect(body.requiresPriorApproval).toBe(false);
    if (body.requiresPriorApproval) throw new Error('unreachable');
    expect(body.approvalState).toBe('approved');
    expect(body.unconfirmed).toBe(0);
    expect(body.approval).toMatchObject({
      ruleId: 'pay.refund-window',
      proposalId: 'p-0001',
      action: 'approve',
      by: 'ui',
    });

    expect(await store.rules.list()).toEqual([REFUND_RULE]);

    const list = (await (await routes.list.GET()).json()) as RuleListResponse;
    expect(list.rules[0]).toMatchObject({ approval: 'approved', status: 'unchecked' }); // 승인은 상태를 바꾸지 않는다
    expect(list.rules[0]?.pendingProposal).toBeUndefined();
    expect(list.unconfirmed).toBe(0);

    const detail = (await (
      await routes.detail.GET(get('/api/rules/pay.refund-window'), ctx('pay.refund-window'))
    ).json()) as RuleDetailResponse;
    expect(detail.rule).toEqual(REFUND_RULE);
    expect(detail.approval).toBe('approved');
    expect(detail.proposal).toBeUndefined();
    expect(detail.diff).toEqual([]);
    expect(detail.approvals).toHaveLength(1);
    expect((detail.approvals[0] as Approval).action).toBe('approve');

    // 이미 처리된 제안을 다시 승인 → 409 (CLI에서 이미 승인한 경우와 같다)
    const again = await routes.approve.POST(
      post('/api/rules/pay.refund-window/approve', { proposalId: 'p-0001', proposalHash: hashProposal(proposal) }),
      ctx('pay.refund-window'),
    );
    expect(again.status).toBe(409);
  });

  it('plumb check 기록이 있으면 목록 status 🔴 + statusAt, 상세에 failures file:line · 검사 파일별 lastResult · 이력', async () => {
    await store.checks.write({
      runId: 'c-20261002T090005000Z',
      commit: CHECK_COMMIT,
      startedAt: '2026-10-02T09:00:01.000Z',
      finishedAt: CHECKED_AT,
      runner: { exitCode: 1 },
      results: [
        { check: REFUND_CHECK, ruleIds: [REFUND_RULE.id], outcome: 'fail', durationSec: 0.02, failure: REFUND_FAILURE },
      ],
      quarantined: [],
      counts: { junit: 1, static: 0 },
      storeStatus: 'ok',
    });
    await store.ruleStatus.write([
      {
        ruleId: REFUND_RULE.id,
        detail: { status: 'fail', failures: [REFUND_FAILURE] },
        since: CHECKED_AT,
        commit: CHECK_COMMIT,
        checkedAt: CHECKED_AT,
        history: ['unchecked', 'fail'],
      },
    ]);

    const list = (await (await routes.list.GET()).json()) as RuleListResponse;
    expect(list.rules[0]).toMatchObject({
      id: 'pay.refund-window',
      status: 'fail',
      statusAt: { commit: CHECK_COMMIT, checkedAt: CHECKED_AT },
      approval: 'approved', // 검사는 승인 상태를 바꾸지 않는다
    });

    const detail = (await (
      await routes.detail.GET(get('/api/rules/pay.refund-window'), ctx('pay.refund-window'))
    ).json()) as RuleDetailResponse;
    expect(detail.status).toEqual({ status: 'fail', failures: [REFUND_FAILURE] });
    expect(detail.statusAt).toEqual({ commit: CHECK_COMMIT, checkedAt: CHECKED_AT });
    expect(detail.history).toEqual(['unchecked', 'fail']);
    expect(detail.since).toBe(CHECKED_AT);
    expect(detail.checks).toEqual([
      {
        check: REFUND_CHECK,
        exists: false,
        lastResult: {
          outcome: 'fail',
          commit: CHECK_COMMIT,
          finishedAt: CHECKED_AT,
          anchor: { file: 'test/acceptance/refund-window.property.spec.ts', line: 42 },
        },
      },
    ]);
    // 의존 규칙의 상태도 rule-status에서 (기록 없음 → ⬜)
    expect(detail.depends).toEqual([{ ruleId: 'pay.payment-record', status: 'unchecked', exists: false }]);
  });

  it('reject: 사유 없음 400 reason-required, 사유 있으면 200 · 기각 상태 · 기본 목록에서 숨김', async () => {
    const second = await store.proposals.write(
      proposalFor(
        { ...REFUND_RULE, statement: 'WHEN 환불 요청이 결제 후 3일을 초과하면 THE SYSTEM SHALL 요청을 거절한다' },
        { id: 'p-0002', changeKind: 'strengthen', before: REFUND_RULE, proposedAt: '2026-10-02T05:00:00.000Z' },
      ),
    );
    const hash = hashProposal(second);

    for (const reason of [undefined, '', '   ']) {
      const res = await routes.reject.POST(
        post('/api/rules/pay.refund-window/reject', { proposalId: 'p-0002', proposalHash: hash, reason }),
        ctx('pay.refund-window'),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).code).toBe('reason-required');
    }
    expect(await store.approvals.history('pay.refund-window')).toHaveLength(1); // 실패한 기각은 아무것도 남기지 않는다

    const detail = (await (
      await routes.detail.GET(get('/api/rules/pay.refund-window'), ctx('pay.refund-window'))
    ).json()) as RuleDetailResponse;
    expect(detail.approval).toBe('provisional');
    expect(detail.diff.filter((line) => line.op === '-').map((line) => line.field)).toEqual(['statement']);
    expect(detail.diff.filter((line) => line.op === '+').map((line) => line.field)).toEqual(['statement']);

    const ok = await routes.reject.POST(
      post('/api/rules/pay.refund-window/reject', {
        proposalId: 'p-0002',
        proposalHash: hash,
        reason: '3일은 너무 짧다',
      }),
      ctx('pay.refund-window'),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      approvalState: 'rejected',
      unconfirmed: 0,
      approval: { action: 'reject', by: 'ui', reason: '3일은 너무 짧다' },
    });
    expect(await store.rules.list()).toEqual([REFUND_RULE]); // 기각은 rules.yaml을 건드리지 않는다

    const list = (await (await routes.list.GET()).json()) as RuleListResponse;
    expect(list.rules[0]?.approval).toBe('rejected');
  });

  it('없는 규칙 404 rule-not-found (GET · approve · reject · 형식이 아닌 id)', async () => {
    const missing = await routes.detail.GET(get('/api/rules/no.such-rule'), ctx('no.such-rule'));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).code).toBe('rule-not-found');

    const approve = await routes.approve.POST(
      post('/api/rules/no.such-rule/approve', { proposalId: 'p-0001', proposalHash: 'x' }),
      ctx('no.such-rule'),
    );
    expect(approve.status).toBe(404);

    const reject = await routes.reject.POST(
      post('/api/rules/no.such-rule/reject', { proposalId: 'p-0001', proposalHash: 'x', reason: '없는 규칙' }),
      ctx('no.such-rule'),
    );
    expect(reject.status).toBe(404);

    const malformed = await routes.detail.GET(get('/api/rules/..%2Fetc'), ctx('../etc'));
    expect(malformed.status).toBe(404);
  });
});
