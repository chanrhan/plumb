/**
 * `/runs` 화면과 실행 API가 공유하는 서버 쪽 읽기 모델 (이슈 #89, work-run 3절 · 4절, README 3.1 · 3.3 · 3.4). 값은 전부
 * 저장소의 `runs/<id>.json`과 `plumb.config.json`에서 온다 — 목 데이터 없음. UI 서버는 상태 파일을 **읽기만** 한다.
 *
 * - `readRunList()` · `readRunState(id)`: `store.runs` 그대로. 쓰는 도중 읽혀 깨진 파일은 `SyntaxError` · `ValidationError`로 올라온다 → 라우트가 503
 * - `startDetachedRun(ruleIds)`: `plumb run --rules … --detach --json`을 자식 프로세스로 띄운다. 전제조건(승인 · 예산 상한 · 동시 1개)은
 *   CLI 부모가 검사하고 실패하면 `{ error, message }`를 stdout에 쓰고 exit 2/3으로 끝난다 — UI는 그 코드를 400/404/409로 옮길 뿐,
 *   같은 검사를 중복 구현하지 않는다 (`@plumb/core/run`은 Agent SDK를 끌어오므로 UI 서버가 import하지 않는다)
 * - `abortRun(id)`: 상태 파일의 `pid`로 SIGTERM (README 3.4). 실제 종료는 파일 폴링으로 확인한다
 * - 코어 CLI 위치는 `lib/views.ts`의 `resolveCoreCli()`와 같다
 */

import { spawn } from 'node:child_process';
import {
  type AbortRunResponse,
  type ApiError,
  isRunId,
  loadConfig,
  type Role,
  type RuleId,
  type RunId,
  type RunListResponse,
  type RunState,
  ValidationError,
} from '@plumb/core';
import { getStore, getTarget } from './store';
import { resolveCoreCli } from './views';

export { isRunId };

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

/**
 * 503 본문 — 상태 파일을 쓰는 도중 읽어 JSON이 찢겼거나(`SyntaxError`) 모양이 아직 안 갖춰졌다(`ValidationError`).
 * `ApiError`에는 503 변형이 없어 여기 로컬로 둔다 (타입 보완 후속). 화면은 직전 응답을 유지하고 `retryAfterMs` 뒤 다음 폴링을 기다린다
 * (work-run 4절 오류 표). 쓰기는 원자적(임시 파일 → rename)이라 실제로는 드물다
 */
export interface RunStateUnreadableBody {
  status: 503;
  code: 'run-state-unreadable';
  message: string;
  retryAfterMs: number;
}

export const RETRY_AFTER_MS = 1500;

/** 찢긴 · 미완성 상태 파일인가. `SyntaxError`는 이름으로 본다 — 코어(dist)와 라우트가 다른 모듈 영역에서 로드될 수 있다 */
export function isUnreadableRunFile(error: unknown): error is Error {
  return error instanceof ValidationError || (error instanceof Error && error.name === 'SyntaxError');
}

export function unreadableBody(error: Error): RunStateUnreadableBody {
  return {
    status: 503,
    code: 'run-state-unreadable',
    message: `진행 파일을 읽지 못함 (쓰는 도중): ${error.message}`,
    retryAfterMs: RETRY_AFTER_MS,
  };
}

/**
 * `GET /api/runs` 본문. 최근 시작 순. 모양이 안 맞는 파일은 코어가 건너뛰지만, JSON 자체가 찢긴 파일은 `SyntaxError`로 올라온다
 * (코어 `listRuns`의 건너뛰기가 `readJsonFile` 뒤에 있다 — 코어 후속). 라우트가 503으로 옮기고 화면은 직전 목록을 유지한다
 */
export async function readRunList(): Promise<RunListResponse> {
  const store = await getStore();
  return { runs: await store.runs.list() };
}

/** `GET /api/runs/:id` 본문 = 파일 그대로. 없으면 `undefined`. 찢긴 JSON은 `SyntaxError`, 모양이 아니면 코어 `ValidationError` — 그대로 올라온다 */
export async function readRunState(id: RunId): Promise<RunState | undefined> {
  const store = await getStore();
  return store.runs.get(id);
}

