/**
 * `plumb run` · `plumb runs` (이슈 #87, 기획안 §8.5 "코어는 라이브러리, 데몬 없음 — `plumb run`은 detached 자식").
 *
 *   plumb run --rules <id...> [--detach]   파이프라인(#86) 실행. `--detach`면 자기 자신을 분리된 자식으로 띄우고 `{ "id" }`만 출력
 *   plumb run --rules … --child <r-id>     (내부) 분리된 자식의 진입. SIGTERM이면 상태 파일에 `aborted`를 쓰고 끝낸다
 *   plumb runs list | show <r-id> | abort <r-id>
 *
 * 종료 코드: 0 성공 · 1 실행 실패(failed · budget-exceeded · aborted) · 2 입력(규칙 없음 · 미승인 · 예산 상한 없음) · 3 진행 중인 실행 있음 / 끝난 실행 abort
 * (`types/api.ts`의 400 · 409 코드와 같은 이름 — UI 서버(#89)가 그대로 매핑한다)
 */

import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { loadAdapter as defaultLoadAdapter } from '../../adapter/load.js';
import {
  runPipeline as defaultRunPipeline,
  type PipelineDeps,
  type PipelineResult,
  RunPreconditionError,
} from '../../run/pipeline.js';
import { newRunState } from '../../run/state.js';
import type { RuleId, RunId, RunState, RunSummary } from '../../types/index.js';
import {
  type CliContext,
  EXIT_ERROR,
  EXIT_INPUT,
  EXIT_OK,
  type OpenedStore,
  openTargetStore,
  renderTable,
  runCommand,
  targetOf,
  writeJson,
} from './shared.js';

/** 진행 중인 실행이 있다 / 이미 끝난 실행을 중단하려 했다 (API 409) */
export const EXIT_RUN_CONFLICT = 3;

export interface SpawnDetachedInput {
  /** `process.execPath` */
  node: string;
  /** CLI 진입 파일 (`process.argv[1]`) */
  entry: string;
  args: string[];
  cwd: string;
}

export interface RunCliDeps {
  runPipeline?: (deps: PipelineDeps) => Promise<PipelineResult>;
  /** 분리된 자식을 띄우고 pid를 돌려준다. 기본 `child_process.spawn(detached, stdio ignore) + unref` */
  spawnDetached?: (input: SpawnDetachedInput) => number;
  /** 시그널 보내기. 기본 `process.kill` */
  kill?: (pid: number, signal: 'SIGTERM') => void;
  /** 이 프로세스 정보. 테스트가 바꾼다 */
  self?: { execPath: string; entry: string; pid: number };
}

export type RunCliContext = CliContext & RunCliDeps;

export interface RunOptions {
  rules: string[];
  detach: boolean;
  child?: string;
  json: boolean;
}

function defaultSpawnDetached(input: SpawnDetachedInput): number {
  const child = spawn(input.node, [input.entry, ...input.args], { cwd: input.cwd, detached: true, stdio: 'ignore' });
  child.unref();
  if (child.pid === undefined) throw new Error('자식 프로세스를 띄우지 못했다 (pid 없음)');
  return child.pid;
}

export function preconditionExitCode(error: RunPreconditionError): number {
  return error.code === 'run-in-progress' ? EXIT_RUN_CONFLICT : EXIT_INPUT;
}

export function outcomeExitCode(state: RunState): number {
  return state.status === 'completed' ? EXIT_OK : EXIT_ERROR;
}

/** 자식의 로그 파일 — stdio를 버리므로 여기에 남긴다 */
export function childLogPath(opened: OpenedStore, runId: RunId): string {
  return join(opened.store.paths.runsDir, runId, 'run.log');
}

/**
 * 자식이 파이프라인을 시작하지 못했을 때(어댑터 로드 · 전제조건 등) 부모가 선기록한 `running`을 `failed/spawn-error`로 닫는다 —
 * 그대로 두면 유령 running이 남아 다음 `plumb run`이 전부 run-in-progress로 막힌다(#115). 이미 끝난 상태면 건드리지 않는다
 */
