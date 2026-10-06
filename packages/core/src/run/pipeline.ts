/**
 * 파이프라인 ①→②→③→④ (이슈 #86, 기획안 §8.3). 규칙 1개(첫 슬라이스)로 사람 개입 없이 끝까지 돈다.
 *
 *   ① 승인 확인      — 규칙마다 승인 기록(`action: 'approve'`)이 있어야 시작. 없으면 {@link RunPreconditionError}
 *   ② test-writer    — worktree에서 `.d.ts` 스텁 → 역할 실행(Stop `all-fail`) → 증거: 담당 파일이 있고 전부 실패 → ✔. 아니면 `stage-2-not-all-failed`
 *   ③ implementer    — 역할 실행(Stop `all-pass-or-dispute`) → 전부 통과 ✔ 또는 유효한 이의 제기 → `disputes[]`(재검토는 #88)
 *   ④ plumb check    — `runCheck()`를 worktree에 대고 돌려 규칙별 상태를 저장소에 기록. ⑤ 뒤 한 번 더 돌려 주입 결과(🟢 · 🟡)를 반영(#105)
 *   ⑥ 뒤 브랜치      — ②③ 결과 커밋(`RunState.commits.to`)에 원본 레포 브랜치 `plumb/<run-id>`를 만들고 `RunState.branch`에 적는다(#134, 결정 #122).
 *                      자동 머지는 없다. 주입 커밋(별도 임시 worktree)은 넣지 않는다. 실패해도 실행은 `completed`(로그만)
 * 예산(`run.maxBudgetUsd`)은 단계마다 본다. 역할의 `maxTurns` 초과(SDK `error_max_turns`) → `failed: maxTurns`.
 * 격리 누수(`isolation-leak`)와 러너 실패 → `failed: runner-error`. 연속 Stop 차단 상한 → `failed: stopBlockLimit`.
 *
 * SDK 호출(`runRole`)과 검사(`runCheck`)는 주입 가능 — 단위 테스트는 가짜를 준다. 실제 실행은 `env/local`.
 */

import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { HookCallbackMatcher, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Adapter, AdapterContext } from '../adapter/types.js';
import { runCheck as defaultRunCheck, type RunCheckDeps, type RunCheckResult } from '../checks/run-check.js';
import { scanDisputes, toDispute } from '../harness/dispute.js';
import { toolTargetPath } from '../harness/path-guard.js';
import { implementerOptions } from '../harness/roles/implementer.js';
import { testWriterOptions } from '../harness/roles/test-writer.js';
import { runRole as defaultRunRole, type RoleRunResult, type RunRoleInput } from '../harness/run-role.js';
import { makeStopHook, type StopState } from '../harness/stop.js';
import { generateDeclarationStubs } from '../harness/stubs.js';
import { ensureRoleWorkDir, resolveWorkRoot } from '../harness/work-dir.js';
import type { Store } from '../store/index.js';
import type { PlumbConfig, Role, Rule, RuleId, RuleStatus, RunId, RunState } from '../types/index.js';
import {
  buildViewContext,
  generateViews as defaultGenerateViews,
  type ViewGenerationResult,
} from '../views/generate.js';
import type { ViewContext } from '../views/types.js';
import { handleDisputes } from './dispute-flow.js';
import { collectEvidence } from './evidence.js';
import {
  injectOnce as defaultInjectOnce,
  InjectionError,
  type InjectOnceDeps,
  type InjectOnceResult,
} from './inject.js';
import { newRunState, RunRecorder } from './state.js';
import { commitWorktree, createRunBranch, createWorktree, runBranchName, type Worktree } from './worktree.js';

export class RunPreconditionError extends Error {
  constructor(
    readonly code: 'rule-not-found' | 'rule-not-approved' | 'run-in-progress' | 'no-budget',
    message: string,
  ) {
    super(message);
    this.name = 'RunPreconditionError';
  }
}