/** 새 실행 패널의 상한 줄 (work-run 3.1 "예산 상한 · maxTurns · stopBlockLimit"). 저장소: `plumb.config.json` */
export interface RunLimitsView {
  /** `run.maxBudgetUsd`. 없으면 `[시작]` 비활성 (work-run 5절) */
  maxBudgetUsd?: number;
  stopBlockLimit: number;
  maxTurns: Partial<Record<Role, number>>;
}

/**
 * 요청마다 `plumb.config.json`을 다시 읽는다 (캐시 없음) — 5절 안내대로 `run.maxBudgetUsd`를 적으면 UI 서버 재시작 없이 `[시작]`이 살아난다.
 * 파일 하나 읽는 비용이라 캐시할 이유가 없다
 */
export async function readRunLimits(): Promise<RunLimitsView> {
  const { config } = await loadConfig({ target: getTarget() });
  const maxTurns: Partial<Record<Role, number>> = {};
  for (const [role, rc] of Object.entries(config.roles ?? {})) {
    if (rc !== undefined) maxTurns[role as Role] = rc.maxTurns;
  }
  const budget = config.run?.maxBudgetUsd;
  return {
    ...(budget === undefined ? {} : { maxBudgetUsd: budget }),
    stopBlockLimit: config.stopBlockLimit,
    maxTurns,
  };
}

// ---------------------------------------------------------------------------
// 새 실행 — `plumb run --detach` 자식 프로세스
// ---------------------------------------------------------------------------

/** 부모 `plumb run --detach`는 전제조건 검사 + 초기 상태 파일 쓰기 + 자식 spawn만 하고 끝난다. 그래도 저장소를 열어야 하므로 여유를 둔다 */
export const START_TIMEOUT_MS = 30 * 1000;

/** CLI 부모가 stdout에 쓰는 전제조건 오류 코드 (`cli/commands/run.ts` → `RunPreconditionError.code`) */
export type RunPreconditionCode = 'rule-not-found' | 'rule-not-approved' | 'run-in-progress' | 'no-budget';

const PRECONDITION_CODES: readonly RunPreconditionCode[] = [
  'rule-not-found',
  'rule-not-approved',
  'run-in-progress',
  'no-budget',
];

/** 전제조건 실패 — CLI가 돌려준 코드 그대로. 라우트가 400/404/409로 옮긴다 */
export class RunPreconditionFailed extends Error {
  override readonly name = 'RunPreconditionFailed';
  constructor(
    readonly code: RunPreconditionCode,
    message: string,
  ) {
    super(message);
  }
}

/** 프로세스를 못 띄웠거나(ENOENT 등) 출력이 약속한 JSON이 아니다 → 500 `spawn-failed` */
export class RunSpawnError extends Error {
  override readonly name = 'RunSpawnError';
  constructor(
    detail: string,
    readonly exitCode: number | null,
    readonly stderrTail: string[],
  ) {
    super(detail);
  }
}

export interface StartedRun {
  id: RunId;
  pid: number;
}

/**
 * `plumb run --target <root> --rules <ids…> --detach --json`. 성공이면 `{ id, pid }`(부모는 이미 초기 `runs/<id>.json`을 썼다 —
 * 바로 이어지는 `GET /api/runs/:id`가 404를 받지 않는다). 전제조건 실패면 {@link RunPreconditionFailed}, 그 밖은 {@link RunSpawnError}.
 */
