/**
 * 이슈 #89 "완료 증거": 임시 저장소를 `PLUMB_TARGET`으로 두고 route handler 함수를 직접 부른다.
 * 401(미들웨어) → 목록 빈 배열 → `POST /api/runs` 본문 오류 400 → 전제조건 실패는 **진짜 CLI**(`plumb run --detach --json`)가 돌려주는
 * `{ error }`로 400 `no-budget` · 404 `rule-not-found` · 400 `rule-not-approved` · 409 `run-in-progress` → spawn 가짜로 201 `{ id }` · 500
 * `spawn-failed` → `GET /api/runs/:id` 404 · 200 · 503(찢긴 JSON — 목록도 503) → abort 400 · 404 · 409 `run-finished` · 202(SIGTERM).
 * 파이프라인 자체(Agent SDK)는 돌리지 않는다 — 201 경로만 자식을 가짜로 둔다.
 */

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AbortRunResponse,
  type ApiError,
  type CreateRunResponse,
  hashProposal,
  loadConfig,
  openStore,
  type Proposal,
  type Rule,
  type RunId,
  type RunListResponse,
  type RunState,
  type Store,
  serializeRulesDocument,
} from '@plumb/core';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COOKIE } from '@/lib/auth';
import { middleware } from '@/middleware';

/** `plumb run --detach`를 띄우는 spawn만 — 그리고 테스트가 `fake.next`를 둔 동안만 — 가짜로. 그 밖(진짜 CLI 전제조건 검사)은 진짜 */
const fake = vi.hoisted(() => ({
  next: null as null | (() => FakeChild),
  calls: [] as string[][],
}));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: unknown) => {
      if (Array.isArray(args) && args.includes('run') && args.includes('--detach') && fake.next !== null) {
        fake.calls.push(args);
        return fake.next();
      }
      return actual.spawn(command, args, options as never);
    },
  };
});

function fakeChild(script: (child: FakeChild) => void): () => FakeChild {
  return () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setTimeout(() => script(child), 5);
    return child;
  };
}

const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};

const PROPOSAL: Proposal = {
  id: 'p-0001',
  ruleId: REFUND_RULE.id,
  changeKind: 'add',
  proposedBy: 'cli',
  proposedAt: '2026-10-01T05:00:00.000Z',
  after: REFUND_RULE,
  requiresPriorApproval: false,
  applied: 'provisional',
};

const ROLE = { model: 'test-model', maxTurns: 40, maxBudgetUsd: 10 };
const BASE_CONFIG = {
  service: '.',
  adapter: 'nextjs',
  store: '.plumb-store',
  roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
  stopBlockLimit: 5,
  blocks: { payment: { include: ['src/domains/payment/**'], risk: 'high' } },
};

/** `plumb run`이 남기는 모양의 상태 파일 (`RunState`). 단계 ③ 진행 중 */
function runState(id: RunId, overrides: Partial<RunState> = {}): RunState {
  const usage = { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null };
  return {
    id,
    pid: 4812,
    status: 'running',
    stage: 3,
    stages: [
      {
        stage: 1,
        attempt: 1,
        role: null,
        startedAt: '2026-10-02T05:01:00.000Z',
        finishedAt: '2026-10-02T05:01:00.100Z',
      },
      {
        stage: 2,
        attempt: 1,
        role: 'test-writer',
        startedAt: '2026-10-02T05:03:00.000Z',
        finishedAt: '2026-10-02T05:07:00.000Z',
      },
      { stage: 3, attempt: 1, role: 'implementer', startedAt: '2026-10-02T05:07:00.000Z' },
    ],
    currentRole: 'implementer',
    ruleIds: [REFUND_RULE.id],
    roles: {
      'test-writer': { ...usage, turns: 5 },
      implementer: { ...usage, turns: 7 },
      injector: usage,
      'rule-drafter': usage,
    },
    costUsd: 3.2,
    limits: { maxBudgetUsd: 10, stopBlockLimit: 5, maxTurns: { 'test-writer': 40, implementer: 40 } },
    disputes: [],
    startedAt: '2026-10-02T05:01:00.000Z',
    updatedAt: '2026-10-02T05:15:00.000Z',
    ...overrides,
  };
}

