/**
 * 외부 의존성 View 생성기 (#56).
 * 1) 가짜 루트 + 가짜 그래프: `importedBy` · `unused` · 규칙 연결 · 서비스(L0) · git 없음 → `unavailable`
 * 2) 어댑터 실패 → `importAnalysis: 'missing'` · `unused: null`. lockfile 없음 → `missing`
 * 3) 가짜 git 레포: 커밋별 추가 · 버전 변경 · 제거 → `DependencyEvent`, `links.packages`로 결정 기록 연결, 없으면 `no-record`
 * 4) `examples/testbed` **실제** 루트(모노레포 lockfile · 실제 git) + 알려진 testbed 그래프 → Markdown에 "직접 의존" · "외부 서비스" ·
 *    `@prisma/client` 행
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../adapter/errors.js';
import type { Adapter, BlockGraph } from '../../adapter/types.js';
import { loadConfig, plumbConfigSchema } from '../../config/index.js';
import { writeDecision } from '../../decisions/store.js';
import { openStore, type Store, serializeRulesDocument } from '../../store/index.js';
import type { PlumbConfig, Rule } from '../../types/index.js';
import {
  DEFAULT_EVENTS_SINCE_DAYS,
  dependenciesView,
  diffDirect,
  externalsOf,
  generateDependenciesView,
  renderDependenciesView,
} from '../dependencies.js';
import { parsePnpmLock } from '../lockfile.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const TESTBED = join(REPO_ROOT, 'examples', 'testbed');
const NOW = new Date('2026-10-02T09:00:00.000Z');

const FAKE_CONFIG: PlumbConfig = plumbConfigSchema.parse({
  service: '.',
  adapter: 'nextjs',
  roles: {
    'test-writer': { model: 'default', maxTurns: 1, maxBudgetUsd: 0 },
    implementer: { model: 'default', maxTurns: 1, maxBudgetUsd: 0 },
    injector: { model: 'default', maxTurns: 1, maxBudgetUsd: 0 },
    'rule-drafter': { model: 'default', maxTurns: 1, maxBudgetUsd: 0 },
  },
  stopBlockLimit: 5,
});

/** 직접: ioredis(prod, auth가 import) · lodash(prod, 아무도 import 안 함) · vitest(dev). 간접: denque ← ioredis */
const FAKE_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      ioredis:
        specifier: ^5.4.0
        version: 5.4.1
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
    devDependencies:
      vitest:
        specifier: ^3
        version: 3.2.7(jiti@2.7.0)

snapshots:

  denque@2.1.0: {}

  ioredis@5.4.1:
    dependencies:
      denque: 2.1.0

  jiti@2.7.0: {}

  lodash@4.17.21: {}

  vitest@3.2.7(jiti@2.7.0):
    optionalDependencies:
      jiti: 2.7.0
`;

const FAKE_PACKAGE_JSON = JSON.stringify(
  { name: 'fake', dependencies: { ioredis: '^5.4.0', lodash: '^4.17.21' }, devDependencies: { vitest: '^3' } },
  null,
  2,
);

const FAKE_COMPOSE = `services:
  app:
    build: .
  cache:
    image: redis:7
    ports:
      - '6379:6379'
