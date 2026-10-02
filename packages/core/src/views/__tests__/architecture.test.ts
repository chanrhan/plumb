/**
 * 아키텍처 View 생성기 테스트 (#54).
 *
 * 1) 가짜 어댑터(합성 블록 그래프) + 임시 저장소(검사 기록 1개 · 규칙 2개) → View JSON의 `summary` · `requiredChecks` · `impact.unavailable`,
 *    Markdown의 점선 간선 · ⚠ · 노드 ID 정규화
 * 2) `examples/testbed`를 **실제로** 돌린다 — `@plumb/adapter-nextjs`의 `nextjsAdapter`(빌드된 dist)로 dependency-cruiser를 spawn
 * 3) 추출 실패 — `extractionError` + 이전 View가 있으면 그래프 유지, 없으면 빈 그래프
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, BlockGraph } from '../../adapter/index.js';
import { loadConfig } from '../../config/index.js';
import { openStore, type Store } from '../../store/index.js';
import type { ArchitectureView, CheckRun, PlumbConfig, Rule } from '../../types/index.js';
import {
  type ArchitectureBlockNode,
  architectureView,
  blockCycles,
  blockMatcher,
  globToRegExp,
  MermaidIds,
  SYSTEM_NODE_ID,
  type ViewContext,
} from '../index.js';

const NOW = new Date('2026-10-02T09:00:00.000Z');
const TESTBED = fileURLToPath(new URL('../../../../../examples/testbed/', import.meta.url)).replace(/\/$/, '');
const ADAPTER_DIST = fileURLToPath(new URL('../../../../adapter-nextjs/dist/index.js', import.meta.url));

const config: PlumbConfig = {
  service: 'synthetic',
  adapter: 'nextjs',
  roles: {
    'test-writer': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    implementer: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    injector: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    'rule-drafter': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
  },
  stopBlockLimit: 3,
  blocks: {
    payment: { include: ['src/domains/payment/**'], risk: 'high', dependsOn: ['auth'] },
    auth: { include: ['src/domains/auth/**'] },
  },
};

const RULES: Rule[] = [
  {
    id: 'pay.refund-window',
    block: 'payment',
    kind: 'business',
    statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
    source: 'plan:PAY-02',
    risk: 'high',
    depends_on: [],
    checks: [],
  },
  {
    id: 'pay.payment-record',
    block: 'payment',
    kind: 'technical',
    statement: 'THE SYSTEM SHALL 결제 성공 시 Payment 레코드를 남긴다',
    source: 'code:src/domains/payment/index.ts',
    risk: 'normal',
    depends_on: [],
    checks: [],
  },
];

/** 어댑터(`NextjsBlockNode`)처럼 `risk`를 단 블록 노드 — 블록 표의 고위험 열 */
const PAYMENT_NODE: ArchitectureBlockNode = {
  id: 'payment',
  level: 'L1',
  kind: 'domain',
  paths: ['src/domains/payment/**'],
  public: ['src/domains/payment/index.ts'],
  files: 4,
  risk: 'high',
};

/** view-architecture 2.1 와이어프레임의 그래프: app · auth · payment + 미선언 auth → payment + 외부 API 노드 */
function syntheticGraph(): BlockGraph {
  return {
    generatedAt: NOW.toISOString(),
    tool: { name: 'dependency-cruiser', version: '18.5.0' },
    blocks: [
      PAYMENT_NODE,
      {
        id: 'auth',
        level: 'L1',
        kind: 'domain',
        paths: ['src/domains/auth/**'],
        public: ['src/domains/auth/index.ts'],
        files: 4,
      },
      { id: 'app', level: 'L1', kind: 'entry', paths: ['src/app/**'], public: [], files: 4 },
      {
        id: 'db',
        level: 'L0',
        kind: 'db',
        paths: [],
        public: [],
        files: 0,
        label: 'PostgreSQL',
        envVars: ['DATABASE_URL'],
      },
      { id: 'external-api', level: 'L0', kind: 'external-api', paths: [], public: [], files: 0, label: '외부 API' },
    ],
    edges: [
      {
        from: 'app',
        to: 'payment',
        count: 1,
        declared: true,
        imports: [{ file: 'src/app/api/payments/route.ts', line: 1, specifier: '@/domains/payment', viaPublic: true }],
      },
      {
        from: 'payment',
        to: 'auth',
        count: 2,
        declared: true,
        imports: [
          { file: 'src/domains/payment/refund.ts', line: 3, specifier: '@/domains/auth', viaPublic: true },
          {
            file: 'src/domains/payment/refund.ts',
            line: 4,
            specifier: '@/domains/auth/session-store',
            viaPublic: false,
          },
        ],
      },
      {
        from: 'auth',
        to: 'payment',
        count: 1,
        declared: false,
        imports: [{ file: 'src/domains/auth/refresh.ts', line: 2, specifier: '@/domains/payment', viaPublic: true }],
      },
    ],
    infraEdges: [{ from: 'payment', to: 'db', via: { kind: 'package', name: '@prisma/client' }, blocks: ['payment'] }],
    undetectedInfra: ['cache', 'queue'],
    unclassified: ['src/export/report.ts', 'src/lib/money.ts'],
  };
}

