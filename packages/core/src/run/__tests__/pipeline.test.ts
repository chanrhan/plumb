import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, TestRunResult } from '../../adapter/types.js';
import type { RunCheckResult } from '../../checks/run-check.js';
import type { RoleRunResult, RunRoleInput } from '../../harness/run-role.js';
import { openStore, type Store } from '../../store/index.js';
import type { Rule } from '../../types/index.js';
import type { ViewGenerationResult } from '../../views/generate.js';
import type { InjectOnceDeps, InjectOnceResult } from '../inject.js';
import { checkPreconditions, RunPreconditionError, runPipeline } from '../pipeline.js';

const RULE: Rule = {
  id: 'pay.refund-window',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};
const config = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs' as const,
  roles: {
    'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  run: { maxBudgetUsd: 1 },
};

function junit(failed: number, passed: number, file = RULE.checks[0]?.ref ?? ''): string {
  const cases = [
    ...Array.from(
      { length: failed },
      (_, i) => `<testcase classname="${file}" name="f${i}" time="0"><failure message="x">x</failure></testcase>`,
    ),
    ...Array.from({ length: passed }, (_, i) => `<testcase classname="${file}" name="p${i}" time="0"/>`),
  ].join('');
  return `<?xml version="1.0"?><testsuites><testsuite name="${file}" file="${file}" tests="${failed + passed}" failures="${failed}">${cases}</testsuite></testsuites>`;
}

/** 어댑터 가짜: 호출 순서대로 미리 정한 결과(실패/통과 수)를 JUnit으로 써 준다 */
function fakeAdapter(dir: string, script: Array<[failed: number, passed: number]>) {
  let n = 0;
  const calls: string[][] = [];
  const adapter = {
    runTests: async (_ctx: unknown, opts: { scope?: string[] }): Promise<TestRunResult> => {
      calls.push(opts.scope ?? []);
      const [f, p] = script[Math.min(n++, script.length - 1)] ?? [0, 0];
      const junitPath = join(dir, `junit-${n}.xml`);
      await writeFile(junitPath, junit(f, p));
      return {
        junitPath,
        exitCode: f > 0 ? 1 : 0,
        output: {
          command: 'vitest run',
          startedAt: 't',
          finishedAt: 't',
          exitCode: f > 0 ? 1 : 0,
          tail: [`${f} failed`],
          logPath: '',
        },
        tool: { name: 'vitest', version: '3' },
      };
    },
  } as unknown as Adapter;
  return { adapter, calls };
}

const okRole = (turns = 2, costUsd = 0.1): RoleRunResult =>
  ({
    outcome: 'success',
    ok: true,
    turns,
    costUsd,
    permissionDenials: 0,
    durationMs: 1,
    init: undefined,
    leak: undefined,
    result: undefined,
    answer: '',
    error: undefined,
  }) as RoleRunResult;

