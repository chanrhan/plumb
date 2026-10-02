/**
 * 대상 레포의 도구 실행 + 출력 가로채기 (이슈 #44, 기획안 §7.5 · §8.3).
 *
 * 검사 도구는 만들지 않는다 — 대상 레포에 설치된 도구(`node_modules/.bin/*`)를 그대로 실행하고 stdout·stderr를 가로챈다.
 * 상태와 타임라인은 이 가로챈 출력에서만 만든다 (§8.3). 에이전트의 자기 보고는 어디에도 들어가지 않는다.
 *
 * - 실행은 `child_process.spawn`(셸 아님) + `cwd: ctx.root`. 어댑터는 `root` 밖을 읽거나 쓰지 않는다 (§8.6)
 * - 도구는 **대상 레포의** `node_modules/.bin/<name>`만 쓴다. 대상 레포가 pnpm이 아닐 수도 있으므로 `pnpm exec`을 쓰지 않고,
 *   없을 때 `npx`로 폴백하지도 않는다 — "러너 없음"을 exit code {@link EXIT_RUNNER_MISSING}과 꼬리 한 줄로 돌려준다
 * - 전체 로그는 `<work>/logs/<시각>-<name>.log` (`ctx.config.work` 기본 `./.work`), `tail`은 마지막 {@link TAIL_LINES}줄
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { AdapterContext, CapturedOutput, ToolInfo } from '@plumb/core';

/** `CapturedOutput.tail` 줄 수 (work-run 6절 5번 "꼬리 N줄(제안: 20줄)") */
export const TAIL_LINES = 20;

/** 대상 레포에 러너가 없을 때의 exit code. 셸의 "command not found"와 같은 값 */
export const EXIT_RUNNER_MISSING = 127;

/** 프로세스가 시그널로 죽어 exit code가 없을 때 (타임아웃 · 외부 kill) */
export const EXIT_KILLED = -1;

export interface CaptureOptions {
  /** `node_modules/.bin/` 아래 이름 (`vitest` · `depcruise`). 로그 파일 이름에도 쓴다 */
  bin: string;
  args: string[];
  /** 추가 환경변수. 값은 로그에 쓰지 않는다 (`TestRunOptions.env`) */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CaptureResult {
  output: CapturedOutput;
  /** 러너 바이너리가 `root/node_modules/.bin`에 없어서 실행 자체를 못 했다 */
  runnerMissing: boolean;
}

/** `<root>/<work>` 절대 경로. `config.work`는 루트 기준 상대 경로 (기본 `./.work`) */
export function workDir(ctx: AdapterContext): string {
  return resolve(ctx.root, ctx.config.work ?? './.work');
}

/** `<root>/node_modules/.bin/<name>` */
export function binPath(ctx: AdapterContext, name: string): string {
  return join(ctx.root, 'node_modules', '.bin', name);
}

/** 파일 시각: ISO 8601에서 파일 이름에 못 쓰는 `:`·`.`을 `-`로 */
function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** 사람이 읽는 명령 한 줄. 공백이 든 인자는 따옴표로 */
function renderCommand(ctx: AdapterContext, bin: string, args: string[]): string {
  const shown = relative(ctx.root, binPath(ctx, bin)) || bin;
  return [shown, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
}

/** 마지막 N줄. 끝의 빈 줄은 뺀다 */
export function tailLines(text: string, n = TAIL_LINES): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  return lines.slice(-n);
}

/**
 * 대상 레포의 도구 `package.json`에서 이름·버전. 설치돼 있지 않으면 버전은 `'unknown'`
 * (없는 것을 있는 것처럼 꾸미지 않는다 — 다만 `ToolInfo.version`이 필수 문자열이라 빈 값 대신 이 표식을 쓴다)
 */
export async function readToolInfo(
  ctx: AdapterContext,
  packageName: string,
  toolName = packageName,
): Promise<ToolInfo> {
  try {
    const raw = await readFile(join(ctx.root, 'node_modules', packageName, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return { name: toolName, version: typeof pkg.version === 'string' ? pkg.version : 'unknown' };
  } catch {
    return { name: toolName, version: 'unknown' };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 도구를 실행하고 출력을 가로챈다. 절대 던지지 않는다 — 러너 없음 · spawn 실패 · 시그널 종료도 전부
 * `CapturedOutput`(exit code · 꼬리 · 로그 경로)로 돌려준다. 호출자는 그걸 보고 `junitPath: null` 같은 "없음"을 적는다.
 */
export async function capture(ctx: AdapterContext, options: CaptureOptions): Promise<CaptureResult> {
  const startedAt = new Date();
  const command = renderCommand(ctx, options.bin, options.args);
  const logDir = join(workDir(ctx), 'logs');
  const logPath = join(logDir, `${fileStamp(startedAt)}-${options.bin}.log`);
  const bin = binPath(ctx, options.bin);

  let body: string;
  let exitCode: number;
  let runnerMissing = false;
  let note = '';

  if (await exists(bin)) {
    const result = await run(bin, options, ctx.root);
    body = result.body;
    exitCode = result.exitCode;
    note = result.note;
  } else {
    runnerMissing = true;
    exitCode = EXIT_RUNNER_MISSING;
    body = `[plumb] 러너 없음: ${relative(ctx.root, bin)} 이(가) 대상 레포에 설치되어 있지 않다. npx로 폴백하지 않는다\n`;
  }

  const finishedAt = new Date();
  const header = `$ ${command}\n# cwd: ${ctx.root}\n# startedAt: ${startedAt.toISOString()}\n`;
  const separator = body === '' || body.endsWith('\n') ? '' : '\n';
  const footer = `${note}# finishedAt: ${finishedAt.toISOString()}\n# exit: ${exitCode}\n`;
  await mkdir(logDir, { recursive: true });
  await writeFile(logPath, header + body + separator + footer, 'utf8');

  return {
    runnerMissing,
    output: {
      command,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode,
      tail: tailLines(body + separator + note),
      logPath,
    },
  };
}

interface RunResult {
  body: string;
  exitCode: number;
  /** 어댑터가 덧붙인 줄 (spawn 실패 · 시그널 종료). 도구 출력과 구분하려고 `[plumb]` 접두어 */
  note: string;
}

function run(bin: string, options: CaptureOptions, cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const chunks: string[] = [];
    let note = '';
    let settled = false;
    const done = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolvePromise({ body: chunks.join(''), exitCode, note });
    };

    const child = spawn(bin, options.args, {
      cwd,
      // 로그 파일에 들어가는 출력이므로 색(ANSI)을 끈다. 호출자가 넘긴 env가 우선한다
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: 'SIGTERM' as const } : {}),
    });

    // stdout·stderr를 도착 순서대로 한 스트림에 모은다. 구분하지 않는다 — 터미널에서 보이는 그대로가 "가로챈 출력"이다
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => chunks.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => chunks.push(chunk));

    child.on('error', (error) => {
      note += `[plumb] spawn 실패: ${error.message}\n`;
      done(EXIT_RUNNER_MISSING);
    });
    child.on('close', (code, signal) => {
      if (code === null) {
        const timeout = options.timeoutMs ? ` (timeout ${options.timeoutMs}ms)` : '';
        note += `[plumb] 시그널로 종료: ${signal ?? 'unknown'}${timeout}\n`;
        done(EXIT_KILLED);
        return;
      }
      done(code);
    });
  });
}
