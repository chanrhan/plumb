/**
 * `plumb ui` (이슈 #33) — 승인 통로의 시작점. `docs/screens/README.md` 3.2의 토큰 흐름 6단계를 그대로 구현한다.
 *
 *   1. 토큰 T = 32바이트 난수
 *   2. `~/.plumb/run/<project>/ui.json`에 `{ port, token, pid, startedAt, target }` 저장 — 폴더 0700, 파일 0600
 *      (에이전트 샌드박스는 `~/.plumb/**`를 못 읽는다. 차단 자체는 M4)
 *   3. `apps/ui`를 자식 프로세스로 띄운다. `-H 127.0.0.1` 강제 (0.0.0.0 금지). 토큰은 환경변수로만 넘긴다
 *   4. 준비되면 `http://127.0.0.1:<port>/auth?token=T`를 출력하고 브라우저를 연다
 *   5~6. `/auth`와 미들웨어는 UI 서버 쪽(`apps/ui/lib/auth.ts`, `apps/ui/middleware.ts`)
 *
 * `apps/ui`의 위치는 이 패키지 위치에서 `../../apps/ui`로 푼다 — 모노레포 안에서 실행하는 전제다. 전역 설치는 M10.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { ConfigError, loadConfig } from '../../config/index.js';
import { resolveStoreRoot } from '../../store/index.js';

export const DEFAULT_UI_PORT = 4817;
/** 바인드 주소. 1인용 로컬 도구 — 바꿀 수 없다 */
export const UI_HOST = '127.0.0.1';
export const UI_RUN_FILE = 'ui.json';
export const UI_TOKEN_BYTES = 32;

/** `~/.plumb/run/<project>/ui.json`의 내용 */
export interface UiRunInfo {
  port: number;
  /** 일회용 토큰 (hex 64자). 브라우저에만 넘긴다 — `/auth?token=` */
  token: string;
  /** `plumb ui` 프로세스의 pid. 자식(next)은 이 프로세스가 끝나면 함께 끝난다 */
  pid: number;
  startedAt: string;
  /** 대상 루트 (절대 경로) */
  target: string;
}

export interface UiOptions {
  /** 기본 4817 */
  port?: number;
  /** 준비되면 브라우저를 연다. 기본 true (`--no-open`으로 끈다) */
  open?: boolean;
  /** `next dev`로 띄운다 (사전 빌드 불필요). 기본은 `next start` */
  dev?: boolean;
  /** 대상 루트. 전역 `--target`. 없으면 cwd에서 위로 탐색 */
  target?: string;
}

export interface UiDeps {
  /** 홈 폴더. 기본 `os.homedir()`. 테스트가 바꾼다 */
  home?: string;
  /** 설정 탐색 시작점. 기본 `process.cwd()` */
  cwd?: string;
  /** `apps/ui` 위치. 기본 {@link resolveUiDir} */
  uiDir?: string;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  now?: () => Date;
  /** 브라우저 열기. 기본 {@link openBrowser}. 실패해도 무시한다 */
  openBrowser?: (url: string) => void;
  /** 자식의 "Ready" 출력이 없을 때 포트 열림을 확인하는 주기 (ms) */
  pollIntervalMs?: number;
}

export interface UiHandle {
  info: UiRunInfo;
  /** `ui.json`의 절대 경로 */
  infoPath: string;
  /** 브라우저에 넘기는 주소 — `http://127.0.0.1:<port>/auth?token=<T>` */
  url: string;
  child: ChildProcess;
  /** 자식이 "Ready"를 찍거나 포트가 열리면. 그 전에 자식이 죽으면 거부 */
  ready: Promise<void>;
  /** 자식의 종료 코드 (시그널로 죽으면 1) */
  exited: Promise<number>;
  /** 자식 종료 + `ui.json` 삭제. 여러 번 불러도 된다 */
  close(): Promise<void>;
}

/** `next build`가 없어 `next start`를 띄울 수 없다 */
export class UiNotBuiltError extends Error {
  override readonly name = 'UiNotBuiltError';
  constructor(readonly uiDir: string) {
    super(
      `${uiDir}에 빌드 결과(.next/BUILD_ID)가 없다. 먼저 \`pnpm --filter @plumb/ui build\`를 돌리거나, 개발 중이면 \`plumb ui --dev\`로 띄운다`,
    );
  }
}

/** `apps/ui` 위치. 이 파일은 `packages/core/{src,dist}/cli/commands/` 아래이므로 다섯 단계 위가 레포 루트다 */
export function resolveUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..', 'apps', 'ui');
}

/** `~/.plumb/run/<project>/` — 토큰 파일이 사는 곳. `project`는 저장소와 같은 규칙(대상 루트 폴더 이름) */
export function uiRunDir(project: string, home: string = homedir()): string {
  return join(home, '.plumb', 'run', project);
}

export function generateToken(): string {
  return randomBytes(UI_TOKEN_BYTES).toString('hex');
}

