/**
 * `extractDependencies()` 테스트 (#45).
 *
 * 1) 순수 함수(`foldModules` · `detectL0` · `infraEdgesOf`)를 합성 depcruise JSON으로 — 분류 순서 · 선언 · 공개 진입점 · 미분류 · 외부 패키지.
 * 2) `examples/testbed`를 **실제로** 돌린다 — dependency-cruiser를 spawn하고 결과를 명시적 기대값과 비교한다 (스냅샷 아님).
 *    그래프 JSON은 `examples/testbed/reports/block-graph.json`에 쓴다 (gitignore).
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AdapterContext, type BlockGraph, loadConfig, type PlumbConfig } from '@plumb/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DepcruiseJson,
  depcruiseVersion,
  detectL0,
  extractDependencies,
  foldModules,
  infraEdgesOf,
  infraKindOfImage,
  isReportFresh,
  packageNameOf,
  parseComposeServices,
} from '../extract-dependencies.js';
import { nextjsAdapter } from '../index.js';

const TESTBED = fileURLToPath(new URL('../../../../examples/testbed/', import.meta.url)).replace(/\/$/, '');

const baseConfig: PlumbConfig = {
  service: 'synthetic',
  adapter: 'nextjs',
  roles: {
    'test-writer': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    implementer: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    injector: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    'rule-drafter': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
  },
  stopBlockLimit: 3,
};

function mod(source: string, deps: Array<[resolved: string, specifier: string, types?: string[]]> = []) {
  return {
    source,
    dependencies: deps.map(([resolved, module, dependencyTypes]) => ({
      resolved,
      module,
      dependencyTypes: dependencyTypes ?? ['local', 'import'],
    })),
  };
}

const lineOf = () => 1;

// ---------------------------------------------------------------------------
// 1. 순수 함수
// ---------------------------------------------------------------------------

describe('foldModules — 파일 → 블록', () => {
  it('(1) include 글롭 > (2) src/domains/<d> > (3) src/app > (4) src/lib > (5) 미분류 순서로 분류한다', () => {
    const config: PlumbConfig = {
      ...baseConfig,
      blocks: { billing: { include: ['src/domains/payment/**', 'src/billing/**'] } },
    };
    const depcruise: DepcruiseJson = {
      modules: [
        mod('src/domains/payment/index.ts'), // (1) 글롭이 디렉토리 기본 규칙보다 먼저 → billing
        mod('src/billing/invoice.ts'), // (1)
        mod('src/domains/auth/index.ts'), // (2) 설정에 없는 도메인
        mod('src/app/page.tsx'), // (3)
        mod('src/lib/http.ts'), // (4)
        mod('src/legacy/old.ts'), // (5)
        mod('scripts/seed.ts'), // (5)
      ],
    };

    const { blocks, unclassified } = foldModules({ config, depcruise, lineOf });
    const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));

    expect(Object.keys(byId).sort()).toEqual(['app', 'auth', 'billing', 'lib']);
    expect(byId.billing).toMatchObject({
      level: 'L1',
      kind: 'domain',
      files: 2,
      declared: true,
      paths: ['src/domains/payment/**', 'src/billing/**'],
      public: ['src/domains/payment/index.ts', 'src/billing/index.ts'],
    });
    expect(byId.auth).toMatchObject({
      kind: 'domain',
      files: 1,
      declared: false,
      paths: ['src/domains/auth/**'],
      public: ['src/domains/auth/index.ts'],
    });
    expect(byId.app).toMatchObject({ kind: 'entry', files: 1, declared: false, public: [] });
    expect(byId.lib).toMatchObject({ kind: 'domain', shared: true, files: 1, public: ['src/lib/http.ts'] });
    expect(unclassified).toEqual(['scripts/seed.ts', 'src/legacy/old.ts']);
  });

  it('config.ignore 글롭은 미분류에서 뺀다. 미분류는 0개여도 배열이다', () => {
    const config: PlumbConfig = { ...baseConfig, ignore: ['scripts/**'] };
    const depcruise: DepcruiseJson = { modules: [mod('scripts/seed.ts'), mod('src/app/page.tsx')] };

    expect(foldModules({ config, depcruise, lineOf }).unclassified).toEqual([]);
  });

  it('config.blocks의 risk는 노드에 그대로 옮긴다', () => {
    const config: PlumbConfig = {
      ...baseConfig,
      blocks: { payment: { include: ['src/domains/payment/**'], risk: 'high' } },
    };
    const depcruise: DepcruiseJson = { modules: [mod('src/domains/payment/index.ts')] };

    const [payment] = foldModules({ config, depcruise, lineOf }).blocks;
    expect(payment).toMatchObject({ id: 'payment', risk: 'high', declared: true });
  });
});

describe('foldModules — 간선', () => {
  const config: PlumbConfig = {
    ...baseConfig,
    blocks: {
      payment: { include: ['src/domains/payment/**'], dependsOn: ['auth'] },
      auth: { include: ['src/domains/auth/**'] },
    },
  };

  it('블록이 다른 의존만 간선이 되고, count = import 문 수, viaPublic = 대상 블록의 공개 진입점인가', () => {
    const depcruise: DepcruiseJson = {
      modules: [
        mod('src/domains/payment/payment.ts', [
          ['src/domains/payment/repo.ts', './repo'], // 같은 블록 → 간선 아님
          ['src/domains/auth/index.ts', '@/domains/auth'], // 공개 진입점
          ['src/domains/auth/session.ts', '@/domains/auth/session'], // 내부 파일
        ]),
        mod('src/domains/payment/repo.ts'),
        mod('src/domains/auth/index.ts'),
        mod('src/domains/auth/session.ts'),
      ],
    };

    const { edges } = foldModules({ config, depcruise, lineOf: (_f, spec) => (spec.endsWith('session') ? 7 : 3) });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: 'payment', to: 'auth', count: 2, declared: true, declaredBy: 'config' });
    expect(edges[0]?.imports).toEqual([
      { file: 'src/domains/payment/payment.ts', line: 3, specifier: '@/domains/auth', viaPublic: true },
      { file: 'src/domains/payment/payment.ts', line: 7, specifier: '@/domains/auth/session', viaPublic: false },
    ]);
  });

  it('dependsOn에 없는 방향은 declared: false · declaredBy: null', () => {
    const depcruise: DepcruiseJson = {
      modules: [mod('src/domains/auth/index.ts', [['src/domains/payment/index.ts', '@/domains/payment']])],
    };

    const { edges } = foldModules({ config, depcruise, lineOf });
    expect(edges[0]).toMatchObject({ from: 'auth', to: 'payment', declared: false, declaredBy: null });
  });

  it('app → * 는 entry, * → lib 는 shared 근거로 항상 선언된 것으로 본다', () => {
    const depcruise: DepcruiseJson = {
      modules: [
        mod('src/app/api/x/route.ts', [['src/domains/payment/index.ts', '@/domains/payment']]),
        mod('src/domains/payment/index.ts', [['src/lib/http.ts', '@/lib/http']]),
        mod('src/lib/http.ts'),
      ],
    };

    const { edges } = foldModules({ config, depcruise, lineOf });
    expect(edges.map((e) => [e.from, e.to, e.declared, e.declaredBy])).toEqual([
      ['app', 'payment', true, 'entry'],
      ['payment', 'lib', true, 'shared'],
    ]);
    // lib은 모든 파일이 공개
    expect(edges[1]?.imports[0]?.viaPublic).toBe(true);
  });

  it('config.blocks[id].public 재정의가 viaPublic 판정에 쓰인다', () => {
    const cfg: PlumbConfig = {
      ...baseConfig,
      blocks: { auth: { include: ['src/domains/auth/**'], public: ['src/domains/auth/public/*.ts'] } },
    };
    const depcruise: DepcruiseJson = {
      modules: [
        mod('src/app/page.tsx', [
          ['src/domains/auth/public/session.ts', '@/domains/auth/public/session'],
          ['src/domains/auth/index.ts', '@/domains/auth'],
        ]),
      ],
    };

    const { edges } = foldModules({ config: cfg, depcruise, lineOf });
    expect(edges[0]?.imports.map((i) => i.viaPublic)).toEqual([true, false]);
  });
});

describe('foldModules — 외부 패키지', () => {
  it('node_modules·npm 의존은 블록 그래프가 아니라 externals에, 코어 모듈은 어디에도 넣지 않는다', () => {
    const depcruise: DepcruiseJson = {
      modules: [
        mod('src/domains/payment/repo.ts', [
          [
            '../../node_modules/.pnpm/@prisma+client@6/node_modules/@prisma/client/default.d.ts',
            '@prisma/client',
            ['npm', 'import'],
          ],
          ['fs', 'node:fs', ['core']],
        ]),
        mod('src/lib/http.ts', [['node_modules/next/server.d.ts', 'next/server', ['npm', 'import']]]),
        mod('src/other.ts', [['node_modules/zod/index.js', 'zod', ['npm', 'import']]]),
        mod('../../node_modules/next/server.d.ts'), // 외부 모듈 자체는 파일로 세지 않는다
      ],
    };

    const result = foldModules({ config: baseConfig, depcruise, lineOf });
    expect(result.externals).toEqual({ '@prisma/client': ['payment'], next: ['lib'], zod: ['unclassified'] });
    expect(result.packageImports).toEqual([
      { block: 'lib', pkg: 'next' },
      { block: 'payment', pkg: '@prisma/client' },
    ]);
    expect(result.edges).toEqual([]);
    expect(result.unclassified).toEqual(['src/other.ts']);
    expect(result.blocks.map((b) => b.id).sort()).toEqual(['lib', 'payment']);
  });

  it('packageNameOf — 스코프 패키지와 하위 경로', () => {
    expect(packageNameOf('next/server')).toBe('next');
    expect(packageNameOf('@prisma/client')).toBe('@prisma/client');
    expect(packageNameOf('@scope/pkg/sub/path')).toBe('@scope/pkg');
    expect(packageNameOf('react')).toBe('react');
  });
});

describe('detectL0 · infraEdgesOf', () => {
  const prisma = {
    path: 'prisma/schema.prisma',
    text: ['// 주석', 'datasource db {', '  provider = "postgresql"', '  url      = env("DATABASE_URL")', '}', ''].join(
      '\n',
    ),
  };
  const compose = {
    path: 'docker-compose.yml',
    text: [
      'services:',
      '  db:',
      '    image: postgres:16',
      '  cache:',
      '    image: redis:7 # 캐시',
      '  broker:',
      '    image: "rabbitmq:3-management"',
      '  mail:',
      '    image: mailhog/mailhog',
      'volumes:',
      '  pgdata:',
    ].join('\n'),
  };

  it('Prisma datasource와 compose db 이미지는 L0 db 노드 하나로 합친다. 환경변수는 이름만', () => {
    const { nodes, undetectedInfra } = detectL0({ prisma, compose });
    const db = nodes.find((n) => n.id === 'db');

    expect(db).toMatchObject({ level: 'L0', kind: 'db', label: 'PostgreSQL', envVars: ['DATABASE_URL'], files: 0 });
    expect(db?.evidence?.map((e) => `${e.anchor.file}:${e.anchor.line}`)).toEqual([
      'prisma/schema.prisma:3',
      'prisma/schema.prisma:4',
      'docker-compose.yml:3',
    ]);
    expect(JSON.stringify(db)).not.toContain('postgres://');
    expect(nodes.map((n) => [n.id, n.kind, n.label])).toEqual([
      ['db', 'db', 'PostgreSQL'],
      ['cache', 'cache', 'redis'],
      ['broker', 'queue', 'rabbitmq'],
      ['mail', 'external-api', 'mailhog'],
    ]);
    expect(undetectedInfra).toEqual([]);
  });

  it('파일이 없으면 노드도 없고, 네 종류 모두 undetectedInfra — 추정으로 노드를 만들지 않는다', () => {
    expect(detectL0({})).toEqual({ nodes: [], undetectedInfra: ['db', 'cache', 'queue', 'external-api'] });
  });

  it('parseComposeServices · infraKindOfImage', () => {
    expect(parseComposeServices(compose.text).map((s) => s.name)).toEqual(['db', 'cache', 'broker', 'mail']);
    expect(infraKindOfImage('postgres:16')).toBe('db');
    expect(infraKindOfImage('bitnami/kafka:3')).toBe('queue');
    expect(infraKindOfImage('valkey/valkey:8')).toBe('cache');
    expect(infraKindOfImage('stripe/stripe-mock')).toBe('external-api');
  });

  it('클라이언트 패키지 import → 감지된 L0 노드로 가는 간선. 노드가 없는 종류는 간선도 없다', () => {
    const { nodes } = detectL0({ prisma });
    const edges = infraEdgesOf(
      [
        { block: 'payment', pkg: '@prisma/client' },
        { block: 'session', pkg: 'ioredis' }, // cache 노드 없음 → 간선 없음
        { block: 'lib', pkg: 'next' }, // 인프라 아님
      ],
      nodes,
      baseConfig,
    );

    expect(edges).toEqual([
      { from: 'payment', to: 'db', via: { kind: 'package', name: '@prisma/client' }, blocks: ['payment'] },
    ]);
  });

  it('config.services의 clientPackages가 내장 표에 덧붙는다', () => {
    const config: PlumbConfig = {
      ...baseConfig,
      services: { stripe: { kind: 'external-api', clientPackages: ['stripe'] } },
    };
    const { nodes } = detectL0({
      compose: { path: 'docker-compose.yml', text: 'services:\n  stripe:\n    image: stripe/stripe-mock\n' },
    });

    expect(infraEdgesOf([{ block: 'payment', pkg: 'stripe' }], nodes, config)).toEqual([
      { from: 'payment', to: 'stripe', via: { kind: 'package', name: 'stripe' }, blocks: ['payment'] },
    ]);
  });
});

describe('isReportFresh — #44 보고서 재사용 판정', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-extract-'));
    await mkdir(join(dir, 'src', 'app'), { recursive: true });
    await mkdir(join(dir, 'reports'), { recursive: true });
    await writeFile(join(dir, '.dependency-cruiser.cjs'), 'module.exports = {};\n');
    await writeFile(join(dir, 'src', 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('보고서가 없으면 false', async () => {
    expect(await isReportFresh(dir, 'reports/depcruise.json', 'src', '.dependency-cruiser.cjs')).toBe(false);
  });

  it('보고서가 소스보다 새면 true, 소스가 바뀌면 false', async () => {
    const report = join(dir, 'reports', 'depcruise.json');
    await writeFile(report, '{"modules":[]}');
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, 'src', 'app', 'page.tsx'), old, old);
    await utimes(join(dir, 'src', 'app'), old, old);
    await utimes(join(dir, 'src'), old, old);
    await utimes(join(dir, '.dependency-cruiser.cjs'), old, old);
    expect(await isReportFresh(dir, 'reports/depcruise.json', 'src', '.dependency-cruiser.cjs')).toBe(true);

    const future = new Date(Date.now() + 60_000);
    await utimes(join(dir, 'src', 'app', 'page.tsx'), future, future);
    expect(await isReportFresh(dir, 'reports/depcruise.json', 'src', '.dependency-cruiser.cjs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. examples/testbed 실제 실행
// ---------------------------------------------------------------------------

describe('extractDependencies — examples/testbed 실제 실행', () => {
  let ctx: AdapterContext;
  let graph: BlockGraph;

  beforeAll(async () => {
    const loaded = await loadConfig({ target: TESTBED });
    ctx = { root: loaded.root, config: loaded.config };
    // 보고서 재사용 없이 dependency-cruiser를 직접 spawn한다 — 결과가 현재 소스의 것임을 보장
    graph = await extractDependencies(ctx, { reuseReport: false });
    await mkdir(join(TESTBED, 'reports'), { recursive: true });
    await writeFile(join(TESTBED, 'reports', 'block-graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
  }, 120_000);

  it('머리말: generatedAt · commit(HEAD) · tool(dependency-cruiser + 설치 버전)', () => {
    expect(new Date(graph.generatedAt).toISOString()).toBe(graph.generatedAt);
    expect(graph.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(graph.tool).toEqual({ name: 'dependency-cruiser', version: depcruiseVersion(TESTBED) });
    expect(graph.tool.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(graph.reusedReport).toBeUndefined();
  });

  it('L1 블록 집합은 { payment, auth, app, lib } — payment·auth는 설정, app·lib은 디렉토리 기본', () => {
    const l1 = graph.blocks.filter((b) => b.level === 'L1');
    expect(l1.map((b) => b.id).sort()).toEqual(['app', 'auth', 'lib', 'payment']);

    const byId = Object.fromEntries(l1.map((b) => [b.id, b]));
    expect(byId.payment).toEqual({
      id: 'payment',
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/payment/**'],
      public: ['src/domains/payment/index.ts'],
      files: 4, // index · payment · repo · types (__tests__는 depcruise 설정에서 제외)
      declared: true,
      risk: 'high',
    });
    expect(byId.auth).toEqual({
      id: 'auth',
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/auth/**'],
      public: ['src/domains/auth/index.ts'],
      files: 1,
      declared: true,
    });
    expect(byId.app).toEqual({
      id: 'app',
      level: 'L1',
      kind: 'entry',
      paths: ['src/app/**'],
      public: [],
      files: 4, // api/payments/route · api/refunds/route · layout · page
      declared: false,
    });
    expect(byId.lib).toEqual({
      id: 'lib',
      level: 'L1',
      kind: 'domain',
      paths: ['src/lib/**'],
      public: ['src/lib/http.ts', 'src/lib/payment-contract.ts'],
      files: 2,
      declared: false,
      shared: true,
    });
  });

  it('L1 간선은 app → payment, app → lib 둘뿐 (payment → lib 없음, 도메인 간 간선 없음)', () => {
    expect(graph.edges.map((e) => `${e.from} → ${e.to}`)).toEqual(['app → lib', 'app → payment']);
  });

  it('app → payment: payments·refunds route가 공개 진입점을 import → viaPublic true · count 2', () => {
    const edge = graph.edges.find((e) => e.from === 'app' && e.to === 'payment');
    expect(edge).toMatchObject({ count: 2, declared: true, declaredBy: 'entry' });
    expect(edge?.count).toBeGreaterThanOrEqual(2);
    expect(edge?.imports).toEqual([
      { file: 'src/app/api/payments/route.ts', line: 2, specifier: '@/domains/payment', viaPublic: true },
      { file: 'src/app/api/refunds/route.ts', line: 3, specifier: '@/domains/payment', viaPublic: true },
    ]);
  });

  it('app → lib: http · payment-contract 각 2회 = 4 import, 공유 블록이라 전부 viaPublic', () => {
    const edge = graph.edges.find((e) => e.from === 'app' && e.to === 'lib');
    expect(edge).toMatchObject({ count: 4, declared: true, declaredBy: 'entry' });
    expect(edge?.imports.map((i) => [i.file, i.line, i.specifier, i.viaPublic])).toEqual([
      ['src/app/api/payments/route.ts', 3, '@/lib/http', true],
      ['src/app/api/payments/route.ts', 4, '@/lib/payment-contract', true],
      ['src/app/api/refunds/route.ts', 4, '@/lib/http', true],
      ['src/app/api/refunds/route.ts', 5, '@/lib/payment-contract', true],
    ]);
  });

  it('L0: prisma datasource(postgresql, DATABASE_URL) + compose postgres:16 → db 노드 하나. 캐시·큐·외부 API는 미감지', () => {
    const l0 = graph.blocks.filter((b) => b.level === 'L0');
    expect(l0).toHaveLength(1);
    expect(l0[0]).toMatchObject({ id: 'db', kind: 'db', label: 'PostgreSQL', envVars: ['DATABASE_URL'], files: 0 });
    expect(l0[0]?.evidence?.map((e) => `${e.anchor.file}:${e.anchor.line}`)).toEqual([
      'prisma/schema.prisma:5',
      'prisma/schema.prisma:6',
      'docker-compose.yml:3',
    ]);
    expect(graph.undetectedInfra).toEqual(['cache', 'queue', 'external-api']);
  });

  it('L0 간선: @prisma/client를 import하는 payment(repo.ts) → db', () => {
    expect(graph.infraEdges).toEqual([
      { from: 'payment', to: 'db', via: { kind: 'package', name: '@prisma/client' }, blocks: ['payment'] },
    ]);
  });

  it('외부 패키지: @prisma/client ← payment, next ← lib, react ← app', () => {
    expect(graph.externals).toEqual({ '@prisma/client': ['payment'], next: ['lib'], react: ['app'] });
  });

  it('미분류 파일은 현재 testbed에 없다 — 명시적으로 0개', () => {
    expect(graph.unclassified).toEqual([]);
  });

  it('nextjsAdapter.extractDependencies 가 같은 구현이다 (보고서 재사용 허용 기본값)', async () => {
    const viaAdapter = await nextjsAdapter.extractDependencies(ctx);
    expect(viaAdapter.blocks.map((b) => b.id)).toEqual(graph.blocks.map((b) => b.id));
    expect(viaAdapter.edges.map((e) => [e.from, e.to, e.count])).toEqual(
      graph.edges.map((e) => [e.from, e.to, e.count]),
    );
    expect(viaAdapter.unclassified).toEqual([]);
  }, 120_000);
});
