import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 자식 프로세스 흉내. `kill()`이 `exit`를 낸다 */
class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  killed = false;
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let child: FakeChild;

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    return child;
  },
}));

const { startUi, UI_RUN_FILE, UiNotBuiltError, authUrl, uiRunDir } = await import('../commands/ui.js');
const { createProgram } = await import('../program.js');

const VALID_CONFIG = {
  service: '.',
  store: './.plumb-store',
  adapter: 'nextjs',
  roles: {
    'test-writer': { model: 'model-a', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'model-a', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'model-a', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'model-a', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
};

let dir: string;
let home: string;
let target: string;
let uiDir: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-ui-'));
  home = join(dir, 'home');
  target = join(dir, 'testbed');
  uiDir = join(dir, 'apps-ui');
  await mkdir(home, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'plumb.config.json'), JSON.stringify(VALID_CONFIG));
  // `apps/ui` 흉내: package.json + next 바이너리 + 빌드 표식
  await mkdir(join(uiDir, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{"name":"fake-ui"}');
  await writeFile(join(uiDir, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"0.0.0"}');
  await writeFile(join(uiDir, 'node_modules', 'next', 'dist', 'bin', 'next'), '');
  await mkdir(join(uiDir, '.next'), { recursive: true });
  await writeFile(join(uiDir, '.next', 'BUILD_ID'), 'test');
  process.env.HOME = home;
  child = new FakeChild();
  spawnCalls.length = 0;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(dir, { recursive: true, force: true });
});

const quiet = { write: () => true };

describe('plumb ui — 토큰 파일', () => {
  it('~/.plumb/run/<project>/ui.json 을 만든다: 폴더 0700 · 파일 0600 · { port, token, pid, startedAt, target }', async () => {
    const now = new Date('2026-10-02T09:00:00.000Z');
    const handle = await startUi(
      { port: 4817, open: false, target },
      { uiDir, stdout: quiet, now: () => now, pollIntervalMs: 60_000 },
    );

    expect(handle.infoPath).toBe(join(home, '.plumb', 'run', 'testbed', UI_RUN_FILE));
    expect(handle.infoPath).toBe(join(uiRunDir('testbed'), UI_RUN_FILE));

    const fileMode = (await stat(handle.infoPath)).mode & 0o777;
    const dirMode = (await stat(join(home, '.plumb', 'run', 'testbed'))).mode & 0o777;
    expect(fileMode.toString(8)).toBe('600');
    expect(dirMode.toString(8)).toBe('700');

    const written = JSON.parse(await readFile(handle.infoPath, 'utf8'));
    expect(written).toEqual({
      port: 4817,
      token: handle.info.token,
      pid: process.pid,
      startedAt: '2026-10-02T09:00:00.000Z',
      target,
    });
    expect(handle.info.token).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.url).toBe(authUrl(4817, handle.info.token));
    expect(handle.url).toBe(`http://127.0.0.1:4817/auth?token=${handle.info.token}`);

    await handle.close();
  });

  it('부를 때마다 토큰이 다르다 (일회용)', async () => {
    const first = await startUi({ open: false, target }, { uiDir, stdout: quiet, pollIntervalMs: 60_000 });
    await first.close();
    child = new FakeChild();
    const second = await startUi({ open: false, target }, { uiDir, stdout: quiet, pollIntervalMs: 60_000 });
    await second.close();

    expect(first.info.token).not.toBe(second.info.token);
  });

  it('close() 는 자식에 SIGTERM 을 보내고 ui.json 을 지운다', async () => {
    const handle = await startUi({ open: false, target }, { uiDir, stdout: quiet, pollIntervalMs: 60_000 });

    await handle.close();

    expect(child.killed).toBe(true);
    await expect(stat(handle.infoPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await handle.exited).toBe(1);
  });
});

describe('plumb ui — 자식 프로세스', () => {
  it('next start -H 127.0.0.1 -p <port> 를 apps/ui 에서 띄우고 토큰은 환경변수로만 넘긴다', async () => {
    const handle = await startUi({ port: 5000, open: false, target }, { uiDir, stdout: quiet, pollIntervalMs: 60_000 });

    expect(spawnCalls).toHaveLength(1);
    const [call] = spawnCalls;
    expect(call.command).toBe(process.execPath);
    expect(call.args.slice(1)).toEqual(['start', '-H', '127.0.0.1', '-p', '5000']);
    expect(call.args[0]).toBe(join(uiDir, 'node_modules', 'next', 'dist', 'bin', 'next'));
    expect(call.options.cwd).toBe(uiDir);
    const env = call.options.env as Record<string, string>;
    expect(env.PLUMB_UI_TOKEN).toBe(handle.info.token);
    expect(env.PLUMB_UI_PORT).toBe('5000');
    expect(env.PLUMB_TARGET).toBe(target);
    expect(env.PLUMB_STORE).toBe(join(target, '.plumb-store'));
    // 토큰은 명령줄 인자에 없다 (ps 로 보이면 안 된다)
    expect(call.args.join(' ')).not.toContain(handle.info.token);

    await handle.close();
  });

  it('--dev 면 next dev', async () => {
    const handle = await startUi({ open: false, dev: true, target }, { uiDir, stdout: quiet, pollIntervalMs: 60_000 });
    expect(spawnCalls[0].args.slice(1)).toEqual(['dev', '-H', '127.0.0.1', '-p', '4817']);
    await handle.close();
  });

  it('빌드 결과가 없으면 UiNotBuiltError, 토큰 파일도 만들지 않는다', async () => {
    await rm(join(uiDir, '.next'), { recursive: true });

    const error = await startUi({ open: false, target }, { uiDir, stdout: quiet }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UiNotBuiltError);
    expect((error as Error).message).toContain('pnpm --filter @plumb/ui build');
    await expect(stat(join(home, '.plumb', 'run', 'testbed', UI_RUN_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('stdout 에 "Ready" 가 나오면 승인 주소를 출력하고 브라우저를 연다 (--no-open 이면 열지 않는다)', async () => {
    const out: string[] = [];
    const opened: string[] = [];
    const handle = await startUi(
      { open: true, target },
      {
        uiDir,
        stdout: { write: (s: string) => out.push(s) },
        openBrowser: (url) => opened.push(url),
        pollIntervalMs: 60_000,
      },
    );

    child.stdout.emit('data', Buffer.from(' ✓ Ready in 300ms\n'));
    await handle.ready;
    await new Promise((r) => setImmediate(r));

    expect(opened).toEqual([handle.url]);
    expect(out.join('')).toContain(`승인 화면: ${handle.url}`);
    await handle.close();

    child = new FakeChild();
    opened.length = 0;
    const noOpen = await startUi(
      { open: false, target },
      { uiDir, stdout: quiet, openBrowser: (url) => opened.push(url), pollIntervalMs: 60_000 },
    );
    child.stdout.emit('data', 'Ready');
    await noOpen.ready;
    await new Promise((r) => setImmediate(r));
    expect(opened).toEqual([]);
    await noOpen.close();
  });

  it('준비 전에 자식이 죽으면 ready 가 거부되고 ui.json 이 지워진다', async () => {
    const handle = await startUi({ open: false, target }, { uiDir, stdout: quiet, pollIntervalMs: 60_000 });

    child.emit('exit', 1, null);

    await expect(handle.ready).rejects.toThrow(/exit 1/);
    expect(await handle.exited).toBe(1);
    await expect(stat(handle.infoPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('plumb ui — 명령 연결', () => {
  it('--help 에 --port · --no-open · --dev 가 있고, 설정이 없으면 stderr + exit 1', async () => {
    const err: string[] = [];
    const exits: number[] = [];
    const program = createProgram({ exit: (code) => exits.push(code), stderr: { write: (s: string) => err.push(s) } })
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: (s) => err.push(s) });

    const ui = program.commands.find((c) => c.name() === 'ui');
    expect(ui).toBeDefined();
    const help = ui?.helpInformation() ?? '';
    expect(help).toContain('--port <n>');
    expect(help).toContain('--no-open');
    expect(help).toContain('--dev');

    const empty = join(dir, 'empty');
    await mkdir(empty);
    await program.parseAsync(['--target', empty, 'ui', '--no-open'], { from: 'user' });

    expect(exits).toEqual([1]);
    expect(err.join('')).toMatch(/^plumb ui: .*plumb\.config\.json/);
    expect(spawnCalls).toHaveLength(0);
  });
});