export interface PipelineDeps {
  config: PlumbConfig;
  /** `plumb.config.json`이 있는 원본 루트(절대) */
  root: string;
  store: Store;
  adapter: Adapter;
  ruleIds: RuleId[];
  /** 없으면 `store.runs.nextId()` */
  runId?: RunId;
  /** 주입점 — 테스트는 가짜를 준다 */
  runRole?: (input: RunRoleInput) => Promise<RoleRunResult>;
  runCheck?: (deps: RunCheckDeps) => Promise<RunCheckResult>;
  createWorktree?: (serviceRoot: string, dir: string) => Promise<Worktree>;
  /** ⑤ 위반 주입(#90). 테스트는 가짜를 준다 */
  injectOnce?: (deps: InjectOnceDeps) => Promise<InjectOnceResult>;
  /** ⑥ View 갱신. 테스트는 가짜를 준다 */
  generateViews?: (ctx: ViewContext) => Promise<ViewGenerationResult[]>;
  /** ⑤에서 검사가 약하면 ②로 되돌아가는 횟수 상한. 기본 1 */
  maxRewinds?: number;
  /** worktree 없이 원본에서 돌린다(시험용). 기본 false */
  inPlace?: boolean;
  now?: () => Date;
  /** 단계 사이에 확인한다. 중단되면 `aborted` */
  signal?: AbortSignal;
  /** heartbeat 간격(ms). 기본 10초. 0이면 끈다 */
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export interface PipelineResult {
  state: RunState;
  worktree?: Worktree;
}

function acceptanceFiles(rules: readonly Rule[]): string[] {
  return [
    ...new Set(
      rules.flatMap((r) => r.checks.filter((c) => c.kind === 'acceptance' || c.kind === 'pbt').map((c) => c.ref)),
    ),
  ];
}

/** ① 승인 확인 + 동시 1개 + 예산 상한 존재 (work-run 4절 · 5절) */
export async function checkPreconditions(
  deps: Pick<PipelineDeps, 'config' | 'store' | 'ruleIds' | 'runId'>,
): Promise<Rule[]> {
  if (deps.config.run?.maxBudgetUsd === undefined)
    throw new RunPreconditionError(
      'no-budget',
      'plumb.config.json run.maxBudgetUsd가 없다 — 상한 없이는 실행하지 않는다',
    );
  // `plumb run --detach`의 부모는 자식을 띄우기 전에 같은 id의 초기 상태(running)를 먼저 쓴다(#87). 자식이 그것을 "다른 실행"으로
  // 보면 자기 자신 때문에 run-in-progress로 죽고 상태는 running으로 남는다(#115) — 자기 id는 뺀다
  const active = await deps.store.runs.active();
  if (active && active.id !== deps.runId)
    throw new RunPreconditionError('run-in-progress', `${active.id}이 진행 중이다 (동시 1개)`);
  const rules: Rule[] = [];
  for (const id of deps.ruleIds) {
    const rule = await deps.store.rules.get(id);
    if (!rule) throw new RunPreconditionError('rule-not-found', `규칙 없음: ${id}`);
    const approved = (await deps.store.approvals.history(id)).some((a) => a.action === 'approve');
    if (!approved) throw new RunPreconditionError('rule-not-approved', `승인되지 않은 규칙: ${id}`);
    rules.push(rule);
  }
  return rules;
}

function latestApprovedAt(history: { action: string; at: string }[]): string {
  return (
    history
      .filter((a) => a.action === 'approve')
      .map((a) => a.at)
      .sort()
      .at(-1) ?? ''
  );
}

export async function runPipeline(deps: PipelineDeps): Promise<PipelineResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const runRole = deps.runRole ?? defaultRunRole;
  const runCheckFn = deps.runCheck ?? defaultRunCheck;
  const rules = await checkPreconditions(deps);
  const runId = deps.runId ?? (await deps.store.runs.nextId());
  const origServiceRoot = resolve(deps.root, deps.config.service);
  // worktree 자체는 원본의 `.work/<runId>/repo`에
  const runWork = join(resolveWorkRoot(deps.config, deps.root), runId);