describe('runPipeline (SDK · 검사는 가짜)', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-pipe-'));
    store = openStore(config, dir);
    await store.init();
    await writeFile(join(dir, 'package.json'), '{}');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function approveRule() {
    const p = await store.proposals.write({
      id: 'p-0001',
      ruleId: RULE.id,
      changeKind: 'add',
      proposedBy: 'cli',
      proposedAt: '2026-10-03T00:00:00.000Z',
      after: RULE,
      requiresPriorApproval: false,
      applied: 'provisional',
    });
    await store.approvals.approve({ ruleId: RULE.id, proposalId: p.id, by: 'test' });
  }

  /** ⑤ 가짜: 기본은 잡힘(valid). script로 라운드별 결과를 준다 */
  function fakeInject(script: Array<{ valid: boolean; verdict?: 'weak-check' | 'undetermined' }> = [{ valid: true }]) {
    let n = 0;
    const calls: InjectOnceDeps[] = [];
    const injectOnce = async (deps: InjectOnceDeps): Promise<InjectOnceResult> => {
      calls.push(deps);
      const step = script[Math.min(n++, script.length - 1)] ?? { valid: true };
      const base = {
        id: `i-000${n}` as const,
        ruleId: deps.rule.id,
        description: '7일 검사 제거',
        commit: 'abc',
        at: 't',
        checkFileHashes: {},
      };
      const validity = step.valid
        ? { ...base, result: 'check-failed' as const, valid: true as const }
        : {
            ...base,
            result: 'check-passed' as const,
            valid: false as const,
            ...(step.verdict
              ? {
                  diffSearch: {
                    runId: deps.runId ?? 'r-0000',
                    inputs: 100,
                    differingOutputs: step.verdict === 'weak-check' ? 3 : 0,
                    verdict: step.verdict,
                  },
                }
              : {}),
          };
      return { validity, role: { turns: 2, costUsd: 0.05, outcome: 'success' }, changedFiles: ['src/x.ts'] };
    };
    return { injectOnce, calls };
  }
  const fakeViews = async (): Promise<ViewGenerationResult[]> => [
    {
      name: 'verification',
      ok: true,
      generatedAt: 't',
      sources: 1,
      files: { json: 'a', md: 'b' },
    } as ViewGenerationResult,
    { name: 'flow', skipped: 'not-implemented' } as ViewGenerationResult,
  ];

  const fakeCheck = async (): Promise<RunCheckResult> =>
    ({
      run: { runId: 'c-0001' },
      statuses: [{ ruleId: RULE.id, detail: { status: 'pass-unverified' } }],
      runnerFailed: false,
    }) as unknown as RunCheckResult;

  it('①: 승인 없음 · 예산 없음 · 진행 중 실행이 있으면 RunPreconditionError', async () => {
    await expect(checkPreconditions({ config, store, ruleIds: [RULE.id] })).rejects.toMatchObject({
      code: 'rule-not-found',
    });
    await approveRule();
    await expect(
      checkPreconditions({ config: { ...config, run: undefined }, store, ruleIds: [RULE.id] }),
    ).rejects.toMatchObject({ code: 'no-budget' });
    expect(await checkPreconditions({ config, store, ruleIds: [RULE.id] })).toHaveLength(1);
    const { adapter } = fakeAdapter(dir, [[1, 0]]);
    // 진행 중 실행 하나를 심는다
    const { runPipeline: rp } = await import('../pipeline.js');
    void rp;
    await store.runs.write({
      ...(await (await import('../state.js')).newRunState({ id: 'r-0001', ruleIds: [RULE.id], config })),
      status: 'running',
    });
    await expect(checkPreconditions({ config, store, ruleIds: [RULE.id] })).rejects.toBeInstanceOf(
      RunPreconditionError,
    );
    // 같은 id면 `--detach` 부모의 선기록 = 자기 자신 — 통과 (#115). 다른 id는 여전히 막힌다
    expect(await checkPreconditions({ config, store, ruleIds: [RULE.id], runId: 'r-0001' })).toHaveLength(1);
    await expect(checkPreconditions({ config, store, ruleIds: [RULE.id], runId: 'r-0002' })).rejects.toMatchObject({
      code: 'run-in-progress',
    });
    void adapter;
  });

  it('정상 경로: ② 전부 실패 ✔ → ③ 전부 통과 ✔ → ④ check → completed, 역할 사용량·비용 누적, 파일이 저장소에', async () => {
    await approveRule();
    // 호출 순서: ② 증거(최종) → ③ 증거(최종). Stop hook의 collect는 가짜 runRole이 부르지 않는다
    const { adapter, calls } = fakeAdapter(dir, [
      [1, 0],
      [0, 1],
    ]);
    const roles: string[] = [];
    const runRole = async (input: RunRoleInput): Promise<RoleRunResult> => {
      roles.push(input.options.model ?? '?');
      return okRole(3, 0.2);
    };
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole,
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(state.status).toBe('completed');
    expect(state.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.stages[4]?.result).toMatchObject({ stage: 5, injections: 1, caught: 1, weak: false });
    expect(state.stages[5]?.result).toMatchObject({ stage: 6, viewsUpdated: 1, queued: 0 });
    expect(state.roles.injector.turns).toBe(2);
    expect(state.stages[1]?.result).toMatchObject({ stage: 2, allFailed: true, tests: { total: 1, failed: 1 } });
    expect(state.stages[2]?.result).toMatchObject({ stage: 3, allPassed: true });
    expect(state.stages[3]?.result).toMatchObject({
      stage: 4,
      checkRunId: 'c-0001',
      byRule: { [RULE.id]: 'pass-unverified' },
    });
    expect(state.roles['test-writer'].turns).toBe(3);
    expect(state.costUsd).toBeCloseTo(0.45);
    expect(roles).toHaveLength(2);
    expect(calls.every((c) => c[0] === RULE.checks[0]?.ref)).toBe(true);
    expect((await store.runs.get(state.id))?.status).toBe('completed');
    expect(state.capturedOutput?.tail).toEqual(['0 failed']);
  });

  it('②에서 하나라도 통과하면 stage-2-not-all-failed로 실패 + 검토 대기열', async () => {
    await approveRule();
    const { adapter } = fakeAdapter(dir, [[1, 1]]);
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => okRole(),
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(state.outcome).toMatchObject({ status: 'failed', reason: 'stage-2-not-all-failed', role: 'test-writer' });
    expect(state.stages.map((s) => s.stage)).toEqual([1, 2]);
    expect((await store.reviewQueue.list())[0]).toMatchObject({ kind: 'run-failed', runId: state.id });
  });

  it('역할이 maxTurns · 예산 · 격리 누수로 끝나면 그대로 실패/예산 초과', async () => {
    await approveRule();
    const { adapter } = fakeAdapter(dir, [[1, 0]]);
    const bad = (outcome: RoleRunResult['outcome']): RoleRunResult => ({
      ...okRole(),
      outcome,
      ok: false,
      leak: outcome === 'isolation-leak' ? ({ reasons: ['MCP 도구 3개'] } as never) : undefined,
    });
    let r = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => bad('error_max_turns'),
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(r.state.outcome).toMatchObject({ status: 'failed', reason: 'maxTurns', role: 'test-writer' });
    r = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => bad('error_max_budget_usd'),
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(r.state.status).toBe('budget-exceeded');
    r = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => bad('isolation-leak'),
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(r.state.outcome).toMatchObject({ status: 'failed', reason: 'runner-error' });
    expect((await store.reviewQueue.list())[2]?.summary).toMatch(/격리 누수/);
  });

  it('전체 예산(run.maxBudgetUsd)을 넘으면 budget-exceeded', async () => {
    await approveRule();
    const { adapter } = fakeAdapter(dir, [[1, 0]]);
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => okRole(2, 0.8),
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(state.status).toBe('budget-exceeded');
    expect(state.outcome).toMatchObject({ status: 'budget-exceeded', maxBudgetUsd: 1 });
  });

  it('③에서 유효한 이의 제기 파일이 있으면 disputes[]에 적고 ③ ✔(disputeId) → ④로 간다', async () => {
    await approveRule();
    const { adapter } = fakeAdapter(dir, [
      [1, 0],
      [1, 0],
    ]);
    const runRole = async (input: RunRoleInput): Promise<RoleRunResult> => {
      if (input.options.model && input.prompt.includes('이의 제기')) {
        const disputesDir = join(dir, '.work', 'implementer', 'disputes');
        await writeFile(
          join(disputesDir, 'd-boundary.md'),
          '7일 경계 해석이 테스트와 규칙에서 다르다\n\n규칙은 초과인데 테스트는 7일째도 거절을 기대한다. 입력: 정확히 7일.',
        );
      }
      return okRole();
    };
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole,
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(state.disputes).toHaveLength(1);
    // 재검토(#88): 가짜 runRole은 구조화 출력이 없으므로 ambiguous → 그래도 대기열에 올라가고 queued
    expect(state.disputes[0]).toMatchObject({
      id: 'd-boundary',
      by: 'implementer',
      reviewer: 'test-writer',
      status: 'queued',
      queueItemId: 'q-0001',
      advisory: { by: 'test-writer', verdict: 'ambiguous' },
    });
    expect((await store.reviewQueue.list())[0]).toMatchObject({ kind: 'dispute', runId: state.id });
    expect(state.stages[2]?.result).toMatchObject({ stage: 3, allPassed: false, disputeId: 'd-boundary' });
    expect(state.status).toBe('completed');
  });

  it('signal이 중단되면 다음 단계 전에 aborted', async () => {
    await approveRule();
    const { adapter } = fakeAdapter(dir, [[1, 0]]);
    const ctl = new AbortController();
    ctl.abort();
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => okRole(),
      runCheck: fakeCheck,
      injectOnce: fakeInject().injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
      signal: ctl.signal,
    });
    expect(state.outcome).toMatchObject({ status: 'aborted', by: 'user' });
  });

  it('⑤ 검사가 약하면(weak-check) ②로 1회 되돌아가고, 두 번째도 약하면 검토 대기열에 올리고 완료한다', async () => {
    await approveRule();
    // 라운드마다 ②·③ 증거 2회 + 되돌림 뒤 다시 2회
    const { adapter } = fakeAdapter(dir, [
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
    ]);
    const prompts: string[] = [];
    const runRole = async (input: RunRoleInput): Promise<RoleRunResult> => {
      prompts.push(input.prompt);
      return okRole();
    };
    const inj = fakeInject([
      { valid: false, verdict: 'weak-check' },
      { valid: false, verdict: 'weak-check' },
    ]);
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole,
      runCheck: fakeCheck,
      injectOnce: inj.injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(state.status).toBe('completed');
    expect(state.stages.map((s) => [s.stage, s.attempt])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 1],
    ]);
    expect(inj.calls).toHaveLength(2);
    expect(prompts.filter((p) => p.includes('위반 주입이 검사를 통과했다'))).toHaveLength(1); // 되돌림 ②의 프롬프트에 보강 재료
    expect(state.stages[8]?.result).toMatchObject({ stage: 5, weak: true });
    const queue = await store.reviewQueue.list();
    expect(queue.some((q) => q.kind === 'undetermined-injection' && q.summary.includes('weak-check'))).toBe(true);
    expect(state.stages[9]?.result).toMatchObject({ stage: 6, queued: 1 });
  });

  it('⑤ 미판정(undetermined)은 되돌리지 않고 ⑥으로 간다', async () => {
    await approveRule();
    const { adapter } = fakeAdapter(dir, [
      [1, 0],
      [0, 1],
    ]);
    const inj = fakeInject([{ valid: false, verdict: 'undetermined' }]);
    const { state } = await runPipeline({
      config,
      root: dir,
      store,
      adapter,
      ruleIds: [RULE.id],
      runRole: async () => okRole(),
      runCheck: fakeCheck,
      injectOnce: inj.injectOnce,
      generateViews: fakeViews,
      inPlace: true,
      heartbeatMs: 0,
    });
    expect(state.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.stages[4]?.result).toMatchObject({ stage: 5, injections: 1, caught: 0, weak: false });
  });

  // -------------------------------------------------------------------------
  // 병합 게이트 ① (#134, 결정 #122): ⑥ 뒤 원본 레포에 브랜치 plumb/<run-id>. 임시 git 레포 + 가짜 worktree(레포 자체)
  // -------------------------------------------------------------------------
  describe('⑥ 뒤 브랜치 plumb/<run-id> (임시 git 레포)', () => {
    const exec = promisify(execFile);
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    const sh = async (cwd: string, args: string[]) => (await exec('git', [...ID, ...args], { cwd })).stdout.trim();
    /** 서비스 레포: 루트 `dir/service`, 커밋 하나, `.work/`는 gitignore(역할 작업 디렉토리가 worktree 안에 생기므로) */
    async function initRepo(name: string): Promise<string> {
      const repo = join(dir, name);
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, 'package.json'), '{}');
      await writeFile(join(repo, '.gitignore'), '.work\n');
      await exec('git', ['init', '-q', '-b', 'main', repo]);
      await sh(repo, ['add', '-A']);
      await sh(repo, ['commit', '-q', '-m', 'init']);
      // 실제 worktree처럼 detached — main은 움직이지 않는다
      await sh(repo, ['checkout', '-q', '--detach']);
      return repo;
    }
    /** createWorktree 대신: 주어진 레포 자체를 worktree로 쓴다 (inject.test와 같은 방식) */
    const fakeWorktree = (repo: string) => async () => ({
      repoRoot: repo,
      serviceRoot: repo,
      commit: 'abc1234def',
      linkedNodeModules: [],
    });
    /** 역할이 cwd에 파일을 남긴다 → ⑤ 전 commitWorktree가 커밋한다 */
    const writingRole = async (input: RunRoleInput): Promise<RoleRunResult> => {
      await writeFile(join(input.options.cwd ?? dir, 'impl.ts'), 'export const DAYS = 7;\n');
      return okRole();
    };
    const serviceConfig = { ...config, service: 'service' };

    it('②③ 커밋이 있으면 원본 레포에 plumb/<run-id>를 그 커밋에 만들고 RunState.branch에 적는다 — main은 그대로(자동 머지 없음)', async () => {
      await approveRule();
      const repo = await initRepo('service');
      const main = await sh(repo, ['rev-parse', 'main']);
      const { adapter } = fakeAdapter(dir, [
        [1, 0],
        [0, 1],
      ]);
      const logs: string[] = [];
      const { state } = await runPipeline({
        config: serviceConfig,
        root: dir,
        store,
        adapter,
        ruleIds: [RULE.id],
        runId: 'r-0007',
        runRole: writingRole,
        runCheck: fakeCheck,
        injectOnce: fakeInject().injectOnce,
        generateViews: fakeViews,
        createWorktree: fakeWorktree(repo),
        heartbeatMs: 0,
        log: (l) => void logs.push(l),
      });
      expect(state.status).toBe('completed');
      expect(state.commits).toBeDefined();
      expect(state.branch).toBe('plumb/r-0007');
      expect(await sh(repo, ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).toBe('plumb/r-0007');
      expect(await sh(repo, ['rev-parse', 'refs/heads/plumb/r-0007'])).toBe(state.commits?.to);
      expect(await sh(repo, ['rev-parse', 'main'])).toBe(main);
      // 상태 파일에도 적혔다 — UI · `plumb runs show`는 이것만 읽는다
      expect((await store.runs.get('r-0007'))?.branch).toBe('plumb/r-0007');
      expect(logs.some((l) => /^\[branch\] plumb\/r-0007 @ [0-9a-f]{7} \(git merge plumb\/r-0007\)$/.test(l))).toBe(
        true,
      );
    });

    it('브랜치를 못 만들어도 실행은 completed — branch 없음 + [branch] 실패 로그', async () => {
      await approveRule();
      await initRepo('service');
      // worktree가 다른 객체 저장소(별개 레포)라 커밋이 원본에 없다 → git branch 실패
      const other = await initRepo('other');
      const { adapter } = fakeAdapter(dir, [
        [1, 0],
        [0, 1],
      ]);
      const logs: string[] = [];
      const { state } = await runPipeline({
        config: serviceConfig,
        root: dir,
        store,
        adapter,
        ruleIds: [RULE.id],
        runId: 'r-0008',
        runRole: writingRole,
        runCheck: fakeCheck,
        injectOnce: fakeInject().injectOnce,
        generateViews: fakeViews,
        createWorktree: fakeWorktree(other),
        heartbeatMs: 0,
        log: (l) => void logs.push(l),
      });
      expect(state.status).toBe('completed');
      expect(state.commits).toBeDefined();
      expect(state.branch).toBeUndefined();
      expect(logs.some((l) => l.startsWith('[branch] 실패: '))).toBe(true);
      expect(await sh(join(dir, 'service'), ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).toBe('');
    });

    it('역할이 아무것도 바꾸지 않아 커밋이 없으면 브랜치도 없다', async () => {
      await approveRule();
      const repo = await initRepo('service');
      const { adapter } = fakeAdapter(dir, [
        [1, 0],
        [0, 1],
      ]);
      const logs: string[] = [];
      const { state } = await runPipeline({
        config: serviceConfig,
        root: dir,
        store,
        adapter,
        ruleIds: [RULE.id],
        runId: 'r-0009',
        runRole: async () => okRole(),
        runCheck: fakeCheck,
        injectOnce: fakeInject().injectOnce,
        generateViews: fakeViews,
        createWorktree: fakeWorktree(repo),
        heartbeatMs: 0,
        log: (l) => void logs.push(l),
      });
      expect(state.status).toBe('completed');
      expect(state.commits).toBeUndefined();
      expect(state.branch).toBeUndefined();
      expect(logs.some((l) => l.startsWith('[branch]'))).toBe(false);
      expect(await sh(repo, ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).toBe('');
    });
  });
});