let dir: string;
let store: Store;
let routes: {
  runs: typeof import('@/app/api/runs/route');
  detail: typeof import('@/app/api/runs/[id]/route');
  abort: typeof import('@/app/api/runs/[id]/abort/route');
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new NextRequest(`http://127.0.0.1:4817${path}`);
const post = (path: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:4817${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, 'plumb.config.json'), JSON.stringify({ ...BASE_CONFIG, ...extra }));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-ui-runs-'));
  await writeConfig({}); // 처음엔 run.maxBudgetUsd 없음 → no-budget
  process.env.PLUMB_TARGET = dir;
  const { config, root } = await loadConfig({ target: dir });
  store = openStore(config, root);
  await store.init();

  routes = {
    runs: await import('@/app/api/runs/route'),
    detail: await import('@/app/api/runs/[id]/route'),
    abort: await import('@/app/api/runs/[id]/abort/route'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  fake.next = null;
  vi.restoreAllMocks();
});

describe('토큰 쿠키 없음 → 401 (미들웨어)', () => {
  it('GET /api/runs · POST /api/runs · POST abort 전부 401 UNAUTHORIZED', async () => {
    process.env.PLUMB_UI_TOKEN = 'a'.repeat(64);
    try {
      for (const req of [
        get('/api/runs'),
        post('/api/runs', { ruleIds: [REFUND_RULE.id] }),
        post('/api/runs/r-0001/abort', { confirm: true }),
      ]) {
        const res = await middleware(req);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      }
      // 틀린 쿠키도 401
      const wrong = new NextRequest('http://127.0.0.1:4817/api/runs', {
        headers: { cookie: `${COOKIE}=${'b'.repeat(64)}` },
      });
      expect((await middleware(wrong)).status).toBe(401);
    } finally {
      delete process.env.PLUMB_UI_TOKEN;
    }
  });
});

describe('GET /api/runs · POST /api/runs', () => {
  it('runs/ 비어 있으면 { runs: [] }', async () => {
    const res = await routes.runs.GET();
    expect(res.status).toBe(200);
    expect((await res.json()) as RunListResponse).toEqual({ runs: [] });
  });

  it('본문 오류 → 400 invalid-body, spawn 없음', async () => {
    for (const body of ['{not json', {}, { ruleIds: [] }, { ruleIds: ['../etc'] }, { ruleIds: [1] }]) {
      const res = await routes.runs.POST(post('/api/runs', body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).code).toBe('invalid-body');
    }
    expect(fake.calls).toEqual([]);
  });

  it('plumb.config.json에 run.maxBudgetUsd 없음 → 400 no-budget (진짜 CLI가 판정)', async () => {
    const res = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400, code: 'no-budget' });
    expect(((await (await routes.runs.GET()).json()) as RunListResponse).runs).toEqual([]); // 항목이 생기지 않는다
  }, 20_000);

  it('규칙 없음 → 404 rule-not-found, 승인 안 됨 → 400 rule-not-approved + ruleIds (진짜 CLI)', async () => {
    await writeConfig({ run: { maxBudgetUsd: 10 } });

    const missing = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: 404, code: 'rule-not-found' });

    await store.proposals.write(PROPOSAL); // 제안만 — 승인 전까지 rules.yaml에 없다
    const stillMissing = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(stillMissing.status).toBe(404);

    // 승인 → rules.yaml에 들어간다. 그 뒤 승인 기록이 없는 다른 규칙을 손으로 적는 대신, 승인된 규칙으로 201 경로를 본다
    const proposal = await store.proposals.get(REFUND_RULE.id, 'p-0001');
    if (proposal === undefined) throw new Error('unreachable');
    await store.approvals.approve({
      ruleId: REFUND_RULE.id,
      proposalId: 'p-0001',
      by: 'ui',
      expectedProposalHash: hashProposal(proposal),
    });
    expect(await store.rules.list()).toEqual([REFUND_RULE]);
  }, 30_000);

  it('rules.yaml에 손으로 적은 규칙(승인 기록 없음) → 400 rule-not-approved + ruleIds (진짜 CLI)', async () => {
    // 승인 행위가 없었으므로 미승인 — 코어 직렬화로 두 번째 규칙을 rules.yaml에 적는다
    const { decision: _decision, ...handWritten } = { ...REFUND_RULE, id: 'pay.payment-record' as const };
    await writeFile(store.paths.rules, serializeRulesDocument([REFUND_RULE, handWritten as Rule]));
    const res = await routes.runs.POST(post('/api/runs', { ruleIds: ['pay.payment-record'] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      status: 400,
      code: 'rule-not-approved',
      ruleIds: ['pay.payment-record'],
    });
  }, 20_000);

  it('승인된 규칙 → spawn `plumb run --target … run --rules <id> --detach --json` → 201 { id }', async () => {
    fake.next = fakeChild((child) => {
      child.stdout.emit(
        'data',
        `${JSON.stringify({ id: 'r-0001', pid: 4242, log: '/x/runs/r-0001/run.log' }, null, 2)}\n`,
      );
      child.emit('exit', 0);
    });
    const res = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(res.status).toBe(201);
    expect((await res.json()) as CreateRunResponse).toEqual({ id: 'r-0001' });

    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0] ?? [];
    expect(args[0]).toMatch(/[\\/]cli[\\/]index\.js$/);
    expect(args.slice(1)).toEqual(['--target', dir, 'run', '--rules', REFUND_RULE.id, '--detach', '--json']);
  });

  it('진행 중인 실행이 있으면 → 409 run-in-progress + runId (진짜 CLI가 runs/*.json으로 판정)', async () => {
    await store.runs.write(runState('r-0001'));
    const res = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 409, code: 'run-in-progress', runId: 'r-0001' });
    expect(fake.calls).toHaveLength(1); // 가짜는 더 불리지 않았다
  }, 20_000);

  it('프로세스를 못 띄우면(ENOENT) · 출력이 JSON이 아니면 → 500 spawn-failed, 항목 없음', async () => {
    const before = ((await (await routes.runs.GET()).json()) as RunListResponse).runs.length;

    fake.next = fakeChild((child) =>
      child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })),
    );
    const enoent = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(enoent.status).toBe(500);
    expect(await enoent.json()).toMatchObject({ status: 500, code: 'spawn-failed' });
    expect(((await enoent.json().catch(() => null)) ?? { message: '' }).message ?? '').toBeDefined();

    fake.next = fakeChild((child) => {
      child.stderr.emit('data', 'plumb: 설정 오류\n');
      child.stdout.emit('data', 'not json');
      child.emit('exit', 1);
    });
    const garbage = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(garbage.status).toBe(500);
    const body = (await garbage.json()) as ApiError;
    expect(body.code).toBe('spawn-failed');
    expect(body.message).toContain('JSON이 아니다');
    expect(body.message).toContain('plumb: 설정 오류');

    expect(((await (await routes.runs.GET()).json()) as RunListResponse).runs).toHaveLength(before);
  });
});