  // worktree
  let worktree: Worktree | undefined;
  let serviceRoot = origServiceRoot;
  if (!deps.inPlace) {
    const make = deps.createWorktree ?? ((s, d) => createWorktree({ serviceRoot: s, dir: d }));
    worktree = await make(origServiceRoot, join(runWork, 'repo'));
    serviceRoot = worktree.serviceRoot;
    log(
      `[run] worktree ${worktree.repoRoot} @ ${worktree.commit.slice(0, 7)} (node_modules ${worktree.linkedNodeModules.length}개 링크)`,
    );
  }
  const ctx: AdapterContext = { root: serviceRoot, config: deps.config };
  const logPath = join(deps.store.paths.runsDir, runId, 'output.log');
  // 역할 작업 디렉토리(스텁 · 이의 제기)는 **역할 cwd 안**에 둔다 — 경로 가드가 cwd 밖을 전부 막으므로(클라우드 1차 실행에서
  // test-writer가 스텁을 읽지 못해 API를 추측했다). `.work/`는 서비스 .gitignore에 있다
  const roleWork = resolveWorkRoot(deps.config, serviceRoot);

  const rec = new RunRecorder(
    newRunState({ id: runId, ruleIds: deps.ruleIds, config: deps.config, worktree: worktree?.repoRoot, now }),
    deps.store,
    now,
  );
  await rec.persist();
  const hb =
    deps.heartbeatMs === 0
      ? undefined
      : setInterval(() => void rec.heartbeat().catch(() => undefined), deps.heartbeatMs ?? 10_000);
  const stderr = (data: string) => {
    if (/Sandbox disabled/.test(data)) log(`[sandbox] ${data.trim().split('\n')[0]}`);
  };

  const aborted = () => deps.signal?.aborted === true;
  // 모든 파일 도구 호출의 경로를 로그에 남긴다 — 가드는 거부만 적으므로 성공 경로도 보여야 진단이 된다 (#94, r-0001 실측)
  const logTools: HookCallbackMatcher[] = [
    {
      hooks: [
        async (input) => {
          const pre = input as PreToolUseHookInput;
          const target = toolTargetPath(pre.tool_name, pre.tool_input);
          if (target !== undefined) log(`[tool] ${pre.tool_name} ${target}`);
          else if (pre.tool_name === 'Bash')
            log(
              `[tool] Bash ${JSON.stringify(String((pre.tool_input as { command?: unknown })?.command ?? '')).slice(0, 160)}`,
            );
          return {};
        },
      ],
    },
  ];
  const roleFailure = async (role: Role, r: RoleRunResult, stop: StopState): Promise<RunState | undefined> => {
    await rec.recordRole(role, {
      turns: r.turns,
      costUsd: r.costUsd,
      stopBlocks: stop.blocks,
      consecutiveStopBlocks: stop.consecutiveBlocks,
    });
    if (r.outcome === 'error_max_turns') return rec.fail('maxTurns', role);
    if (r.outcome === 'error_max_budget_usd') return rec.budgetExceeded();
    if (r.outcome === 'isolation-leak')
      return rec.fail('runner-error', role, `격리 누수: ${r.leak?.reasons.join(' / ')}`);
    if (!r.ok) return rec.fail('runner-error', role, `역할 실행 실패: ${r.outcome}`);
    if (rec.overBudget()) return rec.budgetExceeded();
    return undefined;
  };

