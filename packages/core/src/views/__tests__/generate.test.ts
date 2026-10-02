/**
 * `generateViews` (이슈 #60). 가짜 생성기 둘 중 하나가 던져도 나머지는 기록되고, 등록되지 않은 이름은 `skipped: 'not-implemented'`.
 * 어댑터는 쓰지 않는다 — 가짜 생성기가 `ctx.commit` · `ctx.now`만 본다.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../../adapter/types.js';
import { openStore, type Store } from '../../store/index.js';
import type { ArchitectureView, PlumbConfig, VerificationView, View, ViewName } from '../../types/index.js';
import { formatSummary, generateViews, orderViewNames, summarizeResults } from '../generate.js';
import { makeHeader, source } from '../header.js';
import type { ViewGeneratorMap } from '../registry.js';
import type { ViewContext, ViewGenerator } from '../types.js';

const ROLE = { model: 'default', maxTurns: 1, maxBudgetUsd: 0 };
const CONFIG: PlumbConfig = {
  service: '.',
  store: './.plumb-store',
  adapter: 'nextjs',
  roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
  stopBlockLimit: 5,
};
const NOW = new Date('2026-10-02T09:00:00.000Z');
const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

/** 어댑터를 부르면 실패 — 가짜 생성기는 어댑터를 쓰지 않는다 */
const NEVER_ADAPTER = new Proxy({} as Adapter, {
  get(_target, prop) {
    if (prop === 'name') return 'nextjs';
    throw new Error(`어댑터 ${String(prop)}를 부르면 안 된다`);
  },
});

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-generate-'));
  store = openStore(CONFIG, dir, { now: () => NOW });
  await store.init();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function ctxFor(): ViewContext {
  return { root: dir, config: CONFIG, store, adapter: NEVER_ADAPTER, commit: COMMIT, now: () => NOW };
}

function architectureFake(): ViewGenerator<ArchitectureView> {
  return {
    name: 'architecture',
    async generate(ctx) {
      return {
        header: makeHeader('architecture', {
          commit: ctx.commit,
          now: ctx.now(),
          sources: [source.parser('dependency-cruiser', '18.5', 'src')],
        }),
        tool: { name: 'dependency-cruiser', version: '18.5' },
        blocks: [],
        edges: [],
        infraEdges: [],
        undetectedInfra: [],
        unclassified: [],
        requiredChecks: { publicEntryOnly: 'unchecked', noCycles: 'unchecked', declaredDirection: 'unchecked' },
      } as unknown as ArchitectureView;
    },
    render: (view) => `# 아키텍처\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n블록 ${view.blocks.length}개\n`,
  };
}

function throwingVerification(): ViewGenerator<VerificationView> {
  return {
    name: 'verification',
    async generate() {
      throw new Error('JUnit 없음');
    },
    render: () => '',
  };
}

const generators = (...list: ViewGenerator<View>[]): ViewGeneratorMap =>
  Object.fromEntries(list.map((g) => [g.name, g])) as ViewGeneratorMap;

