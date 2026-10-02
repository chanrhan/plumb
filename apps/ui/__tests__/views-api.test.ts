/**
 * 이슈 #60 "완료 증거": 임시 저장소를 `PLUMB_TARGET`으로 두고 route handler 함수를 직접 부른다.
 * `GET /api/views/:name` 404 두 종류(모르는 이름 · 아직 없음) → 코어 API로 View 하나 기록 → 200 모양(머리말 · markdown · data · 열람 수) →
 * `POST /api/open` 400(이유 없음) / 200(IDE 없음 → `failed`지만 `code-opens.jsonl` 한 줄, 열람 수 1) → `POST /api/views/regenerate`
 * (`spawn` 모킹: 진행 중 409 · 끝나면 200 결과 요약 · 모르는 이름 404). 인증(401)은 #33 미들웨어의 몫이라 여기 없다.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApiError,
  type CodeOpenResponse,
  loadConfig,
  makeHeader,
  openStore,
  type Store,
  source,
  type View,
  type ViewResponse,
} from '@plumb/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** `plumb views`를 띄우는 spawn만 가짜로. 다른 spawn(IDE 명령 · git)은 진짜 */
const fake = vi.hoisted(() => ({
  /** 가짜 자식을 만든다. 테스트가 바꾼다 — 없으면 바로 JSON을 쓰고 0으로 끝난다 */
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
      if (Array.isArray(args) && args.includes('views') && args.includes('--json')) {
        fake.calls.push(args);
        const make = fake.next ?? defaultFakeChild;
        return make();
      }
      return actual.spawn(command, args, options as never);
    },
  };
});

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

const FAKE_RESULT = {
  commit: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  views: [
    {
      name: 'architecture',
      ok: true,
      generatedAt: '2026-10-02T09:00:00.000Z',
      sources: 2,
      files: { json: 'x.json', md: 'x.md' },
    },
    { name: 'changelog', skipped: 'not-implemented' },
  ],
  exitCode: 0,
};

function defaultFakeChild(): FakeChild {
  const child = makeFakeChild();
  setTimeout(() => {
    child.stdout.emit('data', JSON.stringify(FAKE_RESULT));
    child.emit('exit', 0);
  }, 5);
  return child;
}

const ROLE = { model: 'test-model', maxTurns: 1, maxBudgetUsd: 0 };
/** 어디에도 없는 IDE 명령 — 기록은 `failed`로 남아야 한다 */
const MISSING_IDE = 'plumb-no-such-ide-xyz --goto {file}:{line}';

const ARCH_MARKDOWN = [
  '# 아키텍처',
  '',
  '```mermaid',
  'flowchart LR',
  '  payment --> auth',
  '```',
  '',
  '| 블록 | 근거 |',
  '|---|---|',
  '| payment | [src/domains/payment/index.ts:1](plumb://open?file=src%2Fdomains%2Fpayment%2Findex.ts&line=1) |',
  '',
].join('\n');

