/**
 * 이슈 #121 "완료 증거": `GET /api/blocks`.
 * ① 쿠키 없음 → 미들웨어 401 `UNAUTHORIZED`(matcher가 `/api/blocks`를 덮는다) ② 임시 저장소를 `PLUMB_TARGET`으로 두고 route handler를 직접 부른다 —
 * 아키텍처 View 없음 → `empty: 'no-graph'`(config 블록은 보이되 미분류 0은 측정 불가) → 규칙 · 상태 기록 · 아키텍처 View JSON(코어 API)을 쓰면
 * `payment 🟢 1 · auth ⬜ 0 · 미분류 2` 모양 → 규칙에만 있는 블록은 뒤에.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BlockNode,
  type BlocksResponse,
  loadConfig,
  makeHeader,
  openStore,
  type RuleStatusRecord,
  type Store,
  source,
  type View,
} from '@plumb/core';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE } from '@/lib/auth';
import { middleware, config as middlewareConfig } from '@/middleware';

const ROLE = { model: 'test-model', maxTurns: 1, maxBudgetUsd: 0 };
const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const CHECKED_AT = '2026-10-02T09:00:05.000Z';

function node(id: string, files: number): BlockNode {
  return {
    id,
    level: 'L1',
    kind: 'domain',
    paths: [`src/domains/${id}/**`],
    public: [`src/domains/${id}/index.ts`],
    files,
    declared: true,
  };
}

function statusRecord(ruleId: string, detail: RuleStatusRecord['detail']): RuleStatusRecord {
  return {
    ruleId: ruleId as RuleStatusRecord['ruleId'],
    detail,
    since: CHECKED_AT,
    commit: COMMIT,
    checkedAt: CHECKED_AT,
    history: [detail.status],
  };
}

let dir: string;
let store: Store;
let route: typeof import('@/app/api/blocks/route');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-ui-blocks-'));
  await writeFile(
    join(dir, 'plumb.config.json'),
    JSON.stringify({
      service: '.',
      adapter: 'nextjs',
      store: '.plumb-store',
      roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
      stopBlockLimit: 3,
      blocks: {
        payment: { include: ['src/domains/payment/**'], risk: 'high' },
        auth: { include: ['src/domains/auth/**'] },
      },
    }),
  );
  process.env.PLUMB_TARGET = dir;
  const { config, root } = await loadConfig({ target: dir });
  store = openStore(config, root);
  await store.init();
  route = await import('@/app/api/blocks/route');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/blocks — 인증', () => {
  it('쿠키 없음 → 401 UNAUTHORIZED (미들웨어, matcher가 /api/blocks를 덮는다)', async () => {
    process.env.PLUMB_UI_TOKEN = 'a'.repeat(64);
    try {
      expect(middlewareConfig.matcher).toContain('/api/:path*');
      const res = await middleware(new NextRequest('http://127.0.0.1:4817/api/blocks'));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });

      const wrong = new Headers();
      wrong.set('cookie', `${COOKIE}=${'0'.repeat(64)}`);
      const bad = await middleware(new NextRequest('http://127.0.0.1:4817/api/blocks', { headers: wrong }));
      expect(bad.status).toBe(401);
    } finally {
      delete process.env.PLUMB_UI_TOKEN;
    }
  });
});

describe('GET /api/blocks — 본문', () => {
  it('아키텍처 View 아직 없음 → 200 empty: no-graph. config 블록은 규칙 0 · null, 미분류는 0(측정 불가)', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as BlocksResponse;
    expect(body.empty).toBe('no-graph');
    expect(body.unclassified).toBe(0);
    expect(body.blocks.map((b) => [b.id, b.worstStatus, b.rules])).toEqual([
      ['payment', null, 0],
      ['auth', null, 0],
    ]);
  });

  it('규칙 · 상태 기록 · 아키텍처 View JSON을 쓰면(코어 API) payment 🟢 1 · auth ⬜ 0 · 미분류 2 · 규칙에만 있는 블록은 뒤에', async () => {
    await writeFile(
      store.paths.rules,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: 'pay.refund-window',
            block: 'payment',
            kind: 'business',
            statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
            source: 'plan:PAY-02',
            risk: 'high',
            checks: ['test/acceptance/refund-window.property.spec.ts'],
          },
          {
            id: 'ship.tracking',
            block: 'shipping',
            kind: 'technical',
            statement: 'THE SYSTEM SHALL 배송 추적 번호를 저장한다',
            source: 'plan:SHIP-01',
            risk: 'normal',
          },
        ],
      }),
    );
    await store.ruleStatus.write([
      statusRecord('pay.refund-window', { status: 'pass-verified', reason: 'static-proof' }),
      statusRecord('ship.tracking', {
        status: 'fail',
        failures: [
          {
            check: { kind: 'acceptance', ref: 'test/acceptance/tracking.spec.ts' },
            anchor: { file: 'test/acceptance/tracking.spec.ts', line: 12 },
            message: 'expected tracking number',
          },
        ],
      }),
    ]);
    const view = {
      header: makeHeader('architecture', {
        commit: COMMIT,
        now: new Date('2026-10-02T09:00:00.000Z'),
        sources: [source.parser('dependency-cruiser', '18.5.0', 'src')],
      }),
      tool: { name: 'dependency-cruiser', version: '18.5.0' },
      blocks: [node('payment', 4), node('auth', 2)],
      unclassified: ['src/misc/a.ts', 'src/misc/b.ts'],
    } as unknown as View;
    await store.views.write('architecture', view, '# 아키텍처\n');

    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as BlocksResponse;
    expect(body.empty).toBeUndefined();
    expect(body.unclassified).toBe(2);
    expect(body.blocks.map((b) => [b.id, b.worstStatus, b.rules])).toEqual([
      ['payment', 'pass-verified', 1],
      ['auth', null, 0],
      ['shipping', 'fail', 1],
    ]);
    expect(body.blocks[0]).toMatchObject({
      paths: ['src/domains/payment/**'],
      public: ['src/domains/payment/index.ts'],
      files: 4,
      declared: true,
      risk: 'high',
    });
    expect(body.blocks[2]).toMatchObject({ declared: false, files: 0, paths: [] });
  });

  it('View JSON은 있는데 Markdown이 없으면 500 — 반쪽을 그리지 않는다', async () => {
    await rm(store.paths.view('architecture', 'md'));
    const res = await route.GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 500, code: 'store-write-failed' });
  });
});
