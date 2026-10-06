/**
 * 이슈 #120 "완료 증거" (ui): 임시 저장소를 `PLUMB_TARGET`으로 두고 route handler 함수를 직접 부른다.
 * 401(미들웨어 — GET · POST 둘 다) → 빈 목록 `{ items: [], open: 0 }` → 코어 API로 올린 항목(r-0001의 이의 제기 1건 + 실행 실패 1건)이
 * 목록에 생성 순으로 · `open` 2 → resolve 404(꼴 아님 · 없는 id) · 400(본문 오류) → 200 `{ item.resolvedAt }` · `open` 1 ·
 * `status().reviewQueue` 1 감소(상단 `⚠`) → 같은 항목 다시 → 409 `review-item-resolved` + 이미 처리된 항목 → `plumb run`이 올린 모양(`resolvedAt` 없음)은 그대로.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApiError,
  loadConfig,
  openStore,
  type ResolveReviewItemResponse,
  type ReviewQueueResponse,
  type Store,
  toStatusResponse,
} from '@plumb/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE } from '@/lib/auth';
import { middleware } from '@/middleware';

const ROLE = { model: 'test-model', maxTurns: 1, maxBudgetUsd: 0 };

let dir: string;
let store: Store;
let routes: {
  list: typeof import('@/app/api/queue/route');
  resolve: typeof import('@/app/api/queue/[id]/resolve/route');
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new NextRequest(`http://127.0.0.1:4817${path}`);
const post = (path: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:4817${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-ui-queue-'));
  await writeFile(
    join(dir, 'plumb.config.json'),
    JSON.stringify({
      service: '.',
      adapter: 'nextjs',
      store: '.plumb-store',
      roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
      stopBlockLimit: 3,
    }),
  );
  process.env.PLUMB_TARGET = dir;
  const { config, root } = await loadConfig({ target: dir });
  store = openStore(config, root);
  await store.init();

  routes = {
    list: await import('@/app/api/queue/route'),
    resolve: await import('@/app/api/queue/[id]/resolve/route'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('토큰 쿠키 없음 → 401 (미들웨어, approve route와 같은 보호)', () => {
  it('GET /api/queue · POST /api/queue/:id/resolve 전부 401 UNAUTHORIZED', async () => {
    process.env.PLUMB_UI_TOKEN = 'a'.repeat(64);
    try {
      for (const req of [get('/api/queue'), post('/api/queue/q-0001/resolve', {})]) {
        const res = await middleware(req);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      }
      const wrong = new NextRequest('http://127.0.0.1:4817/api/queue/q-0001/resolve', {
        method: 'POST',
        headers: { cookie: `${COOKIE}=${'b'.repeat(64)}` },
      });
      expect((await middleware(wrong)).status).toBe(401);
    } finally {
      delete process.env.PLUMB_UI_TOKEN;
    }
  });
});

describe('GET /api/queue', () => {
  it('review-queue/ 비어 있으면 { items: [], open: 0 }', async () => {
    const res = await routes.list.GET();
    expect(res.status).toBe(200);
    expect((await res.json()) as ReviewQueueResponse).toEqual({ items: [], open: 0 });
  });

  it('코어가 올린 항목(r-0001의 이의 제기 · r-0002의 실행 실패)이 생성 순으로, open 2, 상단 ⚠ 2', async () => {
    await store.reviewQueue.enqueue({
      kind: 'dispute',
      ruleIds: ['pay.refund-window'],
      runId: 'r-0001',
      summary: 'refund-window.property.spec.ts 의 경계값(7일 정각)이 규칙과 다름',
      createdAt: '2026-10-02T05:10:00.000Z',
    });
    await store.reviewQueue.enqueue({
      kind: 'run-failed',
      ruleIds: ['pay.refund-window'],
      runId: 'r-0002',
      summary: '실행 실패: stopBlockLimit',
      createdAt: '2026-10-02T06:00:00.000Z',
    });
    const body = (await (await routes.list.GET()).json()) as ReviewQueueResponse;
    expect(body.open).toBe(2);
    expect(body.items.map((item) => [item.id, item.kind, item.runId, item.resolvedAt])).toEqual([
      ['q-0001', 'dispute', 'r-0001', undefined],
      ['q-0002', 'run-failed', 'r-0002', undefined],
    ]);
    expect(toStatusResponse(await store.status()).unconfirmed).toEqual({
      total: 2,
      provisionalRules: 0,
      reviewQueue: 2,
    });
  });
});

describe('POST /api/queue/:id/resolve', () => {
  it('ID 꼴이 아니거나 없는 항목 → 404 review-item-not-found', async () => {
    for (const id of ['q-9999', 'nope', '../etc']) {
      const res = await routes.resolve.POST(post(`/api/queue/${encodeURIComponent(id)}/resolve`, {}), ctx(id));
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiError).code).toBe('review-item-not-found');
    }
  });

  it('본문 오류 → 400 invalid-body, 아무것도 처리하지 않는다', async () => {
    for (const body of ['{not json', [], { by: '' }, { by: 1 }, { note: 1 }]) {
      const res = await routes.resolve.POST(post('/api/queue/q-0001/resolve', body), ctx('q-0001'));
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).code).toBe('invalid-body');
    }
    expect(((await (await routes.list.GET()).json()) as ReviewQueueResponse).open).toBe(2);
  });

  it('[처리] → 200 { item.resolvedAt }, 목록 open 1, 상단 ⚠ 가 1 준다', async () => {
    const before = toStatusResponse(await store.status()).unconfirmed.total;
    const res = await routes.resolve.POST(post('/api/queue/q-0001/resolve', { note: '테스트가 맞다' }), ctx('q-0001'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResolveReviewItemResponse;
    expect(body.item.id).toBe('q-0001');
    expect(body.item.kind).toBe('dispute');
    expect(body.item.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const list = (await (await routes.list.GET()).json()) as ReviewQueueResponse;
    expect(list.open).toBe(1);
    expect(list.items.map((item) => [item.id, item.resolvedAt !== undefined])).toEqual([
      ['q-0001', true],
      ['q-0002', false],
    ]);
    // 파일에 남았다 · 상단 바 ⚠
    expect((await store.reviewQueue.get('q-0001'))?.resolvedAt).toBe(body.item.resolvedAt);
    expect(toStatusResponse(await store.status()).unconfirmed.total).toBe(before - 1);
  });

  it('이미 처리된 항목 → 409 review-item-resolved + 처리된 항목 그대로, 첫 resolvedAt 유지', async () => {
    const first = (await store.reviewQueue.get('q-0001'))?.resolvedAt;
    const res = await routes.resolve.POST(post('/api/queue/q-0001/resolve', {}), ctx('q-0001'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Extract<ApiError, { status: 409 }>;
    expect(body.code).toBe('review-item-resolved');
    expect(body.item).toMatchObject({ id: 'q-0001', resolvedAt: first });
    expect((await store.reviewQueue.get('q-0001'))?.resolvedAt).toBe(first);
  });

  it('빈 본문도 처리 요청이다 — q-0002 200, 이제 open 0', async () => {
    const req = new NextRequest('http://127.0.0.1:4817/api/queue/q-0002/resolve', { method: 'POST' });
    const res = await routes.resolve.POST(req, ctx('q-0002'));
    expect(res.status).toBe(200);
    expect(((await (await routes.list.GET()).json()) as ReviewQueueResponse).open).toBe(0);
    expect(toStatusResponse(await store.status()).unconfirmed.reviewQueue).toBe(0);
  });
});