async function markSpawnFailed(
  opened: OpenedStore,
  runId: RunId,
  message: string,
  now: (() => Date) | undefined,
): Promise<void> {
  try {
    const state = await opened.store.runs.get(runId);
    if (state?.status !== 'running') return;
    const finishedAt = (now ?? (() => new Date()))().toISOString();
    const item = await opened.store.reviewQueue.enqueue({
      kind: 'run-failed',
      ruleIds: state.ruleIds,
      runId,
      summary: `실행 시작 실패: ${message}`,
    });
    await opened.store.runs.write({
      ...state,
      status: 'failed',
      currentRole: null,
      finishedAt,
      updatedAt: finishedAt,
      outcome: { status: 'failed', finishedAt, reason: 'spawn-error', queueItemId: item.id },
    });
  } catch {
    // 상태 기록 실패는 원래 오류를 가리지 않는다
  }
}

async function runInline(
  ctx: RunCliContext,
  opened: OpenedStore,
  ruleIds: RuleId[],
  runId: RunId | undefined,
  log: (line: string) => void,
): Promise<RunState> {
  const load = ctx.loadAdapter ?? defaultLoadAdapter;
  const { adapter } = await load(opened.config.adapter);
  const run = ctx.runPipeline ?? defaultRunPipeline;
  const controller = new AbortController();
  const onTerm = () => {
    controller.abort();
    // 역할 실행 중이면 파이프라인이 단계 사이에서야 멈춘다 — 상태 파일에는 지금 바로 `aborted`를 쓴다 (README 3.4)
    if (runId !== undefined) {
      void opened.store.runs.get(runId).then(async (state) => {
        if (state && state.status === 'running') {
          const finishedAt = (ctx.now ?? (() => new Date()))().toISOString();
          await opened.store.runs.write({
            ...state,
            status: 'aborted',
            currentRole: null,
            finishedAt,
            updatedAt: finishedAt,
            outcome: { status: 'aborted', finishedAt, by: 'user', signal: 'SIGTERM' },
          });
        }
        ctx.exit(EXIT_ERROR);
      });
    }
  };
  process.once('SIGTERM', onTerm);
  try {
    const { state } = await run({
      config: opened.config,
      root: opened.loaded.root,
      store: opened.store,
      adapter,
      ruleIds,
      ...(runId === undefined ? {} : { runId }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
      signal: controller.signal,
      log,
    });
    return state;
  } finally {
    process.off('SIGTERM', onTerm);
  }
}

export async function runCommandBody(
  ctx: RunCliContext,
  opened: OpenedStore,
  options: RunOptions,
  cwd: string,
): Promise<number> {
  const ruleIds = options.rules as RuleId[];
  if (ruleIds.length === 0) {
    ctx.stderr.write('plumb run: --rules <id...> 가 필요하다\n');
    return EXIT_INPUT;
  }

  // 분리된 자식: 로그는 파일로, 결과는 상태 파일로
  if (options.child !== undefined) {
    const runId = options.child as RunId;
    const logPath = childLogPath(opened, runId);
    await mkdir(dirname(logPath), { recursive: true });
    const fh = await open(logPath, 'a');
    const log = (line: string) => void fh.write(`${new Date().toISOString()} ${line}\n`).catch(() => undefined);
    try {
      const state = await runInline(ctx, opened, ruleIds, runId, log);
      log(`[run] ${state.id} ${state.status}`);
      return outcomeExitCode(state);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      log(`[run] 시작 실패: ${message}`);
      await markSpawnFailed(opened, runId, message, ctx.now);
      throw error;
    } finally {
      await fh.close();
    }
  }

  // 전제조건은 부모가 먼저 본다 — 사용자에게 바로 알리기 위해 (자식은 다시 본다)
  const { checkPreconditions } = await import('../../run/pipeline.js');
  try {
    await checkPreconditions({ config: opened.config, store: opened.store, ruleIds });
  } catch (error) {
    if (error instanceof RunPreconditionError) {
      if (options.json) writeJson(ctx, { error: error.code, message: error.message });
      else ctx.stderr.write(`plumb run: ${error.message} (${error.code})\n`);
      return preconditionExitCode(error);
    }
    throw error;
  }

  if (options.detach) {
    const runId = await opened.store.runs.nextId();
    const self = ctx.self ?? { execPath: process.execPath, entry: process.argv[1] ?? '', pid: process.pid };
    const target = ['--target', opened.loaded.root];
    const pid = (ctx.spawnDetached ?? defaultSpawnDetached)({
      node: self.execPath,
      entry: self.entry,
      args: [...target, 'run', '--rules', ...ruleIds, '--child', runId],
      cwd,
    });
    // 자식이 첫 상태를 쓰기 전의 틈(수백 ms)에 `runs show` · `GET /api/runs/:id`가 404를 받지 않도록 부모가 초기 상태를 먼저 쓴다.
    // 자식은 같은 id · 같은 pid로 덮어쓴다. 동시 1개 검사(`runs.active`)도 이 순간부터 유효하다
    await opened.store.runs.write(
      newRunState({ id: runId, ruleIds, config: opened.config, pid, ...(ctx.now ? { now: ctx.now } : {}) }),
    );
    if (options.json) writeJson(ctx, { id: runId, pid, log: childLogPath(opened, runId) });
    else ctx.stdout.write(`${JSON.stringify({ id: runId, pid })}\n`);
    return EXIT_OK;
  }

  // 전경 실행(로컬 시험용) — 로그를 stdout에
  const state = await runInline(ctx, opened, ruleIds, undefined, (line) => ctx.stdout.write(`${line}\n`));
  if (options.json) writeJson(ctx, state);
  else
    ctx.stdout.write(
      `${state.id} ${state.status} stage ${state.stage}${state.outcome && 'reason' in state.outcome ? ` (${state.outcome.reason})` : ''} · 비용 ${state.costUsd === null ? '—' : `$${state.costUsd.toFixed(4)}`}\n`,
    );
  return outcomeExitCode(state);
}

// ---------------------------------------------------------------------------
// plumb runs
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<RunState['status'], string> = {
  running: '진행중',
  completed: '완료',
  failed: '실패',
  'budget-exceeded': '예산초과',
  aborted: '중단',
};

export function runsListText(runs: RunSummary[]): string {
  if (runs.length === 0) return '실행 기록 없음 — plumb run --rules <id> 로 시작한다\n';
  return `${renderTable<RunSummary>(
    [
      { header: 'ID', width: 8, cell: (r) => r.id },
      { header: '상태', width: 8, cell: (r) => STATUS_LABEL[r.status] },
      { header: '단계', width: 4, cell: (r) => String(r.stage) },
      { header: '시작', width: 24, cell: (r) => r.startedAt },
      { header: '종료', width: 24, cell: (r) => r.finishedAt ?? '—' },
      { header: '규칙', width: 30, cell: (r) => r.ruleIds.join(', ') },
    ],
    runs,
  )}\n`;
}

export function runShowText(state: RunState): string {
  const lines = [
    `${state.id} · ${STATUS_LABEL[state.status]} · 단계 ${state.stage} · pid ${state.pid}`,
    `규칙: ${state.ruleIds.join(', ')} · 시작 ${state.startedAt} · 갱신 ${state.updatedAt}${state.finishedAt ? ` · 종료 ${state.finishedAt}` : ''}`,
    `비용 ${state.costUsd === null ? '—' : `$${state.costUsd.toFixed(4)}`} / $${state.limits.maxBudgetUsd}${state.worktree ? ` · worktree ${state.worktree}` : ''}`,
    ...state.stages.map(
      (s) =>
        `  ${s.finishedAt ? '✔' : '●'} ${s.stage}${s.attempt > 1 ? ` (${s.attempt}회차)` : ''} ${s.role ?? '—'}${s.result ? ` ${JSON.stringify(s.result)}` : ''}`,
    ),
    ...Object.entries(state.roles)
      .filter(([, u]) => u.turns > 0 || u.stopBlocks > 0)
      .map(
        ([role, u]) =>
          `  ${role}: 턴 ${u.turns} / ${state.limits.maxTurns[role as keyof typeof state.limits.maxTurns] ?? '—'} · 종료 차단 ${u.stopBlocks} · 비용 ${u.costUsd === null ? '—' : `$${u.costUsd.toFixed(4)}`}`,
      ),
    ...(state.disputes.length > 0
      ? [
          `  이의 제기 ${state.disputes.length}건: ${state.disputes.map((d) => `${d.id} ${d.by}→${d.reviewer} "${d.summary}"`).join(' · ')}`,
        ]
      : []),
    ...(state.outcome ? [`종료: ${JSON.stringify(state.outcome)}`] : []),
    ...(state.capturedOutput
      ? [
          `마지막 출력 ($ ${state.capturedOutput.command}, exit ${state.capturedOutput.exitCode}):`,
          ...state.capturedOutput.tail.map((l) => `  │ ${l}`),
        ]
      : ['마지막 출력: 아직 실행 출력 없음']),
  ];
  return `${lines.join('\n')}\n`;
}

export async function runsAbortBody(
  ctx: RunCliContext,
  opened: OpenedStore,
  runId: RunId,
  json: boolean,
): Promise<number> {
  const state = await opened.store.runs.get(runId);
  if (!state) {
    ctx.stderr.write(`plumb runs abort: 실행 없음 ${runId} (run-not-found)\n`);
    return EXIT_INPUT;
  }
  if (state.status !== 'running') {
    ctx.stderr.write(`plumb runs abort: ${runId}은 이미 끝났다 — ${STATUS_LABEL[state.status]} (run-finished)\n`);
    return EXIT_RUN_CONFLICT;
  }
  try {
    (ctx.kill ?? ((pid, signal) => process.kill(pid, signal)))(state.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    // 프로세스가 이미 없다(자식이 상태를 못 쓰고 죽은 유령 running, #115) — 보낼 신호가 없으니 상태만 aborted로 닫는다
    const finishedAt = (ctx.now ?? (() => new Date()))().toISOString();
    await opened.store.runs.write({
      ...state,
      status: 'aborted',
      currentRole: null,
      finishedAt,
      updatedAt: finishedAt,
      outcome: { status: 'aborted', finishedAt, by: 'user', signal: 'SIGTERM' },
    });
    if (json) writeJson(ctx, { id: runId, requested: false, processGone: true, status: 'aborted' });
    else ctx.stdout.write(`프로세스 없음 (pid ${state.pid}) — ${runId} 상태를 aborted로 닫았다\n`);
    return EXIT_OK;
  }
  if (json) writeJson(ctx, { id: runId, requested: true, signal: 'SIGTERM' });
  else ctx.stdout.write(`중단 요청: ${runId} (pid ${state.pid}, SIGTERM) — 상태는 plumb runs show ${runId} 로 확인\n`);
  return EXIT_OK;
}

export function registerRunCommands(program: Command, ctx: RunCliContext): void {
  program
    .command('run')
    .description('승인된 규칙으로 파이프라인 ②③④를 실행한다 (M6)')
    .requiredOption('--rules <ids...>', '실행할 규칙 ID (첫 슬라이스는 1개)')
    .option('--detach', '분리된 자식으로 띄우고 {"id"}만 출력한다 (UI 서버가 쓰는 방식)', false)
    .option('--child <r-id>', '(내부) 분리된 자식의 진입')
    .option('--json', '기계용 JSON 출력', false)
    .action(async (options: RunOptions, command: Command) => {
      await runCommand(ctx, async () =>
        runCommandBody(ctx, await openTargetStore(ctx, targetOf(command)), options, ctx.cwd ?? process.cwd()),
      );
    });

  const runs = program.command('runs').description('실행 기록을 보고 중단한다 (M6)');
  runs
    .command('list')
    .description('실행 목록 (최근 순)')
    .option('--json', '기계용 JSON 출력', false)
    .action(async (options: { json: boolean }, command: Command) => {
      await runCommand(ctx, async () => {
        const opened = await openTargetStore(ctx, targetOf(command));
        const list = await opened.store.runs.list();
        if (options.json) writeJson(ctx, { runs: list });
        else ctx.stdout.write(runsListText(list));
        return EXIT_OK;
      });
    });
  runs
    .command('show <runId>')
    .description('실행 하나의 단계 · 역할 사용량 · 이의 제기 · 마지막 출력')
    .option('--json', '기계용 JSON 출력', false)
    .action(async (runId: string, options: { json: boolean }, command: Command) => {
      await runCommand(ctx, async () => {
        const opened = await openTargetStore(ctx, targetOf(command));
        const state = await opened.store.runs.get(runId as RunId);
        if (!state) {
          ctx.stderr.write(`plumb runs show: 실행 없음 ${runId} (run-not-found)\n`);
          return EXIT_INPUT;
        }
        if (options.json) writeJson(ctx, state);
        else ctx.stdout.write(runShowText(state));
        return EXIT_OK;
      });
    });
  runs
    .command('abort <runId>')
    .description('진행 중인 실행에 SIGTERM을 보낸다. 테스트 파일과 구현은 worktree에 남는다')
    .option('--json', '기계용 JSON 출력', false)
    .action(async (runId: string, options: { json: boolean }, command: Command) => {
      await runCommand(ctx, async () =>
        runsAbortBody(ctx, await openTargetStore(ctx, targetOf(command)), runId as RunId, options.json),
      );
    });
}