  try {
    // ① 승인
    await rec.startStage(1, null);
    const approvedAt: Record<RuleId, string> = {};
    for (const r of rules) approvedAt[r.id] = latestApprovedAt(await deps.store.approvals.history(r.id));
    await rec.finishStage({ stage: 1, approvedAt });
    const expected = acceptanceFiles(rules);

    const maxRewinds = deps.maxRewinds ?? 1;
    const injectOnce = deps.injectOnce ?? defaultInjectOnce;
    const generateViews = deps.generateViews ?? defaultGenerateViews;
    let rewindHints: string[] = [];
    for (let round = 1; round <= maxRewinds + 1; round++) {
      // ② test-writer
      if (aborted()) return { state: await rec.abort(), worktree };
      await rec.startStage(2, 'test-writer');
      const twWork = await ensureRoleWorkDir(roleWork, 'test-writer');
      const stubsDir = join(twWork.dir, 'stubs');
      const stubs = await generateDeclarationStubs({ serviceRoot, outDir: stubsDir });
      log(`[stage 2] stubs ${stubs.files.length} (tsc exit ${stubs.exitCode}) → ${relative(serviceRoot, stubsDir)}`);
      const twStop = makeStopHook({
        kind: 'all-fail',
        stopBlockLimit: deps.config.stopBlockLimit,
        collect: async () =>
          (await collectEvidence({ adapter: deps.adapter, ctx, scope: expected, expectedFiles: expected, logPath }))
            .evidence,
        log,
      });
      const twRun = await runRole({
        prompt: `담당 규칙 ${rules.map((r) => r.id).join(', ')}의 인수 테스트를 ${expected.join(', ')}에 써라. 끝내려 하면 하네스가 테스트를 돌려 확인한다.${rewindHints.length ? `\n\n⚠ 위반 주입이 검사를 통과했다 — 아래 위반을 잡도록 테스트를 보강하라(기존 테스트는 유지):\n- ${rewindHints.join('\n- ')}` : ''}`,
        options: testWriterOptions({
          config: deps.config,
          rules,
          cwd: serviceRoot,
          stubsDir: join(twWork.dir, 'stubs'),
          stopHook: twStop.hook,
          extraPreToolUse: logTools,
          stderr,
          log,
        }),
      });
      const twFail = await roleFailure('test-writer', twRun, twStop.state);
      if (twFail) return { state: twFail, worktree };
      const ev2 = await collectEvidence({
        adapter: deps.adapter,
        ctx,
        scope: expected,
        expectedFiles: expected,
        logPath,
      });
      await rec.setCapturedOutput(ev2.captured);
      const allFailed =
        ev2.tally.total > 0 &&
        ev2.tally.failed === ev2.tally.total &&
        (ev2.evidence.expectedFiles ?? []).every((f) => ev2.evidence.presentFiles?.includes(f));
      await rec.finishStage({ stage: 2, tests: ev2.tally, allFailed });
      log(`[stage 2] ${ev2.tally.failed}/${ev2.tally.total} 실패 → ${allFailed ? '✔' : '✘'}`);
      if (twStop.state.disputeRequired) return { state: await rec.fail('stopBlockLimit', 'test-writer'), worktree };
      if (!allFailed)
        return {
          state: await rec.fail(
            'stage-2-not-all-failed',
            'test-writer',
            `테스트 ${ev2.tally.passed}/${ev2.tally.total} 통과 — 구현 전인데 통과하는 테스트`,
          ),
          worktree,
        };

      // ③ implementer
      if (aborted()) return { state: await rec.abort(), worktree };
      await rec.startStage(3, 'implementer');
      const imWork = await ensureRoleWorkDir(roleWork, 'implementer');
      const imStop = makeStopHook({
        kind: 'all-pass-or-dispute',
        stopBlockLimit: deps.config.stopBlockLimit,
        collect: async () =>
          (
            await collectEvidence({
              adapter: deps.adapter,
              ctx,
              scope: expected,
              disputesDir: imWork.disputesDir,
              logPath,
            })
          ).evidence,
        log,
      });
      const imRun = await runRole({
        prompt: `실패하는 인수 테스트 ${expected.join(', ')}를 통과시키도록 구현을 고쳐라. 테스트가 틀렸다고 보면 ${imWork.disputesDir}에 이의 제기 파일을 써라.`,
        options: implementerOptions({
          config: deps.config,
          rules,
          failingTests: expected,
          cwd: serviceRoot,
          disputesDir: imWork.disputesDir,
          stopHook: imStop.hook,
          extraPreToolUse: logTools,
          stderr,
          log,
        }),
      });
      const imFail = await roleFailure('implementer', imRun, imStop.state);
      if (imFail) return { state: imFail, worktree };
      const ev3 = await collectEvidence({
        adapter: deps.adapter,
        ctx,
        scope: expected,
        disputesDir: imWork.disputesDir,
        logPath,
      });
      await rec.setCapturedOutput(ev3.captured);
      const disputes = await scanDisputes(imWork.disputesDir);
      for (const d of disputes.valid)
        await rec.addDispute(toDispute(d, 'implementer', 'test-writer', now().toISOString()));
      const allPassed = ev3.tally.total > 0 && ev3.tally.failed === 0;
      const firstDispute = disputes.valid[0];
      await rec.finishStage({
        stage: 3,
        tests: ev3.tally,
        allPassed,
        ...(firstDispute ? { disputeId: firstDispute.id } : {}),
      });
      log(
        `[stage 3] ${ev3.tally.passed}/${ev3.tally.total} 통과${disputes.valid.length ? ` · 이의 제기 ${disputes.valid.length}건` : ''} → ${allPassed || firstDispute ? '✔' : '✘'}`,
      );
      if (imStop.state.disputeRequired && !firstDispute)
        return { state: await rec.fail('stopBlockLimit', 'implementer'), worktree };

      if (disputes.valid.length > 0) {
        // 이의 제기 → test-writer 재검토(advisory) → 검토 대기열 (#88). 실패해도 대기열에는 올라간다
        const reviewed = await handleDisputes({
          config: deps.config,
          store: deps.store,
          rules,
          disputes: rec.current.disputes,
          readFile: (p) => readFile(p, 'utf8'),
          cwd: serviceRoot,
          runId,
          runRole,
          now,
          log,
          stderr,
        });
        for (const r of reviewed) {
          await rec.replaceDispute(r.dispute);
          await rec.recordRole('test-writer', { turns: r.usage.turns, costUsd: r.usage.costUsd });
        }
        if (rec.overBudget()) return { state: await rec.budgetExceeded(), worktree };
      }

      // ④ plumb check (worktree에 대고; 기록은 원본 저장소에)
      if (aborted()) return { state: await rec.abort(), worktree };
      await rec.startStage(4, null);
      const check = await runCheckFn({
        config: deps.config,
        root: worktree ? worktree.serviceRoot : deps.root,
        store: deps.store,
        adapter: deps.adapter,
        now,
      });
      const byRule = Object.fromEntries(
        check.statuses.filter((s) => deps.ruleIds.includes(s.ruleId)).map((s) => [s.ruleId, s.detail.status]),
      ) as Record<RuleId, RuleStatus>;
      await rec.finishStage({ stage: 4, checkRunId: check.run.runId, byRule });
      log(`[stage 4] check ${check.run.runId} → ${JSON.stringify(byRule)}`);
      if (check.runnerFailed) return { state: await rec.fail('runner-error', undefined, '검사 러너 실패'), worktree };
      if (rec.overBudget()) return { state: await rec.budgetExceeded(), worktree };

      // ⑤ 위반 주입 — 규칙마다 1건. 구현·테스트를 worktree에 커밋한 HEAD에서 갈라진다(하네스가 커밋한다)
      if (aborted()) return { state: await rec.abort(), worktree };
      await rec.startStage(5, 'injector');
      if (worktree) {
        const committed = await commitWorktree(worktree, `plumb run ${runId} round ${round}: ②③ 결과`);
        if (committed) {
          await rec.setCommits(committed);
          log(`[stage 5] worktree 커밋 ${committed.from.slice(0, 7)}..${committed.to.slice(0, 7)}`);
        }
      }
      let injections = 0;
      let caught = 0;
      const weakExamples: string[] = [];
      for (const rule of rules) {
        try {
          const r = await injectOnce({
            config: deps.config,
            root: worktree ? worktree.serviceRoot : deps.root,
            store: deps.store,
            adapter: deps.adapter,
            rule,
            runId,
            stderr,
            log,
            now,
          });
          injections += 1;
          await rec.recordRole('injector', { turns: r.role.turns, costUsd: r.role.costUsd });
          if (r.validity.valid) caught += 1;
          else if (r.validity.diffSearch?.verdict === 'weak-check')
            weakExamples.push(`${rule.id}: ${r.validity.description}`);
          log(
            `[stage 5] ${rule.id} ${r.validity.id} → ${r.validity.valid ? '잡힘 ✔' : `통과해 버림 ✘ (${r.validity.diffSearch?.verdict ?? '차이 탐색 없음'})`}`,
          );
        } catch (error) {
          if (error instanceof InjectionError) log(`[stage 5] ${rule.id} 주입 불가: ${error.message}`);
          else throw error;
        }
      }
      const weak = weakExamples.length > 0;
      await rec.finishStage({ stage: 5, injections, caught, weak });
      if (rec.overBudget()) return { state: await rec.budgetExceeded(), worktree };
      if (weak && round <= maxRewinds) {
        // 검사가 약하다 → ②로 되돌아가 테스트 보강 (기획안 §8.3). 되돌림은 상한까지만
        rewindHints = weakExamples;
        log(`[stage 5] 검사 약함 → ② 되돌림 (${round}/${maxRewinds})`);
        continue;
      }
      if (weak) {
        await deps.store.reviewQueue.enqueue({
          kind: 'undetermined-injection',
          ruleIds: deps.ruleIds,
          runId,
          summary: `검사 약함(weak-check)이 ${maxRewinds}회 보강 뒤에도 남음: ${weakExamples.join(' · ')}`,
        });
      }
      // ⑤ 뒤 ④ 재검사 (#105) — ④는 주입 전에 돌았으므로 그 상태 파일은 🟡(주입 기록 없음)이다. 주입 기록이 생겼으니 한 번 더
      // 돌려 🟢 `pass-verified` · 🟡 `injection-invalid`가 `rule-status/`에 반영되게 한다. 단계 기록은 ④ 그대로, 결과는 로그 한 줄
      if (injections > 0) {
        const recheck = await runCheckFn({
          config: deps.config,
          root: worktree ? worktree.serviceRoot : deps.root,
          store: deps.store,
          adapter: deps.adapter,
          now,
        });
        const afterInjection = Object.fromEntries(
          recheck.statuses.filter((s) => deps.ruleIds.includes(s.ruleId)).map((s) => [s.ruleId, s.detail.status]),
        ) as Record<RuleId, RuleStatus>;
        log(`[stage 5] 재검사 ${recheck.run.runId} → ${JSON.stringify(afterInjection)}`);
      }
      break;
    }

    // ⑥ View 갱신 + 이 실행이 올린 검토 대기열 수
    if (aborted()) return { state: await rec.abort(), worktree };
    await rec.startStage(6, null);
    const viewCtx = await buildViewContext({
      config: deps.config,
      root: worktree ? worktree.serviceRoot : deps.root,
      store: deps.store,
      loaded: { adapter: deps.adapter },
      now,
    });
    const views = await generateViews(viewCtx);
    const viewsUpdated = views.filter((v) => 'ok' in v && v.ok).length;
    const queued = (await deps.store.reviewQueue.list()).filter((q) => q.runId === runId).length;
    await rec.finishStage({ stage: 6, viewsUpdated, queued });
    log(`[stage 6] views ${viewsUpdated}/${views.length} · 검토 대기열 ${queued}`);

    // ⑥ 뒤 병합 게이트(#134, 결정 #122): ②③ 결과 커밋에 원본 레포 브랜치 `plumb/<run-id>`. 커밋이 없으면(역할이 아무것도 안 바꿈) 없다.
    // ref 하나뿐이라 실패해도 실행 결과는 그대로 — 로그만 남기고 completed. 자동 머지는 하지 않는다
    const commits = rec.current.commits;
    if (worktree && commits) {
      const name = runBranchName(runId);
      try {
        const made = await createRunBranch(origServiceRoot, name, commits.to);
        await rec.setBranch(made.name);
        log(`[branch] ${made.name} @ ${made.sha.slice(0, 7)} (git merge ${made.name})`);
      } catch (error) {
        log(`[branch] 실패: ${(error as Error).message ?? String(error)}`);
      }
    }
    return { state: await rec.complete(), worktree };
  } catch (error) {
    const msg = (error as Error).message ?? String(error);
    log(`[run] 예외: ${msg}`);
    return { state: await rec.fail('runner-error', rec.current.currentRole ?? undefined, `예외: ${msg}`), worktree };
  } finally {
    if (hb) clearInterval(hb);
  }
}