describe('generateViews', () => {
  it('가짜 생성기 둘 중 하나가 던져도 나머지는 기록되고, 미등록 이름은 skipped', async () => {
    const results = await generateViews(ctxFor(), undefined, {
      generators: generators(architectureFake() as ViewGenerator<View>, throwingVerification() as ViewGenerator<View>),
    });

    // 탭 순서
    expect(results.map((r) => r.name)).toEqual([
      'architecture',
      'flow',
      'changelog',
      'verification',
      'dependencies',
      'contract',
    ]);

    const arch = results[0];
    expect(arch).toMatchObject({
      name: 'architecture',
      ok: true,
      generatedAt: NOW.toISOString(),
      commit: COMMIT,
      sources: 1,
      files: { json: store.paths.view('architecture', 'json'), md: store.paths.view('architecture', 'md') },
    });

    const verification = results.find((r) => r.name === 'verification');
    expect(verification).toMatchObject({ name: 'verification', ok: false, stage: 'generate' });
    expect((verification as { error: string }).error).toContain('JUnit 없음');
    expect((verification as { cause: Error }).cause.name).toBe('ViewGenerationError');

    for (const name of ['flow', 'changelog', 'dependencies', 'contract'] as const) {
      expect(results.find((r) => r.name === name)).toEqual({ name, skipped: 'not-implemented' });
    }

    // 파일: 성공한 View만 .json + .md
    expect((await readdir(store.paths.viewsDir)).sort()).toEqual(['architecture.json', 'architecture.md']);
    const stored = await store.views.read('architecture');
    expect(stored?.markdown).toContain('```mermaid');
    expect(await store.views.read('verification')).toBeNull();

    expect(summarizeResults(results)).toEqual({ generated: 1, failed: 1, notImplemented: 4 });
    expect(formatSummary(results)).toBe('View 갱신: 1 생성 · 1 실패 · 4 아직 없음');
  });

  it('이름을 주면 그것만, 탭 순서로. 중복은 하나로', async () => {
    const results = await generateViews(ctxFor(), ['verification', 'architecture', 'architecture'], {
      generators: generators(architectureFake() as ViewGenerator<View>),
    });
    expect(results.map((r) => r.name)).toEqual(['architecture', 'verification']);
    expect(results[1]).toEqual({ name: 'verification', skipped: 'not-implemented' });
    expect(orderViewNames(['contract', 'flow'])).toEqual(['flow', 'contract']);
  });

  it('render가 던지면 stage render, write가 거부하면(머리말 이름 불일치) stage write — 둘 다 파일 없음', async () => {
    const badRender: ViewGenerator<View> = {
      name: 'dependencies',
      generate: async (ctx) =>
        ({ header: makeHeader('dependencies', { now: ctx.now(), sources: [] }) }) as unknown as View,
      render: () => {
        throw new Error('표를 그릴 수 없다');
      },
    };
    const badWrite: ViewGenerator<View> = {
      name: 'contract',
      // 머리말이 다른 View 이름 → store.views.write가 ValidationError
      generate: async (ctx) => ({ header: makeHeader('flow', { now: ctx.now(), sources: [] }) }) as unknown as View,
      render: () => '# 계약',
    };
    const results = await generateViews(ctxFor(), ['dependencies', 'contract'], {
      generators: generators(badRender, badWrite),
    });
    expect(results[0]).toMatchObject({ name: 'dependencies', ok: false, stage: 'render' });
    expect(results[1]).toMatchObject({ name: 'contract', ok: false, stage: 'write' });
    expect(await readdir(store.paths.viewsDir)).toEqual([]);
  });

  it('테스트 러너를 돌리는 생성기는 병렬 묶음이 끝난 뒤 순차로 돈다', async () => {
    const order: string[] = [];
    const slow = (name: ViewName, ms: number): ViewGenerator<View> => ({
      name,
      async generate(ctx) {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
        return { header: makeHeader(name, { now: ctx.now(), sources: [] }) } as unknown as View;
      },
      render: () => `# ${name}`,
    });
    const results = await generateViews(ctxFor(), ['architecture', 'flow', 'contract'], {
      generators: generators(slow('architecture', 30), slow('flow', 5), slow('contract', 10)),
      sequential: new Set<ViewName>(['flow']),
    });
    expect(results.every((r) => 'ok' in r && r.ok)).toBe(true);
    // architecture · contract는 겹쳐 돌고(둘 다 시작한 뒤 끝난다), flow는 둘이 끝난 뒤에 시작한다
    expect(order.slice(0, 2)).toEqual(['architecture:start', 'contract:start']);
    expect(order.indexOf('flow:start')).toBeGreaterThan(order.indexOf('architecture:end'));
    expect(order.indexOf('flow:start')).toBeGreaterThan(order.indexOf('contract:end'));
  });

  it('commit이 없으면 머리말에도 없고 결과에도 없다', async () => {
    const ctx = { ...ctxFor(), commit: undefined };
    const [result] = await generateViews(ctx, ['architecture'], {
      generators: generators(architectureFake() as ViewGenerator<View>),
    });
    expect(result).not.toHaveProperty('commit');
    const stored = await store.views.read('architecture');
    expect(stored?.view.header).not.toHaveProperty('commit');
  });
});
