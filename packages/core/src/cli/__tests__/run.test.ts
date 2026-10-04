/**
 * `plumb run` · `plumb runs` (이슈 #87) — 파이프라인 · spawn · kill을 가짜로 주입하고 인자 검증 · 전제조건 · detach · 목록/상세/중단을 확인한다.
 * 실제 SDK 실행은 env/local(PR 검증 증거).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineDeps, PipelineResult } from '../../run/pipeline.js';
import { newRunState } from '../../run/state.js';
import { openStore } from '../../store/index.js';
import type { Proposal, Rule, RunState } from '../../types/index.js';
import { EXIT_RUN_CONFLICT, runShowText, runsListText, type SpawnDetachedInput } from '../commands/run.js';
import { createProgram } from '../program.js';

const RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};
const CONFIG = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs',
  roles: {
    'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  run: { maxBudgetUsd: 3 },
};
const PROPOSAL: Proposal = {
  id: 'p-0001',
  ruleId: RULE.id,
  changeKind: 'add',
  proposedBy: 'cli',
  proposedAt: '2026-10-03T00:00:00.000Z',
  after: RULE,
  requiresPriorApproval: false,
  applied: 'provisional',
};

let dir: string;
let clock: Date;
const now = () => {
  clock = new Date(clock.getTime() + 1000);
  return clock;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-run-cli-'));
  clock = new Date('2026-10-03T09:00:00.000Z');
  await writeFile(join(dir, 'plumb.config.json'), JSON.stringify(CONFIG));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function approve(): Promise<void> {
  const store = openStore(CONFIG, dir);
  await store.init();
  await store.proposals.write(PROPOSAL);
  await store.approvals.approve({ ruleId: RULE.id, proposalId: PROPOSAL.id, by: 'test' });
}

interface Harness {
  out: string[];
  err: string[];
  exits: number[];
  spawns: SpawnDetachedInput[];
  kills: Array<[number, string]>;
  pipelineCalls: PipelineDeps[];
  run(args: string[]): Promise<void>;
}

function harness(pipeline?: (deps: PipelineDeps) => Promise<PipelineResult>): Harness {
  const h: Harness = { out: [], err: [], exits: [], spawns: [], kills: [], pipelineCalls: [], run: async () => {} };
  const program = createProgram({
    stdout: {
      write: (s: string) => {
        h.out.push(s);
        return true;
      },
    },
    stderr: {
      write: (s: string) => {
        h.err.push(s);
        return true;
      },
    },
    exit: (code) => void h.exits.push(code),
    cwd: dir,
    now,
    loadAdapter: async () => ({ adapter: {} as never, staticRunner: undefined }) as never,
    runPipeline: async (deps) => {
      h.pipelineCalls.push(deps);
      if (pipeline) return pipeline(deps);
      const state = newRunState({ id: deps.runId ?? 'r-0001', ruleIds: deps.ruleIds, config: deps.config, now });
      const done: RunState = {
        ...state,
        status: 'completed',
        stage: 4,
        finishedAt: now().toISOString(),
        outcome: { status: 'completed', finishedAt: clock.toISOString() },
      };
      await deps.store.runs.write(done);
      return { state: done };
    },
    spawnDetached: (input) => {
      h.spawns.push(input);
      return 4242;
    },
    kill: (pid, signal) => void h.kills.push([pid, signal]),
    self: { execPath: '/usr/bin/node', entry: '/plumb/dist/cli/index.js', pid: 1 },
  });
  program.exitOverride();
  h.run = async (args) => {
    await program.parseAsync(['--target', dir, ...args], { from: 'user' });
  };
  return h;
}

describe('plumb run — 전제조건', () => {
  it('미승인 규칙 → exit 2 (rule-not-found / rule-not-approved), 파이프라인은 부르지 않는다', async () => {
    const h = harness();
    await h.run(['run', '--rules', RULE.id]);
    expect(h.exits).toEqual([2]);
    expect(h.err.join('')).toMatch(/rule-not-found/);
    expect(h.pipelineCalls).toHaveLength(0);
  });

  it('진행 중 실행이 있으면 exit 3 (run-in-progress)', async () => {
    await approve();
    const store = openStore(CONFIG, dir);
    await store.runs.write(newRunState({ id: 'r-0001', ruleIds: [RULE.id], config: CONFIG as never, now }));
    const h = harness();
    await h.run(['run', '--rules', RULE.id]);
    expect(h.exits).toEqual([EXIT_RUN_CONFLICT]);
    expect(h.err.join('')).toMatch(/r-0001.*run-in-progress/);
  });

  it('--json이면 오류도 JSON', async () => {
    const h = harness();
    await h.run(['run', '--rules', RULE.id, '--json']);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ error: 'rule-not-found' });
  });
});

describe('plumb run — 실행', () => {
  it('전경 실행: 파이프라인을 부르고 결과 한 줄, exit 없음(성공)', async () => {
    await approve();
    const h = harness();
    await h.run(['run', '--rules', RULE.id]);
    expect(h.exits).toEqual([]);
    expect(h.pipelineCalls).toHaveLength(1);
    expect(h.pipelineCalls[0]?.ruleIds).toEqual([RULE.id]);
    expect(h.out.join('')).toMatch(/r-0001 completed stage 4/);
  });

  it('실패로 끝나면 exit 1', async () => {
    await approve();
    const h = harness(async (deps) => {
      const state = newRunState({ id: 'r-0001', ruleIds: deps.ruleIds, config: deps.config, now });
      return {
        state: {
          ...state,
          status: 'failed',
          outcome: {
            status: 'failed',
            finishedAt: 't',
            reason: 'maxTurns',
            role: 'implementer',
            queueItemId: 'q-0001',
          },
        },
      };
    });
    await h.run(['run', '--rules', RULE.id]);
    expect(h.exits).toEqual([1]);
    expect(h.out.join('')).toMatch(/failed stage 1 \(maxTurns\)/);
  });

  it('--detach: 자기 자신을 --child <id>로 띄우고 {"id","pid"}만 출력, 파이프라인은 부르지 않는다', async () => {
    await approve();
    const h = harness();
    await h.run(['run', '--rules', RULE.id, '--detach']);
    expect(h.exits).toEqual([]);
    expect(h.pipelineCalls).toHaveLength(0);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]).toMatchObject({ node: '/usr/bin/node', entry: '/plumb/dist/cli/index.js' });
    expect(h.spawns[0]?.args).toEqual(['--target', dir, 'run', '--rules', RULE.id, '--child', 'r-0001']);
    expect(JSON.parse(h.out.join(''))).toEqual({ id: 'r-0001', pid: 4242 });
    // 부모가 초기 상태를 먼저 써 둔다 — 바로 `runs show`가 된다
    const store = openStore(CONFIG, dir);
    expect(await store.runs.get('r-0001')).toMatchObject({
      id: 'r-0001',
      pid: 4242,
      status: 'running',
      stage: 1,
      ruleIds: [RULE.id],
    });
    expect((await store.runs.active())?.id).toBe('r-0001');
  });

  it('--child <id>: 그 id로 파이프라인을 돌리고 로그는 runs/<id>/run.log에, stdout은 비어 있다', async () => {
    await approve();
    const h = harness();
    await h.run(['run', '--rules', RULE.id, '--child', 'r-0007']);
    expect(h.exits).toEqual([]);
    expect(h.pipelineCalls[0]?.runId).toBe('r-0007');
    expect(h.out).toEqual([]);
    const { readFile } = await import('node:fs/promises');
    const log = await readFile(join(dir, '.plumb-store', 'runs', 'r-0007', 'run.log'), 'utf8');
    expect(log).toMatch(/\[run\] r-0007 completed/);
  });
});

describe('plumb runs', () => {
  it('list: 비어 있으면 안내, 있으면 표(최근 순) · --json', async () => {
    const h = harness();
    await h.run(['runs', 'list']);
    expect(h.out.join('')).toMatch(/실행 기록 없음/);
    const store = openStore(CONFIG, dir);
    await store.init();
    const a = newRunState({ id: 'r-0001', ruleIds: [RULE.id], config: CONFIG as never, now });
    await store.runs.write({ ...a, status: 'completed', finishedAt: now().toISOString() });
    await store.runs.write(newRunState({ id: 'r-0002', ruleIds: [RULE.id], config: CONFIG as never, now }));
    const h2 = harness();
    await h2.run(['runs', 'list']);
    const text = h2.out.join('');
    expect(text.indexOf('r-0002')).toBeLessThan(text.indexOf('r-0001'));
    expect(text).toMatch(/진행중/);
    expect(text).toMatch(/완료/);
    const h3 = harness();
    await h3.run(['runs', 'list', '--json']);
    expect(JSON.parse(h3.out.join('')).runs.map((r: { id: string }) => r.id)).toEqual(['r-0002', 'r-0001']);
  });

  it('show: 단계 · 역할 사용량 · 마지막 출력, 없으면 exit 2', async () => {
    const store = openStore(CONFIG, dir);
    await store.init();
    const s = newRunState({ id: 'r-0001', ruleIds: [RULE.id], config: CONFIG as never, now });
    await store.runs.write({
      ...s,
      stage: 3,
      stages: [
        {
          stage: 2,
          attempt: 1,
          role: 'test-writer',
          startedAt: 't',
          finishedAt: 't',
          result: { stage: 2, tests: { total: 3, passed: 0, failed: 3 }, allFailed: true },
        },
      ],
      roles: { ...s.roles, 'test-writer': { turns: 13, stopBlocks: 1, consecutiveStopBlocks: 0, costUsd: 0.09 } },
      costUsd: 0.09,
      capturedOutput: {
        command: 'vitest run',
        startedAt: 't',
        finishedAt: 't',
        exitCode: 1,
        tail: ['Tests 3 failed (3)'],
        logPath: '/x',
      },
    });
    const h = harness();
    await h.run(['runs', 'show', 'r-0001']);
    const text = h.out.join('');
    expect(text).toMatch(/r-0001 · 진행중 · 단계 3/);
    expect(text).toMatch(/✔ 2 test-writer/);
    expect(text).toMatch(/test-writer: 턴 13 \/ 60 · 종료 차단 1/);
    expect(text).toMatch(/│ Tests 3 failed/);
    const h2 = harness();
    await h2.run(['runs', 'show', 'r-0009']);
    expect(h2.exits).toEqual([2]);
    expect(h2.err.join('')).toMatch(/run-not-found/);
  });

  it('abort: 진행 중이면 pid에 SIGTERM, 끝났으면 exit 3 (run-finished), 없으면 exit 2', async () => {
    const store = openStore(CONFIG, dir);
    await store.init();
    await store.runs.write({
      ...newRunState({ id: 'r-0001', ruleIds: [RULE.id], config: CONFIG as never, pid: 777, now }),
    });
    const h = harness();
    await h.run(['runs', 'abort', 'r-0001', '--json']);
    expect(h.kills).toEqual([[777, 'SIGTERM']]);
    expect(JSON.parse(h.out.join(''))).toEqual({ id: 'r-0001', requested: true, signal: 'SIGTERM' });
    const s2 = newRunState({ id: 'r-0002', ruleIds: [RULE.id], config: CONFIG as never, now });
    await store.runs.write({ ...s2, status: 'aborted', finishedAt: 't' });
    const h2 = harness();
    await h2.run(['runs', 'abort', 'r-0002']);
    expect(h2.exits).toEqual([EXIT_RUN_CONFLICT]);
    expect(h2.err.join('')).toMatch(/run-finished/);
    const h3 = harness();
    await h3.run(['runs', 'abort', 'r-0003']);
    expect(h3.exits).toEqual([2]);
  });

  it('텍스트 렌더러 단독', () => {
    expect(runsListText([])).toMatch(/실행 기록 없음/);
    const s = newRunState({ id: 'r-0001', ruleIds: [RULE.id], config: CONFIG as never, now });
    expect(runShowText(s)).toMatch(/마지막 출력: 아직 실행 출력 없음/);
  });
});
