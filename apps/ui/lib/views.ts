/**
 * `/views` 화면과 View API가 공유하는 서버 쪽 읽기 모델 (이슈 #60, work-views 3절 · 4절, README 3.3). 값은 전부 코어 저장소 · git에서 온다 —
 * 목 데이터 없음. 본문 렌더링은 클라이언트 컴포넌트(`components/views/ViewBody.tsx`)가 한다.
 *
 * - `readViewResponse(name)`: `store.views.read()` → `ViewResponse`(머리말 · Markdown · 정본 JSON · `stale` · 열람 수). 없으면 `null`
 * - `regenerateViews(names)`: `plumb views <names> --json`을 자식 프로세스로 돌리고 **끝날 때까지 기다린다** (5분). 진행 중이면 409
 * - 코어 CLI 위치는 `cli/commands/ui.ts`의 `resolveUiDir`와 같은 전제(모노레포, 워크스페이스 링크)로 푼다
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  gitHead,
  isViewName,
  VIEW_NAMES,
  VIEW_PLANNED_IN,
  type ViewGenerationResult,
  type ViewHeader,
  type ViewListItem,
  type ViewName,
  type ViewResponse,
} from '@plumb/core';
import { getStore, getTarget } from './store';

export { isViewName, VIEW_NAMES, VIEW_PLANNED_IN };

/** 현재 HEAD (40자). git이 없으면 `undefined` — 오래됨 비교를 하지 않는다 */
export async function currentHead(): Promise<string | undefined> {
  const head = await gitHead(getTarget());
  return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
}

export function staleOf(header: ViewHeader, head: string | undefined): { head: string } | undefined {
  if (header.commit === undefined || head === undefined) return undefined;
  return header.commit === head ? undefined : { head };
}

/**
 * View 하나 (`GET /api/views/:name` 200 본문). JSON이 없으면 `null`(404 `not-generated`). JSON은 있는데 Markdown이 없으면 코어가
 * `ViewStoreError`를 던진다 — 반쪽을 그리지 않는다 (호출자가 500으로)
 */
export async function readViewResponse(name: ViewName): Promise<ViewResponse | null> {
  const store = await getStore();
  const stored = await store.views.read(name);
  if (stored === null) return null;
  const header = stored.view.header;
  const [head, codeOpens] = await Promise.all([currentHead(), store.codeOpens.count(name, header.generatedAt)]);
  const stale = staleOf(header, head);
  return {
    header,
    markdown: stored.markdown,
    data: stored.view,
    ...(stale === undefined ? {} : { stale }),
    codeOpens,
  };
}

/** 탭 상태: 저장소에 있는 View 목록 (`views/` 폴더가 없으면 빈 배열) */
export async function listGeneratedViews(): Promise<ViewListItem[]> {
  const store = await getStore();
  return store.views.list();
}

// ---------------------------------------------------------------------------
// 재생성 — `plumb views` 자식 프로세스
// ---------------------------------------------------------------------------

/** 기다리는 상한. 흐름도는 testbed 테스트를 실제로 돌린다 */
export const REGENERATE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 코어 CLI `dist/cli/index.js`. ① 워크스페이스 링크 `apps/ui/node_modules/@plumb/core/dist/cli/index.js`(UI 서버의 cwd는 `apps/ui`)
 * ② 모노레포 상대 경로 `apps/ui` → `../../packages/core/dist/cli/index.js` (`cli/commands/ui.ts`의 `resolveUiDir`와 같은 전제).
 * `PLUMB_CLI`가 있으면 그것. `createRequire`를 쓰지 않는 것은 번들러(webpack)가 동적 인자를 경고하기 때문이다
 */
export function resolveCoreCli(): string {
  const fromEnv = process.env.PLUMB_CLI;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const linked = join(process.cwd(), 'node_modules', '@plumb', 'core', 'dist', 'cli', 'index.js');
  if (existsSync(linked)) return linked;
  return resolve(process.cwd(), '..', '..', 'packages', 'core', 'dist', 'cli', 'index.js');
}

export class RegenerateInProgressError extends Error {
  override readonly name = 'RegenerateInProgressError';
  constructor(readonly names: ViewName[]) {
    super(`View 재생성이 진행 중이다 (${names.length === 0 ? '전부' : names.join(', ')})`);
  }
}

export class RegenerateSpawnError extends Error {
  override readonly name = 'RegenerateSpawnError';
  constructor(
    detail: string,
    readonly exitCode: number | null,
    readonly stderrTail: string[],
  ) {
    super(detail);
  }
}

export interface RegenerateOutcome {
  names: ViewName[];
  /** `plumb views --json`의 결과 행 (cause 없음) */
  views: Array<Omit<ViewGenerationResult, 'cause'>>;
  exitCode: number;
  commit?: string;
}

let inProgress: { names: ViewName[]; done: Promise<RegenerateOutcome> } | null = null;

/** 지금 재생성이 돌고 있는가 (409 판정 · 화면 표시) */
export function regenerateInProgress(): ViewName[] | null {
  return inProgress === null ? null : inProgress.names;
}

/**
 * `plumb views [names] --json`을 띄우고 끝날 때까지 기다린다. 동시에 하나만 — 진행 중이면 {@link RegenerateInProgressError}(409).
 * 프로세스를 못 띄우거나 JSON을 못 읽으면 {@link RegenerateSpawnError}(500). 생성기 실패(exit 1)는 오류가 아니라 결과 표에 보인다.
 */
export function regenerateViews(names: ViewName[]): Promise<RegenerateOutcome> {
  if (inProgress !== null) throw new RegenerateInProgressError(inProgress.names);
  const done = runPlumbViews(names).finally(() => {
    inProgress = null;
  });
  inProgress = { names, done };
  return done;
}

function runPlumbViews(names: ViewName[]): Promise<RegenerateOutcome> {
  const cli = resolveCoreCli();
  const target = getTarget();
  return new Promise((resolveOutcome, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [cli, '--target', target, 'views', ...names, '--json'], {
        cwd: target,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail(new RegenerateSpawnError(error instanceof Error ? error.message : String(error), null, []));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail(
        new RegenerateSpawnError(
          `plumb views가 ${REGENERATE_TIMEOUT_MS / 1000}초 안에 끝나지 않았다`,
          null,
          tail(stderr),
        ),
      );
    }, REGENERATE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(chunk.toString()));
    child.once('error', (error) =>
      fail(new RegenerateSpawnError(`plumb views를 띄우지 못함: ${error.message}`, null, [])),
    );
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.join('');
      let body: { views?: unknown; exitCode?: unknown; commit?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        reject(
          new RegenerateSpawnError(
            `plumb views 출력이 JSON이 아니다 (exit ${code ?? 'null'})`,
            code,
            tail(stderr, text),
          ),
        );
        return;
      }
      if (!Array.isArray(body.views)) {
        reject(
          new RegenerateSpawnError(`plumb views 출력에 views가 없다 (exit ${code ?? 'null'})`, code, tail(stderr)),
        );
        return;
      }
      resolveOutcome({
        names,
        views: body.views as RegenerateOutcome['views'],
        exitCode: typeof body.exitCode === 'number' ? body.exitCode : (code ?? 1),
        ...(typeof body.commit === 'string' ? { commit: body.commit } : {}),
      });
    });
  });
}

function tail(chunks: string[], extra = ''): string[] {
  return `${chunks.join('')}${extra}`
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(-5);
}