describe('GET /api/runs/:id', () => {
  it('ID 꼴이 아니거나 파일 없음 → 404 run-not-found', async () => {
    for (const id of ['r-9999', 'nope', '../etc']) {
      const res = await routes.detail.GET(get(`/api/runs/${encodeURIComponent(id)}`), ctx(id));
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiError).code).toBe('run-not-found');
    }
  });

  it('상태 파일 그대로 200 — 단계 · 역할 사용량 · 비용 · limits', async () => {
    const res = await routes.detail.GET(get('/api/runs/r-0001'), ctx('r-0001'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunState;
    expect(body).toEqual(runState('r-0001'));
    expect(body.capturedOutput).toBeUndefined(); // "아직 실행 출력 없음"
  });

  it('목록은 RunSummary(최근 순)', async () => {
    const list = (await (await routes.runs.GET()).json()) as RunListResponse;
    expect(list.runs).toEqual([
      { id: 'r-0001', status: 'running', stage: 3, startedAt: '2026-10-02T05:01:00.000Z', ruleIds: [REFUND_RULE.id] },
    ]);
  });

  it('쓰는 도중 읽어 JSON이 찢겼으면 → 503 run-state-unreadable + Retry-After (화면은 직전 응답 유지)', async () => {
    await mkdir(store.paths.runsDir, { recursive: true });
    await writeFile(store.paths.run('r-0002' as RunId), '{"id":"r-0002","status":"runn');
    const res = await routes.detail.GET(get('/api/runs/r-0002'), ctx('r-0002'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toMatchObject({ status: 503, code: 'run-state-unreadable', retryAfterMs: 1500 });

    // 목록도 503 — 코어 `listRuns`는 모양 오류만 건너뛰고 찢긴 JSON은 올린다 (코어 후속). 화면은 직전 목록을 유지한다
    const torn = await routes.runs.GET();
    expect(torn.status).toBe(503);
    expect(((await torn.json()) as ApiError).code).toBe('run-state-unreadable');
    await rm(store.paths.run('r-0002' as RunId));
    const list = (await (await routes.runs.GET()).json()) as RunListResponse;
    expect(list.runs.map((r) => r.id)).toEqual(['r-0001']);
  });
});

describe('POST /api/runs/:id/abort', () => {
  it('confirm 없음 → 400, 없는 실행 → 404', async () => {
    const bad = await routes.abort.POST(post('/api/runs/r-0001/abort', { confirm: false }), ctx('r-0001'));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiError).code).toBe('invalid-body');

    const notJson = await routes.abort.POST(post('/api/runs/r-0001/abort', '{'), ctx('r-0001'));
    expect(notJson.status).toBe(400);

    const missing = await routes.abort.POST(post('/api/runs/r-9999/abort', { confirm: true }), ctx('r-9999'));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).code).toBe('run-not-found');
  });

  it('진행 중 → process.kill(pid, SIGTERM) → 202 { id, requested, signal }', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const res = await routes.abort.POST(post('/api/runs/r-0001/abort', { confirm: true }), ctx('r-0001'));
    expect(res.status).toBe(202);
    expect((await res.json()) as AbortRunResponse).toEqual({ id: 'r-0001', requested: true, signal: 'SIGTERM' });
    expect(kill).toHaveBeenCalledWith(4812, 'SIGTERM');
    // 파일은 그대로 running — 실제 종료는 plumb run이 쓴다 (폴링으로 확인)
    expect((await store.runs.get('r-0001' as RunId))?.status).toBe('running');
  });

  it('pid가 이미 사라졌어도(ESRCH) 202 — 파일이 진실', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const res = await routes.abort.POST(post('/api/runs/r-0001/abort', { confirm: true }), ctx('r-0001'));
    expect(res.status).toBe(202);
  });

  it('끝난 실행 → 409 run-finished, kill 없음', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await store.runs.write(
      runState('r-0001', {
        status: 'completed',
        stage: 4,
        currentRole: null,
        finishedAt: '2026-10-02T05:31:00.000Z',
        outcome: { status: 'completed', finishedAt: '2026-10-02T05:31:00.000Z' },
      }),
    );
    const res = await routes.abort.POST(post('/api/runs/r-0001/abort', { confirm: true }), ctx('r-0001'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 409, code: 'run-finished' });
    expect(kill).not.toHaveBeenCalled();

    // 끝났으니 새 실행이 가능해졌다 (409 run-in-progress가 아니다) — 가짜 자식으로 확인
    fake.next = fakeChild((child) => {
      child.stdout.emit('data', JSON.stringify({ id: 'r-0002', pid: 1 }));
      child.emit('exit', 0);
    });
    const again = await routes.runs.POST(post('/api/runs', { ruleIds: [REFUND_RULE.id] }));
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ id: 'r-0002' });
  });
});