let dir: string;
let store: Store;
let routes: {
  view: typeof import('@/app/api/views/[name]/route');
  regenerate: typeof import('@/app/api/views/regenerate/route');
  open: typeof import('@/app/api/open/route');
};

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const get = (path: string) => new NextRequest(`http://127.0.0.1:4817${path}`);
const post = (path: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:4817${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-ui-views-'));
  await writeFile(
    join(dir, 'plumb.config.json'),
    JSON.stringify({
      service: '.',
      adapter: 'nextjs',
      store: '.plumb-store',
      ide: MISSING_IDE,
      roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
      stopBlockLimit: 3,
      blocks: { payment: { include: ['src/domains/payment/**'], risk: 'high' } },
    }),
  );
  process.env.PLUMB_TARGET = dir;
  const { config, root } = await loadConfig({ target: dir });
  store = openStore(config, root);
  await store.init();

  routes = {
    view: await import('@/app/api/views/[name]/route'),
    regenerate: await import('@/app/api/views/regenerate/route'),
    open: await import('@/app/api/open/route'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/views/:name', () => {
  it('모르는 이름 → 404 unknown-view', async () => {
    const res = await routes.view.GET(get('/api/views/nope'), ctx('nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404, code: 'view-not-found', reason: 'unknown-view' });
  });

  it('여섯 이름이지만 아직 생성 안 됨 → 404 not-generated', async () => {
    const res = await routes.view.GET(get('/api/views/architecture'), ctx('architecture'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      status: 404,
      code: 'view-not-found',
      reason: 'not-generated',
      message: 'architecture View 아직 없음. plumb views로 만드세요',
    });
  });

  it('코어 API로 View를 쓰면 200: header · markdown(```mermaid 포함) · data · codeOpens 0 · (git 없음 → stale 없음)', async () => {
    const view = {
      header: makeHeader('architecture', {
        commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        now: new Date('2026-10-01T09:00:00.000Z'), // 지금보다 과거 — 열람 수는 생성 시각 이후만 센다
        sources: [
          source.parser('dependency-cruiser', '18.5.0', 'src'),
          source.git('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
        ],
      }),
      tool: { name: 'dependency-cruiser', version: '18.5.0' },
      blocks: [],
    } as unknown as View;
    await store.views.write('architecture', view, ARCH_MARKDOWN);

    const res = await routes.view.GET(get('/api/views/architecture'), ctx('architecture'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ViewResponse;
    expect(body.header).toEqual(view.header);
    expect(body.markdown).toContain('```mermaid');
    expect(body.markdown).toContain('plumb://open?file=src%2Fdomains%2Fpayment%2Findex.ts&line=1');
    expect(body.markdown.startsWith('---')).toBe(false); // front matter는 header로, 본문만
    expect(body.data).toMatchObject({ tool: { name: 'dependency-cruiser' } });
    expect(body.codeOpens).toBe(0);
    // 임시 폴더는 git 저장소가 아니다 → HEAD 없음 → 오래됨 비교 없음
    expect(body.stale).toBeUndefined();
  });
});

describe('POST /api/open', () => {
  it('이유 없음 → 400 reason-required, 기록 없음', async () => {
    const res = await routes.open.POST(
      post('/api/open', { view: 'architecture', item: 'x', file: 'src/a.ts', line: 1 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400, code: 'reason-required' });

    const bad = await routes.open.POST(post('/api/open', { file: 'src/a.ts', reason: 'curious' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiError).code).toBe('reason-required');

    const noFile = await routes.open.POST(post('/api/open', { reason: 'missing-info' }));
    expect(noFile.status).toBe(400);
    expect(((await noFile.json()) as ApiError).code).toBe('invalid-body');

    await expect(readFile(join(dir, '.plumb-store', 'code-opens.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('이유 있음 → IDE 명령이 없어도 200, 기록은 failed 한 줄, 열람 수 1', async () => {
    const res = await routes.open.POST(
      post('/api/open', {
        view: 'architecture',
        item: 'payment',
        file: 'src/domains/payment/index.ts',
        line: 1,
        reason: 'missing-info',
        note: '경계 확인',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CodeOpenResponse;
    expect(body.record).toMatchObject({
      view: 'architecture',
      item: 'payment',
      file: 'src/domains/payment/index.ts',
      line: 1,
      reason: 'missing-info',
      note: '경계 확인',
      viewCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      result: {
        status: 'failed',
        command: 'plumb-no-such-ide-xyz --goto src/domains/payment/index.ts:1',
        error: '명령을 찾을 수 없다: plumb-no-such-ide-xyz',
      },
    });
    expect(body.codeOpens).toBe(1);

    const lines = (await readFile(join(dir, '.plumb-store', 'code-opens.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual(body.record);

    const again = (await (
      await routes.view.GET(get('/api/views/architecture'), ctx('architecture'))
    ).json()) as ViewResponse;
    expect(again.codeOpens).toBe(1);
  });
});

describe('POST /api/views/regenerate', () => {
  it('모르는 이름 → 404, 본문이 JSON이 아니면 400', async () => {
    const res = await routes.regenerate.POST(post('/api/views/regenerate', { names: ['architecture', 'nope'] }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).code).toBe('view-not-found');
    const bad = await routes.regenerate.POST(post('/api/views/regenerate', '{not json'));
    expect(bad.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('진행 중이면 409, 끝나면 200 결과 요약 (plumb views --json을 spawn)', async () => {
    let finish: (() => void) | null = null;
    fake.next = () => {
      const child = makeFakeChild();
      finish = () => {
        child.stdout.emit('data', JSON.stringify(FAKE_RESULT));
        child.emit('exit', 0);
      };
      return child;
    };

    const first = routes.regenerate.POST(post('/api/views/regenerate', { names: ['architecture'] }));
    await new Promise((r) => setTimeout(r, 10));
    const second = await routes.regenerate.POST(post('/api/views/regenerate', {}));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ status: 409, code: 'regenerate-in-progress' });

    expect(finish).not.toBeNull();
    (finish as unknown as () => void)();
    const res = await first;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, names: ['architecture'], ...FAKE_RESULT });

    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0] ?? [];
    expect(args[0]).toMatch(/[\\/]cli[\\/]index\.js$/);
    expect(args.slice(1)).toEqual(['--target', dir, 'views', 'architecture', '--json']);
    fake.next = null;
  });

  it('끝난 뒤에는 다시 돌릴 수 있다 (비우면 전부)', async () => {
    const res = await routes.regenerate.POST(post('/api/views/regenerate', ''));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { names: string[] }).names).toEqual([]);
    expect(fake.calls[1]?.slice(1)).toEqual(['--target', dir, 'views', '--json']);
  });
});