export function authUrl(port: number, token: string): string {
  return `http://${UI_HOST}:${port}/auth?token=${token}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 폴더 0700 · 파일 0600. 파일이 이미 있으면 `writeFile`의 mode가 적용되지 않으므로 chmod를 한 번 더 한다 */
export async function writeUiRunInfo(path: string, info: UiRunInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

/** 플랫폼별 브라우저 열기. 실패(명령 없음 등)는 무시한다 — 주소는 이미 stdout에 있다 */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 무시 — 주소는 stdout에 있다
  }
}

/** 포트에 TCP 연결이 되는가 */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: UI_HOST, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolvePort(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/**
 * 토큰 생성 → `ui.json` → `apps/ui` 자식 프로세스. 돌려주는 핸들로 준비·종료를 기다리거나 닫는다.
 * 설정 오류({@link ConfigError})와 빌드 없음({@link UiNotBuiltError})은 그대로 던진다.
 */
export async function startUi(options: UiOptions = {}, deps: UiDeps = {}): Promise<UiHandle> {
  const port = options.port ?? DEFAULT_UI_PORT;
  const stdout = deps.stdout ?? process.stdout;
  const now = deps.now ?? (() => new Date());
  const uiDir = deps.uiDir ?? resolveUiDir();

  const { config, root } = await loadConfig({
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
  });
  const target = resolve(root);
  const project = basename(target);

  if (!options.dev && !(await exists(join(uiDir, '.next', 'BUILD_ID')))) {
    throw new UiNotBuiltError(uiDir);
  }

  const token = generateToken();
  const info: UiRunInfo = { port, token, pid: process.pid, startedAt: now().toISOString(), target };
  const infoPath = join(uiRunDir(project, deps.home), UI_RUN_FILE);
  await writeUiRunInfo(infoPath, info);

  const require = createRequire(join(uiDir, 'package.json'));
  const nextBin = require.resolve('next/dist/bin/next');
  const args = [nextBin, options.dev ? 'dev' : 'start', '-H', UI_HOST, '-p', String(port)];
  const child = spawn(process.execPath, args, {
    cwd: uiDir,
    env: {
      ...process.env,
      PLUMB_UI_TOKEN: token,
      PLUMB_UI_PORT: String(port),
      PLUMB_TARGET: target,
      PLUMB_STORE: resolveStoreRoot(config, target, deps.home === undefined ? {} : { home: deps.home }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const childExit = new Promise<number>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code ?? 1));
    child.once('error', () => resolveExit(1));
  });
  /** 자식이 끝나면 `ui.json`을 지운 뒤에 결정된다 — 서버가 없는데 토큰 파일이 남지 않게 */
  const exited = childExit.then(async (code) => {
    await rm(infoPath, { force: true });
    return code;
  });

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    let settled = false;
    const poll = setInterval(() => {
      if (settled) return;
      portOpen(port).then((open) => {
        if (open) settle();
      });
    }, deps.pollIntervalMs ?? 500);
    poll.unref();
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolveReady();
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout.write(text);
      if (/\bReady\b/.test(text)) settle();
    });
    childExit.then((code) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      rejectReady(new Error(`UI 서버가 준비되기 전에 끝났다 (exit ${code})`));
    });
  });

  const url = authUrl(port, token);
  const open = deps.openBrowser ?? openBrowser;
  ready
    .then(() => {
      stdout.write(`\n승인 화면: ${url}\n(토큰 파일 ${infoPath}, 0600 — 브라우저에만 넘긴다)\n`);
      if (options.open !== false) open(url);
    })
    .catch(() => {});

  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await rm(infoPath, { force: true });
  };

  return { info, infoPath, url, child, ready, exited, close };
}

export interface RegisterUiCommandOptions extends UiDeps {
  /** 끝날 때 부른다. 기본 `process.exit` */
  exit?: (code: number) => void;
}

/** `plumb ui [--port <n>] [--no-open] [--dev]`를 `program`에 단다. 전역 `--target`은 부모에서 읽는다 */
export function registerUiCommand(program: Command, options: RegisterUiCommandOptions = {}): Command {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const stderr = options.stderr ?? process.stderr;

  return program
    .command('ui')
    .description('로컬 UI 서버를 띄운다 (127.0.0.1, 일회용 토큰 → 브라우저)')
    .option(
      '--port <n>',
      `포트 (기본 ${DEFAULT_UI_PORT})`,
      (value: string) => Number.parseInt(value, 10),
      DEFAULT_UI_PORT,
    )
    .option('--no-open', '브라우저를 열지 않는다')
    .option('--dev', 'next dev로 띄운다 (사전 빌드 불필요)')
    .action(async (opts: { port: number; open: boolean; dev?: boolean }, command: Command) => {
      const target = (command.optsWithGlobals() as { target?: string }).target;
      let handle: UiHandle;
      try {
        handle = await startUi({ port: opts.port, open: opts.open, dev: opts.dev === true, target }, options);
      } catch (error) {
        if (error instanceof ConfigError || error instanceof UiNotBuiltError) {
          stderr.write(`plumb ui: ${error.message}\n`);
          exit(1);
          return;
        }
        throw error;
      }

      const stop = () => {
        handle.close().then(() => exit(130));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      const code = await handle.exited;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await handle.close();
      exit(code);
    });
}