function fakeAdapter(extract: () => Promise<BlockGraph>): Adapter {
  const notHere = async (): Promise<never> => {
    throw new Error('이 테스트에서는 부르지 않는다');
  };
  return {
    name: 'nextjs',
    extractDependencies: extract,
    generateStubs: notHere,
    runTests: notHere,
    readSchemas: notHere,
    collectTraces: notHere,
  };
}

function checkRun(): CheckRun {
  const access = { kind: 'static' as const, ref: 'depcruise:block-1-public-entry-only-cross-domain' };
  const direction = { kind: 'static' as const, ref: 'depcruise:block-2-declared-direction' };
  const cycles = { kind: 'static' as const, ref: 'depcruise:block-2-no-cycles' };
  return {
    runId: 'c-0001',
    commit: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    startedAt: '2026-10-02T08:59:00.000Z',
    finishedAt: '2026-10-02T08:59:30.000Z',
    runner: { exitCode: 0 },
    results: [
      {
        check: access,
        ruleIds: [],
        outcome: 'fail',
        failure: {
          check: access,
          anchor: { file: 'src/domains/payment/refund.ts', line: 4 },
          message:
            'src/domains/payment/refund.ts → src/domains/auth/session-store.ts (block-1-public-entry-only-cross-domain)',
        },
      },
      {
        check: direction,
        ruleIds: [],
        outcome: 'fail',
        failure: {
          check: direction,
          anchor: { file: 'src/domains/auth/refresh.ts', line: 2 },
          message: 'src/domains/auth/refresh.ts → src/domains/payment/index.ts (block-2-declared-direction)',
        },
      },
      { check: cycles, ruleIds: [], outcome: 'pass' },
      { check: { kind: 'static', ref: 'depcruise:prisma-only-in-repo' }, ruleIds: [], outcome: 'pass' },
    ],
    quarantined: [],
    counts: { junit: 0, static: 4 },
    storeStatus: 'ok',
  };
}

interface Temp {
  dir: string;
  root: string;
  store: Store;
}

async function makeTemp(rules: Rule[] = []): Promise<Temp> {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-view-arch-'));
  const root = join(dir, 'target');
  const real = openStore({ store: join(dir, 'store') }, root, { now: () => NOW });
  await real.init();
  // 규칙은 `approvals.approve()`로만 쓸 수 있어 목록만 가짜로 바꾼다 — 나머지(checks · views)는 실제 저장소
  const store: Store = {
    ...real,
    rules: { list: async () => rules, get: async (id) => rules.find((r) => r.id === id) },
  };
  return { dir, root, store };
}