export function startDetachedRun(ruleIds: RuleId[]): Promise<StartedRun> {
  const cli = resolveCoreCli();
  const target = getTarget();
  return new Promise((resolveStarted, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [cli, '--target', target, 'run', '--rules', ...ruleIds, '--detach', '--json'], {
        cwd: target,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new RunSpawnError(error instanceof Error ? error.message : String(error), null, []));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() =>
        reject(
          new RunSpawnError(`plumb run --detach가 ${START_TIMEOUT_MS / 1000}초 안에 끝나지 않았다`, null, tail(stderr)),
        ),
      );
    }, START_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(chunk.toString()));
    child.once('error', (error) =>
      finish(() => reject(new RunSpawnError(`plumb run을 띄우지 못함: ${error.message}`, null, tail(stderr)))),
    );
    child.once('exit', (code) =>
      finish(() => {
        const text = stdout.join('');
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          reject(
            new RunSpawnError(`plumb run 출력이 JSON이 아니다 (exit ${code ?? 'null'})`, code, tail(stderr, text)),
          );
          return;
        }
        const parsed = parseStartOutput(body);
        if (parsed === null) {
          reject(new RunSpawnError(`plumb run 출력에 id가 없다 (exit ${code ?? 'null'})`, code, tail(stderr, text)));
          return;
        }
        if (parsed instanceof RunPreconditionFailed) {
          reject(parsed);
          return;
        }
        resolveStarted(parsed);
      }),
    );
  });
}

/** `{ id, pid }` → 시작됨 · `{ error, message }` → 전제조건 실패 · 그 밖 → `null` */
export function parseStartOutput(body: unknown): StartedRun | RunPreconditionFailed | null {
  if (typeof body !== 'object' || body === null) return null;
  const { id, pid, error, message } = body as Record<string, unknown>;
  if (typeof error === 'string' && (PRECONDITION_CODES as readonly string[]).includes(error)) {
    return new RunPreconditionFailed(error as RunPreconditionCode, typeof message === 'string' ? message : error);
  }
  if (isRunId(id)) return { id, pid: typeof pid === 'number' ? pid : -1 };
  return null;
}

/**
 * 전제조건 실패 → `ApiError`. 400 `rule-not-approved`(+`ruleIds`) · `no-budget`, 404 `rule-not-found`, 409 `run-in-progress`(+`runId`).
 * 409의 `runId`는 메시지의 `r-nnnn`에서 뽑고, 없으면 저장소의 진행 중 실행으로 보강한다
 */
export async function preconditionToApiError(failed: RunPreconditionFailed, ruleIds: RuleId[]): Promise<ApiError> {
  switch (failed.code) {
    case 'rule-not-found':
      return { status: 404, code: 'rule-not-found', message: failed.message };
    case 'rule-not-approved':
      return { status: 400, code: 'rule-not-approved', message: failed.message, ruleIds };
    case 'no-budget':
      return { status: 400, code: 'no-budget', message: failed.message };
    case 'run-in-progress': {
      const fromMessage = /r-\d{4,}/.exec(failed.message)?.[0];
      const runId = isRunId(fromMessage) ? fromMessage : (await (await getStore()).runs.active())?.id;
      return {
        status: 409,
        code: 'run-in-progress',
        message: failed.message,
        ...(runId === undefined ? {} : { runId }),
      };
    }
  }
}

function tail(chunks: string[], extra = ''): string[] {
  return `${chunks.join('')}${extra}`
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(-5);
}

// ---------------------------------------------------------------------------
// 중단 — pid로 SIGTERM
// ---------------------------------------------------------------------------

export type AbortOutcome =
  | { kind: 'not-found' }
  | { kind: 'finished'; state: RunState }
  | { kind: 'requested'; response: AbortRunResponse };

/**
 * `POST /api/runs/:id/abort`. 없으면 404, 이미 끝났으면 409 `run-finished`, 진행 중이면 `pid`로 SIGTERM → 202.
 * pid가 이미 사라졌어도(ESRCH) 202 — 파일이 진실이고, 멈춘 프로세스는 화면의 "60초 넘게 갱신 없음" 경고가 알린다.
 * `kill`은 테스트가 바꾼다
 */
export async function abortRun(
  id: RunId,
  kill: (pid: number, signal: 'SIGTERM') => void = (pid, signal) => process.kill(pid, signal),
): Promise<AbortOutcome> {
  const state = await readRunState(id);
  if (state === undefined) return { kind: 'not-found' };
  if (state.status !== 'running') return { kind: 'finished', state };
  try {
    kill(state.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  return { kind: 'requested', response: { id, requested: true, signal: 'SIGTERM' } };
}