`;

function graphWith(overrides: Partial<BlockGraph> & { externals?: Record<string, string[]> }): BlockGraph {
  return {
    generatedAt: NOW.toISOString(),
    tool: { name: 'dependency-cruiser', version: '18.5.0' },
    blocks: [],
    edges: [],
    infraEdges: [],
    undetectedInfra: ['db', 'cache', 'queue', 'external-api'],
    unclassified: [],
    ...overrides,
  };
}

/** 가짜 루트의 그래프: auth → ioredis, L0 cache(redis) ← ioredis */
const FAKE_GRAPH = graphWith({
  blocks: [
    { id: 'auth', level: 'L1', kind: 'domain', paths: ['src/domains/auth/**'], public: [], files: 2 },
    {
      id: 'cache',
      level: 'L0',
      kind: 'cache',
      paths: [],
      public: [],
      files: 0,
      label: 'redis',
      evidence: [{ anchor: { file: 'docker-compose.yml', line: 5 }, excerpt: 'image: redis:7', source: 'parser' }],
    },
  ],
  infraEdges: [{ from: 'auth', to: 'cache', via: { kind: 'package', name: 'ioredis' }, blocks: ['auth'] }],
  undetectedInfra: ['db', 'queue', 'external-api'],
  externals: { ioredis: ['auth'] },
});

/** `examples/testbed`의 실제 추출 결과와 같은 모양 (adapter-nextjs `extract-dependencies.test.ts`의 기대값). 코어는 어댑터를 import하지 않는다 */
const TESTBED_GRAPH = graphWith({
  blocks: [
    {
      id: 'payment',
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/payment/**'],
      public: ['src/domains/payment/index.ts'],
      files: 4,
    },
    {
      id: 'auth',
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/auth/**'],
      public: ['src/domains/auth/index.ts'],
      files: 1,
    },
    { id: 'app', level: 'L1', kind: 'entry', paths: ['src/app/**'], public: [], files: 4 },
    { id: 'lib', level: 'L1', kind: 'domain', paths: ['src/lib/**'], public: ['src/lib/http.ts'], files: 2 },
    {
      id: 'db',
      level: 'L0',
      kind: 'db',
      paths: [],
      public: [],
      files: 0,
      label: 'PostgreSQL',
      envVars: ['DATABASE_URL'],
      evidence: [
        { anchor: { file: 'prisma/schema.prisma', line: 5 }, excerpt: 'provider = "postgresql"', source: 'parser' },
        { anchor: { file: 'prisma/schema.prisma', line: 6 }, excerpt: 'url = env("DATABASE_URL")', source: 'parser' },
        { anchor: { file: 'docker-compose.yml', line: 3 }, excerpt: 'image: postgres:16', source: 'parser' },
      ],
    },
  ],
  infraEdges: [{ from: 'payment', to: 'db', via: { kind: 'package', name: '@prisma/client' }, blocks: ['payment'] }],
  undetectedInfra: ['cache', 'queue', 'external-api'],
  externals: { '@prisma/client': ['payment'], next: ['lib'], react: ['app'] },
});

function fakeAdapter(graph: BlockGraph | Error): Adapter {
  return {
    name: 'nextjs',
    extractDependencies: async () => {
      if (graph instanceof Error) throw graph;
      return graph;
    },
    async generateStubs() {
      throw new NotImplementedError('generateStubs', 'M4');
    },
    async runTests() {
      throw new NotImplementedError('runTests', 'M5');
    },
    async readSchemas() {
      throw new NotImplementedError('readSchemas', 'M8');
    },
    async collectTraces() {
      throw new NotImplementedError('collectTraces', 'M8');
    },
  };
}

const SESSION_STORE_RULE: Rule = {
  id: 'auth.session-store',
  block: 'auth',
  kind: 'technical',
  statement: 'THE SYSTEM SHALL 세션 저장소로 redis를 쓴다',
  source: 'plan:AUTH-03',
  risk: 'normal',
  depends_on: [],
  checks: [],
  constraint: {
    targets: [
      { kind: 'package', name: 'ioredis' },
      { kind: 'service', type: 'cache' },
    ],
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function tempStore(root: string, config: PlumbConfig = FAKE_CONFIG): Promise<Store> {
  const dir = await tempDir('plumb-deps-store-');
  const store = openStore({ store: join(dir, 'store'), blocks: config.blocks }, root, { now: () => NOW });
  await store.init();
  return store;
}

async function fakeRoot(options: { lockfile?: boolean; compose?: boolean } = {}): Promise<string> {
  const root = await tempDir('plumb-deps-root-');
  await writeFile(join(root, 'package.json'), FAKE_PACKAGE_JSON);
  if (options.lockfile !== false) await writeFile(join(root, 'pnpm-lock.yaml'), FAKE_LOCK);
  if (options.compose !== false) await writeFile(join(root, 'docker-compose.yml'), FAKE_COMPOSE);
  return root;
}

// ---------------------------------------------------------------------------
// 1. 가짜 루트 + 가짜 그래프
// ---------------------------------------------------------------------------

describe('generate — lockfile + externals + L0 + 규칙 · 결정 (git 없음)', () => {
  it('importedBy는 externals에서, unused는 direct & prod & import 없음, dev는 unused 아님', async () => {
    const root = await fakeRoot();
    const store = await tempStore(root);
    const view = await generateDependenciesView({
      root,
      config: FAKE_CONFIG,
      store,
      adapter: fakeAdapter(FAKE_GRAPH),
      commit: 'abcdef0123456789',
      now: () => NOW,
    });

    expect(view.header).toMatchObject({
      view: 'dependencies',
      generatedAt: NOW.toISOString(),
      commit: 'abcdef0123456789',
    });
    expect(view.lockfile).toEqual({ path: 'pnpm-lock.yaml', format: 'pnpm', version: '9.0' });
    expect(view.importAnalysis).toBe('available');

    const byName = Object.fromEntries(view.packages.map((p) => [p.name, p]));
    expect(byName.ioredis).toMatchObject({
      version: '5.4.1',
      specifier: '^5.4.0',
      direct: true,
      scope: 'prod',
      importedBy: ['auth'],
      unused: false,
      transitive: 1,
      lockfile: { file: 'pnpm-lock.yaml', line: 7 },
    });
    expect(byName.lodash).toMatchObject({ direct: true, scope: 'prod', importedBy: [], unused: true, transitive: 0 });
    expect(byName.vitest).toMatchObject({
      direct: true,
      scope: 'dev',
      version: '3.2.7',
      importedBy: [],
      unused: false,
    });
    // 간접 의존도 항목으로 들어간다 (direct: false). 직접이 먼저
    expect(
      view.packages
        .filter((p) => !p.direct)
        .map((p) => p.name)
        .sort(),
    ).toEqual(['denque', 'jiti']);
    expect(byName.denque).toMatchObject({ direct: false, version: '2.1.0', unused: false, importedBy: [] });
    expect(view.packages.findIndex((p) => !p.direct)).toBe(3);

    expect(view.services).toEqual([
      {
        kind: 'cache',
        name: 'redis',
        evidence: [{ anchor: { file: 'docker-compose.yml', line: 5 }, excerpt: 'image: redis:7', source: 'parser' }],
        clientPackages: ['ioredis'],
        usedBy: ['auth'],
        rules: [],
      },
    ]);
    expect(view.undetectedInfra).toEqual(['db', 'queue', 'external-api']);
    expect(view.events).toEqual({ unavailable: 'no-git' });
    expect(view.summary).toEqual({
      direct: { total: 3, prod: 2, dev: 1 },
      transitive: 2,
      unusedDirect: 1,
      services: 1,
      recentEvents: 0,
      recentNoReason: 0,
    });
    // 출처: lockfile · 그래프 도구 · compose · 결정 기록. 규칙이 없으니 rules.yaml 없음, git 없으니 git 없음
    expect(view.header.sources).toEqual([
      { kind: 'parser', tool: 'pnpm-lock', version: '9.0', input: 'pnpm-lock.yaml' },
      { kind: 'parser', tool: 'dependency-cruiser', version: '18.5.0' },
      { kind: 'parser', tool: 'docker-compose', input: 'docker-compose.yml' },
      { kind: 'store', input: 'decisions/' },
    ]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it('규칙 constraint.targets로 패키지 · 서비스에 규칙이 붙고, 상태 기록이 없으면 unchecked, 있으면 그 상태', async () => {
    const root = await fakeRoot();
    const store = await tempStore(root);
    await writeFile(store.paths.rules, serializeRulesDocument([SESSION_STORE_RULE]));
    await store.ruleStatus.write([
      {
        ruleId: 'auth.session-store',
        detail: {
          status: 'fail',
          failures: [
            { check: { kind: 'static', ref: 'depcruise:x' }, anchor: { file: 'src/x.ts', line: 1 }, message: 'x' },
          ],
        },
        since: NOW.toISOString(),
        commit: 'abc',
        checkedAt: NOW.toISOString(),
        history: ['fail'],
      },
    ]);
    const view = await generateDependenciesView({
      root,
      config: FAKE_CONFIG,
      store,
      adapter: fakeAdapter(FAKE_GRAPH),
      commit: undefined,
      now: () => NOW,
    });
    const ioredis = view.packages.find((p) => p.name === 'ioredis');
    expect(ioredis?.rules).toEqual([{ ruleId: 'auth.session-store', status: 'fail' }]);
    expect(view.packages.find((p) => p.name === 'lodash')?.rules).toEqual([]);
    expect(view.services[0]?.rules).toEqual([{ ruleId: 'auth.session-store', status: 'fail' }]);
    expect(view.header.sources).toContainEqual({ kind: 'store', input: 'rules.yaml' });
    expect(view.header).not.toHaveProperty('commit');

    const md = renderDependenciesView(view);
    expect(md).toContain('`auth.session-store` 🔴');
  });
});

// ---------------------------------------------------------------------------
// 2. 비어 있을 때
// ---------------------------------------------------------------------------

describe('generate — 분석 없음 · lockfile 없음', () => {
  it('어댑터가 실패하면 importAnalysis missing, unused null, 서비스 없음(전부 미감지), 요약 ▲ ?', async () => {
    const root = await fakeRoot();
    const store = await tempStore(root);
    const view = await generateDependenciesView({
      root,
      config: FAKE_CONFIG,
      store,
      adapter: fakeAdapter(new NotImplementedError('extractDependencies', 'M8')),
      commit: undefined,
      now: () => NOW,
    });
    expect(view.importAnalysis).toBe('missing');
    for (const p of view.packages.filter((p) => p.direct)) {
      expect(p.unused).toBeNull();
      expect(p.importedBy).toEqual([]);
    }
    expect(view.services).toEqual([]);
    expect(view.undetectedInfra).toEqual(['db', 'cache', 'queue', 'external-api']);
    expect(view.summary.unusedDirect).toBeNull();
    expect(view.header.sources.some((s) => s.tool === 'dependency-cruiser')).toBe(false);

    const md = renderDependenciesView(view);
    expect(md).toContain('분석 없음');
    expect(md).toContain('▲ ?');
    expect(md).toContain('감지된 설정 없음');
  });

  it('그래프에 externals가 없으면(코어 BlockGraph만) import 분석은 missing', () => {
    expect(externalsOf(graphWith({}))).toBeNull();
    expect(externalsOf(null)).toBeNull();
    expect(externalsOf(graphWith({ externals: { a: ['x', 'b'] } }))).toEqual({ a: ['b', 'x'] });
  });

  it('lockfile이 없으면 missing — package.json으로 버전을 추정하지 않는다', async () => {
    const root = await fakeRoot({ lockfile: false, compose: false });
    const store = await tempStore(root);
    const view = await generateDependenciesView({
      root,
      config: FAKE_CONFIG,
      store,
      adapter: fakeAdapter(FAKE_GRAPH),
      commit: undefined,
      now: () => NOW,
    });
    expect(view.lockfile).toEqual({ missing: true });
    expect(view.packages).toEqual([]);
    expect(view.summary.direct).toEqual({ total: 0, prod: 0, dev: 0 });
    expect(view.header.sources.some((s) => s.tool === 'pnpm-lock')).toBe(false);
    const md = renderDependenciesView(view);
    expect(md).toContain('lockfile 없음 (`pnpm-lock.yaml`)');
    expect(md).not.toContain('| 패키지 |');
  });

  it('package-lock.json은 unsupported npm으로 표시만', async () => {
    const root = await fakeRoot({ lockfile: false });
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    const store = await tempStore(root);
    const view = await generateDependenciesView({
      root,
      config: FAKE_CONFIG,
      store,
      adapter: fakeAdapter(FAKE_GRAPH),
      commit: undefined,
      now: () => NOW,
    });
    expect(view.lockfile).toEqual({ path: 'package-lock.json', unsupported: 'npm' });
    expect(view.packages).toEqual([]);
    expect(renderDependenciesView(view)).toContain('지원하지 않는 lockfile: npm (`package-lock.json`)');
  });
});

// ---------------------------------------------------------------------------
// 3. git 이벤트 — 가짜 레포
// ---------------------------------------------------------------------------

function sh(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=plumb-test', '-c', 'user.email=plumb-test@example.com', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    },
  );
}

function lockWith(entries: Record<string, { specifier: string; version: string }>): string {
  const deps = Object.entries(entries)
    .map(([name, e]) => `      ${name}:\n        specifier: ${e.specifier}\n        version: ${e.version}`)
    .join('\n');
  const snaps = Object.entries(entries)
    .map(([name, e]) => `  ${name}@${e.version}: {}`)
    .join('\n\n');
  return `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${deps}\n\nsnapshots:\n\n${snaps}\n`;
}

describe('generate — git 이벤트', () => {
  it('커밋별 추가 · 버전 변경 · 제거, links.packages로 결정 기록 연결, 없으면 no-record', async () => {
    const root = await tempDir('plumb-deps-git-');
    sh(root, ['init', '-q', '-b', 'main']);
    const commitAll = (message: string) => {
      sh(root, ['add', '-A']);
      sh(root, ['commit', '-q', '-m', message]);
      return sh(root, ['rev-parse', 'HEAD']).trim();
    };
    const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'g', dependencies: deps });

    await writeFile(join(root, 'package.json'), pkg({ a: '^1.0.0' }));
    await writeFile(join(root, 'pnpm-lock.yaml'), lockWith({ a: { specifier: '^1.0.0', version: '1.0.0' } }));
    const c1 = commitAll('init');
    await writeFile(join(root, 'README.md'), 'no dependency change');
    commitAll('docs');
    await writeFile(join(root, 'package.json'), pkg({ a: '^1.0.0', ioredis: '^5.4.0' }));
    await writeFile(
      join(root, 'pnpm-lock.yaml'),
      lockWith({ a: { specifier: '^1.0.0', version: '1.0.3' }, ioredis: { specifier: '^5.4.0', version: '5.4.1' } }),
    );
    const c2 = commitAll('feat: redis session');
    await writeFile(join(root, 'package.json'), pkg({ ioredis: '^5.4.0' }));
    await writeFile(join(root, 'pnpm-lock.yaml'), lockWith({ ioredis: { specifier: '^5.4.0', version: '5.4.1' } }));
    const c3 = commitAll('chore: drop a');

    const store = await tempStore(root);
    await writeDecision(store.paths, {
      id: 'D-0004',
      title: '세션 저장소를 redis로',
      date: '2026-10-01T00:00:00Z',
      decision: 'redis',
      reason: 'TTL',
      rejected: 'in-memory',
      accepted: '인프라 1개',
      links: { rules: [], commits: [], events: [], packages: ['ioredis'], services: [] },
    });

    const view = await generateDependenciesView({
      root,
      config: FAKE_CONFIG,
      store,
      adapter: fakeAdapter(graphWith({ externals: {} })),
      commit: c3,
      now: () => new Date(),
    });
    if ('unavailable' in view.events) throw new Error('git 레포인데 unavailable');
    expect(view.events.items.map((e) => e.commit)).toEqual([c3, c2, c1]);
    const [e3, e2, e1] = view.events.items;
    expect(e1).toMatchObject({
      changes: [{ name: 'a', kind: 'added', to: '1.0.0', direct: true }],
      transitiveChanges: 0,
      decision: 'no-record',
    });
    expect(e2).toMatchObject({
      changes: [
        { name: 'a', kind: 'changed', from: '1.0.0', to: '1.0.3', direct: true },
        { name: 'ioredis', kind: 'added', to: '5.4.1', direct: true },
      ],
      decision: 'D-0004',
    });
    expect(e3).toMatchObject({
      changes: [{ name: 'a', kind: 'removed', from: '1.0.3', direct: true }],
      decision: 'no-record',
    });
    expect(new Date(e2?.at ?? '').toString()).not.toBe('Invalid Date');
    expect(view.summary.recentEvents).toBe(3);
    expect(view.summary.recentNoReason).toBe(2);
    expect(view.header.sources).toContainEqual({
      kind: 'git',
      commit: c3,
      input: `package.json pnpm-lock.yaml --since=${DEFAULT_EVENTS_SINCE_DAYS}d`,
    });

    const md = renderDependenciesView(view);
    expect(md).toContain(`## 최근 변경 (${DEFAULT_EVENTS_SINCE_DAYS}일)`);
    expect(md).toContain(`| \`${c2.slice(0, 7)}\` |`);
    expect(md).toContain('a 1.0.0 → 1.0.3 (직접) · + ioredis 5.4.1 (직접) | `D-0004` |');
    expect(md).toContain('| + a 1.0.0 (직접) | **사유 없음** ⚠ |');
    expect(md).toContain('− a 1.0.3 (직접)');
  });

  it('diffDirect: lockfile 해석 버전 우선, 없으면 specifier. 양쪽 다 없는 이름은 무시', () => {
    const before = { specifiers: { a: '^1' }, lock: null };
    const after = {
      specifiers: { a: '^1', b: '^2' },
      lock: parsePnpmLock(lockWith({ b: { specifier: '^2', version: '2.5.0' } })),
    };
    expect(diffDirect(before, after)).toEqual([{ name: 'b', kind: 'added', to: '2.5.0', direct: true }]);
    expect(diffDirect({ specifiers: {}, lock: null }, { specifiers: {}, lock: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. examples/testbed 실제 루트 — 모노레포 lockfile · 실제 git
// ---------------------------------------------------------------------------

describe('examples/testbed — 실제 lockfile(importers["examples/testbed"]) + 알려진 그래프', () => {
  it('Markdown에 "직접 의존" · "외부 서비스" · @prisma/client 행(payment)', async () => {
    const loaded = await loadConfig({ target: TESTBED });
    const store = await tempStore(loaded.root, loaded.config);
    const view = await dependenciesView.generate({
      root: loaded.root,
      config: loaded.config,
      store,
      adapter: fakeAdapter(TESTBED_GRAPH),
      commit: undefined,
      now: () => new Date(),
    });

    expect(view.lockfile).toEqual({ path: '../../pnpm-lock.yaml', format: 'pnpm', version: '9.0' });
    expect(view.importAnalysis).toBe('available');
    const byName = Object.fromEntries(view.packages.filter((p) => p.direct).map((p) => [p.name, p]));
    expect(byName['@prisma/client']).toMatchObject({ scope: 'prod', importedBy: ['payment'], unused: false });
    expect(byName['@prisma/client']?.version).toMatch(/^6\.\d+\.\d+$/);
    expect(byName.next).toMatchObject({ scope: 'prod', importedBy: ['lib'], unused: false });
    expect(byName.react).toMatchObject({ scope: 'prod', importedBy: ['app'], unused: false });
    expect(byName['react-dom']).toMatchObject({ scope: 'prod', importedBy: [], unused: true });
    expect(byName.vitest).toMatchObject({ scope: 'dev', unused: false });
    expect(byName.prisma).toMatchObject({ scope: 'dev' });
    // testbed의 devDependencies는 다른 이슈가 늘릴 수 있다(#59 OTel 등) — prod 4는 고정, dev는 하한만
    expect(view.summary.direct.prod).toBe(4);
    expect(view.summary.direct.dev).toBeGreaterThanOrEqual(11);
    expect(view.summary.direct.total).toBe(view.summary.direct.prod + view.summary.direct.dev);
    expect(view.summary.transitive).toBeGreaterThan(0);
    expect(view.summary.unusedDirect).toBe(1);

    expect(view.services).toHaveLength(1);
    expect(view.services[0]).toMatchObject({
      kind: 'db',
      name: 'PostgreSQL',
      clientPackages: ['@prisma/client'],
      usedBy: ['payment'],
    });
    expect(view.undetectedInfra).toEqual(['cache', 'queue', 'external-api']);
    // 레포 안이라 git은 있다. 항목 수는 날짜에 따라 변하므로 모양만
    expect(view.events).not.toHaveProperty('unavailable');
    expect(view.header.sources).toContainEqual({
      kind: 'parser',
      tool: 'pnpm-lock',
      version: '9.0',
      input: "../../pnpm-lock.yaml importers['examples/testbed']",
    });
    expect(view.header.sources).toContainEqual({ kind: 'parser', tool: 'docker-compose', input: 'docker-compose.yml' });

    const md = dependenciesView.render(view);
    expect(md.startsWith('# 외부 의존성\n\n출처: 파서: pnpm-lock 9.0')).toBe(true);
    expect(md).toContain('## 직접 의존');
    expect(md).toContain('## 외부 서비스');
    expect(md).toContain('## 최근 변경');
    const prismaRow = md.split('\n').find((line) => line.includes('[@prisma/client](plumb://open?file='));
    expect(prismaRow).toBeDefined();
    expect(prismaRow).toContain('| prod | `payment` |  | — |');
    expect(md).toContain(
      '| DB | PostgreSQL | [prisma/schema.prisma:5](plumb://open?file=prisma%2Fschema.prisma&line=5)',
    );
    expect(md).toContain('감지 안 됨: 캐시 · 큐 · 외부 API');

    // 정본 JSON → 저장소 쓰기까지 (store.views)
    const stored = await store.views.write('dependencies', view, md);
    expect(stored.view).toEqual(view);
  }, 30_000);
});