function ctxOf(temp: Temp, adapter: Adapter, overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    root: temp.root,
    config,
    store: temp.store,
    adapter,
    commit: 'f00dbabe00000000000000000000000000000000',
    now: () => NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 가짜 어댑터 + 임시 저장소
// ---------------------------------------------------------------------------

describe('architectureView.generate — 합성 그래프', () => {
  let temp: Temp;
  let view: ArchitectureView;

  beforeEach(async () => {
    temp = await makeTemp(RULES);
    await temp.store.checks.write(checkRun());
    view = await architectureView.generate(
      ctxOf(
        temp,
        fakeAdapter(async () => syntheticGraph()),
      ),
    );
  });
  afterEach(() => rm(temp.dir, { recursive: true, force: true }));

  it('머리말: view · 커밋 · 출처 네 가지 중 git은 빠진다 (임시 폴더에는 git이 없다)', () => {
    expect(view.header.view).toBe('architecture');
    expect(view.header.commit).toBe('f00dbabe00000000000000000000000000000000');
    expect(view.header.generatedAt).toBe(NOW.toISOString());
    expect(view.header.sources).toEqual([
      { kind: 'parser', tool: 'dependency-cruiser', version: '18.5.0', input: 'src' },
      { kind: 'parser', tool: 'plumb.config.json' },
      { kind: 'execution', tool: 'plumb check', input: 'checks/c-0001.json' },
    ]);
    expect(view.tool).toEqual({ name: 'dependency-cruiser', version: '18.5.0' });
  });

  it('summary: 블록 3(L1만) · import 4 · 위반 접근 1 / 방향 1 · 순환 1(auth ⇄ payment) · 미분류 2 · 계약 변경 0', () => {
    expect(view.summary).toEqual({
      blocks: 3,
      crossingImports: 4,
      violations: { access: 1, direction: 1 },
      cycles: 1,
      unclassified: 2,
      contractChanges: 0,
    });
    expect(view.configMissing).toBe(false);
    expect(view.extractionError).toBeUndefined();
  });

  it('requiredChecks: (1)(2)는 최신 CheckRun의 depcruise:block-* 결과, 블록은 글롭으로 채운다. lastCheck가 붙는다', () => {
    const { publicAccessOnly, declaredDirectionsOnly, signatureChanges, lastCheck } = view.requiredChecks;
    expect(publicAccessOnly).toEqual({
      status: 'fail',
      violations: [
        {
          rule: 'block-1-public-entry-only-cross-domain',
          from: { file: 'src/domains/payment/refund.ts', line: 4 },
          to: 'src/domains/auth/session-store.ts',
          fromBlock: 'payment',
          toBlock: 'auth',
        },
      ],
    });
    expect(declaredDirectionsOnly.status).toBe('fail');
    expect(declaredDirectionsOnly.cycles).toEqual([{ blocks: ['auth', 'payment'] }]);
    // git이 없으면 (3)도 git 이력 없음
    expect(signatureChanges).toEqual({ unavailable: 'no-git' });
    expect(lastCheck).toEqual({
      runId: 'c-0001',
      commit: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
      finishedAt: '2026-10-02T08:59:30.000Z',
    });
  });

  it('impact: 대상 루트에 git이 없으면 unavailable — 0 블록이라고 쓰지 않는다', () => {
    expect(view.impact).toEqual({ unavailable: 'no-git' });
  });

  it('blocks: L0 앱 노드(system)가 앞에 붙고, L1 블록에 저장소 규칙 수가 달린다. 어댑터 노드는 그대로', () => {
    const system = view.blocks.find((b) => b.id === SYSTEM_NODE_ID);
    expect(system).toMatchObject({ level: 'L0', kind: 'app', files: 12, label: 'synthetic' });
    const payment = view.blocks.find((b) => b.id === 'payment');
    expect(payment).toMatchObject({ rules: 2, files: 4 });
    expect(view.blocks.find((b) => b.id === 'auth')).toMatchObject({ rules: 0 });
    expect(view.blocks.find((b) => b.id === 'db')).toMatchObject({ level: 'L0', kind: 'db', label: 'PostgreSQL' });
    expect(view.undetectedInfra).toEqual(['cache', 'queue']);
    expect(view.unclassified).toEqual(['src/export/report.ts', 'src/lib/money.ts']);
  });

  it('검사 기록이 없으면 (1)(2)는 unchecked · lastCheck 없음 · 출처에 실행: 없음', async () => {
    const fresh = await makeTemp();
    try {
      const v = await architectureView.generate(
        ctxOf(
          fresh,
          fakeAdapter(async () => syntheticGraph()),
        ),
      );
      expect(v.requiredChecks.publicAccessOnly).toEqual({ status: 'unchecked' });
      expect(v.requiredChecks.declaredDirectionsOnly).toEqual({
        status: 'unchecked',
        cycles: [{ blocks: ['auth', 'payment'] }],
      });
      expect(v.requiredChecks.lastCheck).toBeUndefined();
      expect(v.summary.violations).toEqual({ access: 0, direction: 0 });
      expect(v.header.sources.map((s) => s.kind)).toEqual(['parser', 'parser']);
      expect(architectureView.render(v)).toContain('위반 검사 없음 ⬜');
      expect(architectureView.render(v)).toContain('⬜ 검사 없음');
    } finally {
      await rm(fresh.dir, { recursive: true, force: true });
    }
  });

  it('config.blocks가 없으면 configMissing · 안내 문구', async () => {
    const v = await architectureView.generate(
      ctxOf(
        temp,
        fakeAdapter(async () => syntheticGraph()),
        { config: { ...config, blocks: undefined } },
      ),
    );
    expect(v.configMissing).toBe(true);
    expect(architectureView.render(v)).toContain('plumb.config.json `blocks` 없음: 방향 선언 없음');
  });

  it('render: 제목 · 출처 표시줄 · 요약 띠 · Mermaid 펜스 2개 · 표 · 미분류 절 · 필수 검사 · 영향 범위', () => {
    const md = architectureView.render(view);
    expect(
      md.startsWith(
        '# 아키텍처\n\n출처: 파서: dependency-cruiser 18.5.0 (src) · 파서: plumb.config.json · 실행: plumb check (checks/c-0001.json)\n',
      ),
    ).toBe(true);
    expect(md).toContain('블록 3 · 경계 넘는 import 4 · 위반 접근 1 / 방향 1 · 순환 1 · 미분류 2 ▲');
    expect(md.match(/^```mermaid$/gm)).toHaveLength(2);
    for (const section of [
      '## L0 시스템',
      '## L1 도메인',
      '## 블록',
      '## 간선',
      '## 미분류 파일 2개',
      '## 필수 검사',
      '## 변경 영향 범위',
    ]) {
      expect(md).toContain(`\n${section}\n`);
    }
    // L0: 앱 subgraph 안에 L1 블록, DB는 [( )], 미감지 캐시·큐는 점선 노드. 노드 ID는 영숫자
    expect(md).toContain('subgraph system["앱: synthetic"]');
    expect(md).toContain('db[("PostgreSQL")]');
    expect(md).toContain('external_api["외부 API"]');
    expect(md).toContain('none_cache("캐시: 감지된 설정 없음")');
    expect(md).toContain('none_queue("큐: 감지된 설정 없음")');
    expect(md).toContain('system -->|"@prisma/client<br/>payment"| db');
    expect(md).toContain('class none_cache,none_queue dashed');
    // L1: 선언 간선 실선, 미선언 점선, 위반은 ⚠, 내부 파일 접근 수
    expect(md).toContain('app -->|"1 · 공개"| payment');
    expect(md).toContain('payment -->|"2 · 내부 1 · ⚠ 1"| auth');
    expect(md).toContain('auth -.->|"1 · 공개 · ⚠ 1"| payment');
    expect(md).toContain('unclassified_files["미분류 2 ▲"]');
    // 표: 규칙 수 · 고위험 · 첫 import 앵커
    expect(md).toContain('| `payment` | 도메인 | 4 | `src/domains/payment/index.ts` | 🔺 고위험 | 2 |');
    expect(md).toContain('payment["payment<br/>src/domains/payment/ · 파일 4<br/>고위험"]');
    expect(md).toContain(
      '| `auth` → `payment` | 1 | 아니오 (미선언) | 1/1 | [src/domains/auth/refresh.ts:2](plumb://open?file=src%2Fdomains%2Fauth%2Frefresh.ts&line=2) |',
    );
    expect(md).toContain(
      '- [src/export/report.ts](plumb://open?file=src%2Fexport%2Freport.ts) — 어느 블록 글롭에도 안 맞음',
    );
    // 필수 검사 3행 + 실행 출처, 영향 범위
    expect(md).toContain('| (1) | 공개 계약으로만 접근 | 🔴 1 | payment → auth · [src/domains/payment/refund.ts:4]');
    expect(md).toContain('| (2) | 선언된 방향만 · 순환 금지 | 🔴 1 |');
    expect(md).toContain('순환 1: auth ⇄ payment');
    expect(md).toContain('| (3) | 공개 계약 시그니처 변경은 설계 변경 이벤트 | git 이력 없음 |');
    expect(md).toContain('|\n\n실행: plumb check · `c-0001` · a1b2c3d · 2026-10-02T08:59:30.000Z');
    expect(md).toContain('\n## 변경 영향 범위\n\ngit 이력 없음');
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('store.views.write에 그대로 들어간다 (머리말 스키마)', async () => {
    const md = architectureView.render(view);
    await temp.store.views.write('architecture', view, md);
    const stored = await temp.store.views.read('architecture');
    expect(stored?.view).toEqual(view);
    expect(stored?.markdown).toBe(md.replace(/\n$/, ''));
  });
});

describe('도우미', () => {
  it('globToRegExp — ** · * · ? · {a,b}', () => {
    expect(globToRegExp('src/domains/payment/**').test('src/domains/payment/a/b.ts')).toBe(true);
    expect(globToRegExp('src/domains/payment/**').test('src/domains/auth/a.ts')).toBe(false);
    expect(globToRegExp('src/**/index.ts').test('src/index.ts')).toBe(true);
    expect(globToRegExp('src/**/index.ts').test('src/a/b/index.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/{app,lib}/**').test('src/lib/x.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
  });

  it('blockMatcher — paths 순서대로 첫 블록, L0 노드는 무시, 안 맞으면 null', () => {
    const blockOf = blockMatcher(syntheticGraph().blocks);
    expect(blockOf('src/domains/payment/repo.ts')).toBe('payment');
    expect(blockOf('src/app/api/x/route.ts')).toBe('app');
    expect(blockOf('src/export/report.ts')).toBeNull();
  });

  it('blockCycles — 강결합 요소 중 둘 이상인 것만', () => {
    const edge = (from: string, to: string) => ({ from, to, count: 1, declared: true, imports: [] });
    expect(blockCycles([edge('a', 'b'), edge('b', 'c')])).toEqual([]);
    expect(
      blockCycles([edge('a', 'b'), edge('b', 'a'), edge('c', 'd'), edge('d', 'e'), edge('e', 'c'), edge('x', 'a')]),
    ).toEqual([{ blocks: ['a', 'b'] }, { blocks: ['c', 'd', 'e'] }]);
  });

  it('MermaidIds — 영숫자 정규화 · 예약어 · 숫자 시작 · 충돌', () => {
    const ids = new MermaidIds();
    expect(ids.of('payment')).toBe('payment');
    expect(ids.of('external-api')).toBe('external_api');
    expect(ids.of('external_api')).toBe('external_api_2');
    expect(ids.of('end')).toBe('b_end');
    expect(ids.of('1st')).toBe('b_1st');
    expect(ids.of('payment')).toBe('payment');
  });
});

// ---------------------------------------------------------------------------
// 2. examples/testbed 실제 실행
// ---------------------------------------------------------------------------

describe('architectureView — examples/testbed 실제 실행 (nextjsAdapter)', () => {
  let temp: Temp;
  let view: ArchitectureView;
  let md: string;

  beforeAll(async () => {
    if (!existsSync(ADAPTER_DIST)) {
      throw new Error(
        `@plumb/adapter-nextjs가 빌드되어 있지 않다: ${ADAPTER_DIST} — pnpm --filter @plumb/adapter-nextjs build`,
      );
    }
    // 코어는 어댑터 패키지에 의존하지 않으므로(순환) 빌드 산출물을 경로로 읽는다
    const mod = (await import(/* @vite-ignore */ pathToFileURL(ADAPTER_DIST).href)) as { nextjsAdapter: Adapter };
    const loaded = await loadConfig({ target: TESTBED });
    const dir = await mkdtemp(join(tmpdir(), 'plumb-view-arch-testbed-'));
    const store = openStore({ store: join(dir, 'store'), blocks: loaded.config.blocks }, loaded.root, {
      now: () => NOW,
    });
    await store.init();
    temp = { dir, root: loaded.root, store };
    view = await architectureView.generate({
      root: loaded.root,
      config: loaded.config,
      store,
      adapter: mod.nextjsAdapter,
      commit: undefined,
      now: () => NOW,
    });
    md = architectureView.render(view);
    await store.views.write('architecture', view, md);
  }, 120_000);

  afterAll(() => rm(temp.dir, { recursive: true, force: true }));

  it('L1 블록 4개 이상 — payment · auth(설정) + app · lib(디렉토리 기본). L0 앱 노드는 @plumb/testbed', () => {
    const l1 = view.blocks.filter((b) => b.level === 'L1').map((b) => b.id);
    expect(l1.length).toBeGreaterThanOrEqual(4);
    expect(l1).toEqual(expect.arrayContaining(['payment', 'auth', 'app', 'lib']));
    expect(view.summary.blocks).toBe(l1.length);
    expect(view.blocks[0]).toMatchObject({ id: SYSTEM_NODE_ID, level: 'L0', kind: 'app', label: '@plumb/testbed' });
    expect(view.tool.name).toBe('dependency-cruiser');
    expect(view.tool.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('app → payment 간선: 선언됨(진입점) · 공개 진입점 경유', () => {
    const edge = view.edges.find((e) => e.from === 'app' && e.to === 'payment');
    expect(edge).toBeDefined();
    expect(edge?.declared).toBe(true);
    expect(edge?.count).toBeGreaterThan(0);
    expect(edge?.imports.every((s) => s.viaPublic)).toBe(true);
  });

  it('L0: db 노드(PostgreSQL) + payment → db 간선, 미분류 0, 검사 기록 없음 → ⬜, impact는 git 이력에 따라', () => {
    expect(view.blocks.find((b) => b.id === 'db')).toMatchObject({ level: 'L0', kind: 'db', label: 'PostgreSQL' });
    expect(view.infraEdges).toEqual([
      { from: 'payment', to: 'db', via: { kind: 'package', name: '@prisma/client' }, blocks: ['payment'] },
    ]);
    expect(view.unclassified).toEqual([]);
    expect(view.summary.unclassified).toBe(0);
    expect(view.requiredChecks.publicAccessOnly).toEqual({ status: 'unchecked' });
    expect(view.requiredChecks.lastCheck).toBeUndefined();
    expect(view.extractionError).toBeUndefined();
    expect(view.configMissing).toBe(false);
    // testbed는 이 레포 안에 있다. 커밋이 둘 이상이면(로컬) 영향 범위를 잰다. CI의 얕은 체크아웃(depth 1)은 HEAD~1이
    // 없어 unavailable — 둘 다 허용하되, 어느 쪽이든 git 출처는 impact와 함께 있거나 함께 없다
    if ('unavailable' in view.impact) {
      expect(view.impact).toEqual({ unavailable: 'no-git' });
      expect(view.requiredChecks.signatureChanges).toEqual({ unavailable: 'no-git' });
      expect(view.header.sources.some((s) => s.kind === 'git')).toBe(false);
    } else {
      expect(view.impact.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(view.requiredChecks.signatureChanges).toEqual({ changes: [] });
      expect(view.header.sources.at(-1)).toEqual({ kind: 'git', commit: view.impact.commit, input: 'HEAD~1..HEAD' });
    }
  });

  it('Markdown: Mermaid 펜스 2개 · "미분류 파일" · 출처 표시줄', () => {
    expect(md.startsWith('# 아키텍처\n\n출처: 파서: dependency-cruiser ')).toBe(true);
    expect(md).toContain(' · 파서: plumb.config.json');
    expect(md).toContain('\n## 변경 영향 범위\n\n');
    if ('unavailable' in view.impact) expect(md).toContain('\n\ngit 이력 없음 — 커밋이 하나뿐이거나 git이 없다');
    else expect(md).toContain(` · git: ${view.impact.commit.slice(0, 7)} (HEAD~1..HEAD)`);
    expect(md.match(/^```mermaid$/gm)).toHaveLength(2);
    expect(md).toContain('## 미분류 파일 0개');
    expect(md).toContain('subgraph system["앱: @plumb/testbed"]');
    expect(md).toContain('db[("PostgreSQL")]');
    expect(md).toContain('none_queue("큐: 감지된 설정 없음")');
    expect(md).toMatch(/app -->\|"\d+ · 공개"\| payment/);
    expect(md).toContain('| `payment` | 도메인 |');
    expect(md).toContain('🔺 고위험');
  });
});

// ---------------------------------------------------------------------------
// 3. 추출 실패
// ---------------------------------------------------------------------------

describe('architectureView — 추출 실패', () => {
  let temp: Temp;
  const failing = fakeAdapter(async () => {
    throw new Error('dependency-cruiser 출력이 JSON이 아니다 (exit 2):\nError: Cannot find module\n    at resolve');
  });

  beforeEach(async () => {
    temp = await makeTemp();
  });
  afterEach(() => rm(temp.dir, { recursive: true, force: true }));

  it('이전 View가 없으면 extractionError + 빈 그래프 (인프라 네 종류 모두 미감지). 머리말은 정상', async () => {
    const view = await architectureView.generate(ctxOf(temp, failing));
    expect(view.extractionError).toEqual({
      exitCode: 2,
      stderrTail: ['dependency-cruiser 출력이 JSON이 아니다 (exit 2):', 'Error: Cannot find module', '    at resolve'],
    });
    expect(view.blocks.map((b) => b.id)).toEqual([SYSTEM_NODE_ID]);
    expect(view.edges).toEqual([]);
    expect(view.undetectedInfra).toEqual(['db', 'cache', 'queue', 'external-api']);
    expect(view.tool).toEqual({ name: 'dependency-cruiser', version: 'unknown' });
    expect(view.summary).toEqual({
      blocks: 0,
      crossingImports: 0,
      violations: { access: 0, direction: 0 },
      cycles: 0,
      unclassified: 0,
      contractChanges: 0,
    });
    const md = architectureView.render(view);
    expect(md).toContain('> **추출 실패 (exit 2)** — 이전 성공 결과가 없어 빈 그래프다');
    expect(md).toContain('> Error: Cannot find module');
    expect(md.match(/^```mermaid$/gm)).toHaveLength(2);
    expect(md).toContain('## 미분류 파일 0개');
  });

  it('이전 View가 있으면 그 그래프를 그대로 두고 머리말만 갱신한다', async () => {
    const ok = await architectureView.generate(
      ctxOf(
        temp,
        fakeAdapter(async () => syntheticGraph()),
      ),
    );
    await temp.store.views.write('architecture', ok, architectureView.render(ok));

    const later = new Date('2026-10-02T10:00:00.000Z');
    const view = await architectureView.generate(
      ctxOf(temp, failing, { now: () => later, commit: 'cafe0000000000000000000000000000000000ff' }),
    );
    expect(view.extractionError?.exitCode).toBe(2);
    expect(view.header.generatedAt).toBe(later.toISOString());
    expect(view.header.commit).toBe('cafe0000000000000000000000000000000000ff');
    expect(view.blocks).toEqual(ok.blocks);
    expect(view.edges).toEqual(ok.edges);
    expect(view.infraEdges).toEqual(ok.infraEdges);
    expect(view.unclassified).toEqual(ok.unclassified);
    expect(view.tool).toEqual(ok.tool);
    expect(view.summary).toEqual(ok.summary);
    expect(architectureView.render(view)).toContain('> **추출 실패 (exit 2)** — 아래 그래프는 이전 성공 결과다');
  });

  it('메시지에 exit 코드가 없으면 1', async () => {
    const view = await architectureView.generate(
      ctxOf(
        temp,
        fakeAdapter(async () => {
          throw new Error('dependency-cruiser가 대상에 설치되어 있지 않다');
        }),
      ),
    );
    expect(view.extractionError).toEqual({
      exitCode: 1,
      stderrTail: ['dependency-cruiser가 대상에 설치되어 있지 않다'],
    });
  });
});
