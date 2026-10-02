/**
 * 기술 변경 로그 View 생성기 (#58).
 * 1) 임시 git 저장소(커밋 3개) + 커밋별로 다른 그래프를 돌려주는 가짜 어댑터 → base 커밋 worktree 전후 비교로 6종 중 5종 감지,
 *    결정 기록 명시 연결(`links.commits`) · 블록+시각 연결 · `noReason` 세 값 · `metric` · `incompleteRecords` · Markdown
 * 2) base 없음(HEAD만) — 전후 비교는 건너뛰고 `rule-changed`만. 어댑터는 부르지 않는다
 * 3) 감지기 하나가 던지면 `detectorErrors` 1 + 나머지 정상
 * 4) `examples/testbed` **실제** 루트 + 빌드된 `nextjsAdapter` — `rule propose → approve` 뒤 `rule-changed` 1 + D-0001(`links.rules`) 연결
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AdapterContext, BlockGraph, SchemaSet } from '../../adapter/types.js';
import { loadConfig, plumbConfigSchema } from '../../config/index.js';
import { writeDecision } from '../../decisions/store.js';
import { proposalFor, REFUND_RULE } from '../../store/__tests__/fixtures.js';
import { openStore, type Store } from '../../store/index.js';
import type { ChangelogView, CheckRun, PlumbConfig } from '../../types/index.js';
import {
  changelogView,
  DETECTORS,
  detectChangeEvents,
  generateChangelogView,
  listCommits,
  renderChangelogView,
  withBaseWorktree,
} from '../changelog.js';
import type { ViewContext } from '../types.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const TESTBED = join(REPO_ROOT, 'examples', 'testbed');
const ADAPTER_DIST = join(REPO_ROOT, 'packages', 'adapter-nextjs', 'dist', 'index.js');
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
  blocks: { a: { include: ['src/domains/a/**'] } },
});

// ---------------------------------------------------------------------------
// 임시 git 저장소 · 가짜 어댑터
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** CI에는 git 사용자 설정이 없을 수 있다 — 커밋마다 명시한다 */
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

async function tempStore(root: string, config: PlumbConfig = FAKE_CONFIG): Promise<Store> {
  const dir = await tempDir('plumb-changelog-store-');
  const store = openStore({ store: join(dir, 'store'), blocks: config.blocks }, root, { now: () => NOW });
  await store.init();
  return store;
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

const OPENAPI_V1 = 'openapi: 3.1.0\npaths:\n  /login:\n    post:\n      tags: [a]\n';
const OPENAPI_V2 = `${OPENAPI_V1}  /refunds:\n    post:\n      tags: [b]\n`;

interface Repo {
  root: string;
  c1: string;
  c2: string;
  c3: string;
}

/**
 * c1: 블록 a · 의존 a · /login — c2: 의존 ioredis 추가 + 계약 /refunds 추가 — c3: 새 도메인 b(ioredis import) + a → b import
 */
async function makeRepo(): Promise<Repo> {
  const root = await tempDir('plumb-changelog-git-');
  sh(root, ['init', '-q', '-b', 'main']);
  const commitAll = (message: string) => {
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', message]);
    return sh(root, ['rev-parse', 'HEAD']).trim();
  };
  const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'g', dependencies: deps }, null, 2);

  await mkdir(join(root, 'src', 'domains', 'a'), { recursive: true });
  await writeFile(join(root, 'src', 'domains', 'a', 'index.ts'), 'export const a = 1;\n');
  await writeFile(join(root, '.dependency-cruiser.cjs'), 'module.exports = { forbidden: [] };\n');
  await writeFile(join(root, 'package.json'), pkg({ a: '^1.0.0' }));
  await writeFile(join(root, 'pnpm-lock.yaml'), lockWith({ a: { specifier: '^1.0.0', version: '1.0.0' } }));
  await writeFile(join(root, 'openapi.yaml'), OPENAPI_V1);
  const c1 = commitAll('init');

  await writeFile(join(root, 'package.json'), pkg({ a: '^1.0.0', ioredis: '^5.4.0' }));
  await writeFile(
    join(root, 'pnpm-lock.yaml'),
    lockWith({ a: { specifier: '^1.0.0', version: '1.0.0' }, ioredis: { specifier: '^5.4.0', version: '5.4.1' } }),
  );
  await writeFile(join(root, 'openapi.yaml'), OPENAPI_V2);
  const c2 = commitAll('feat: refunds + redis client');

  await mkdir(join(root, 'src', 'domains', 'b'), { recursive: true });
  await writeFile(
    join(root, 'src', 'domains', 'b', 'index.ts'),
    "import Redis from 'ioredis';\nexport const b = Redis;\n",
  );
  await writeFile(join(root, 'src', 'domains', 'a', 'index.ts'), "import { b } from '../b';\nexport const a = b;\n");
  const c3 = commitAll('feat: domain b');
  return { root, c1, c2, c3 };
}

const GRAPH_BEFORE: BlockGraph = {
  generatedAt: NOW.toISOString(),
  tool: { name: 'dependency-cruiser', version: '18.5.0' },
  blocks: [
    { id: 'a', level: 'L1', kind: 'domain', paths: ['src/domains/a/**'], public: ['src/domains/a/index.ts'], files: 1 },
  ],
  edges: [],
  infraEdges: [],
  undetectedInfra: ['db', 'cache', 'queue', 'external-api'],
  unclassified: [],
};

const GRAPH_AFTER: BlockGraph & { externals: Record<string, string[]> } = {
  ...GRAPH_BEFORE,
  blocks: [
    ...GRAPH_BEFORE.blocks,
    { id: 'b', level: 'L1', kind: 'domain', paths: ['src/domains/b/**'], public: ['src/domains/b/index.ts'], files: 1 },
    {
      id: 'cache',
      level: 'L0',
      kind: 'cache',
      paths: [],
      public: [],
      files: 0,
      label: 'redis',
      evidence: [
        {
          anchor: { file: 'src/domains/b/index.ts', line: 1 },
          excerpt: "import Redis from 'ioredis'",
          source: 'parser',
        },
      ],
    },
  ],
  edges: [
    {
      from: 'a',
      to: 'b',
      count: 1,
      declared: false,
      imports: [{ file: 'src/domains/a/index.ts', line: 1, specifier: '../b', viaPublic: true }],
    },
  ],
  infraEdges: [{ from: 'app', to: 'cache', via: { kind: 'package', name: 'ioredis' }, blocks: ['b'] }],
  undetectedInfra: ['db', 'queue', 'external-api'],
  externals: { ioredis: ['b'] },
};

/** 커밋별(= 체크아웃된 루트별)로 다른 결과를 돌려주는 가짜 어댑터. `src/domains/b`가 있으면 "후", 없으면 "전" */
function fakeAdapter(calls: { graph: string[]; schemas: string[] } = { graph: [], schemas: [] }): Adapter {
  const notImplemented = (method: string) => async () => {
    throw new Error(`${method} 미구현`);
  };
  return {
    name: 'nextjs',
    async extractDependencies(ctx: AdapterContext) {
      calls.graph.push(ctx.root);
      return existsSync(join(ctx.root, 'src', 'domains', 'b')) ? GRAPH_AFTER : GRAPH_BEFORE;
    },
    async readSchemas(ctx: AdapterContext): Promise<SchemaSet> {
      calls.schemas.push(ctx.root);
      const text = await readFile(join(ctx.root, 'openapi.yaml'), 'utf8');
      const operations = [
        {
          method: 'POST',
          path: '/login',
          anchor: { file: 'openapi.yaml', line: 3 },
          responses: [],
          block: { fromTags: 'a', mismatch: false },
        },
      ];
      if (text.includes('/refunds')) {
        operations.push({
          method: 'POST',
          path: '/refunds',
          anchor: { file: 'openapi.yaml', line: 6 },
          responses: [],
          block: { fromTags: 'b', mismatch: false },
        });
      }
      return {
        openapi: {
          path: 'openapi.yaml',
          status: 'parsed',
          hash: String(text.length),
          tool: { name: 'openapi', version: '3.1.0' },
          data: { operations },
        },
        prisma: { path: 'prisma/schema.prisma', status: 'missing' },
        asyncapi: { path: 'asyncapi.yaml', status: 'missing' },
      };
    },
    generateStubs: notImplemented('generateStubs'),
    runTests: notImplemented('runTests'),
    collectTraces: notImplemented('collectTraces'),
  };
}

function checkRunAt(commit: string, finishedAt: string, metrics?: CheckRun['metrics']): CheckRun {
  const run: CheckRun = {
    runId: `c-${finishedAt.replace(/[-:.]/g, '')}`,
    commit,
    startedAt: finishedAt,
    finishedAt,
    runner: { exitCode: 0 },
    results: [],
    quarantined: [],
    counts: { junit: 0, static: 0 },
    storeStatus: 'ok',
  };
  if (metrics !== undefined) run.metrics = metrics;
  return run;
}

function ctxOf(root: string, store: Store, adapter: Adapter, commit: string | undefined): ViewContext {
  return { root, config: FAKE_CONFIG, store, adapter, commit, now: () => NOW };
}

function allEvents(view: ChangelogView) {
  return view.groups.flatMap((g) => g.events);
}

// ---------------------------------------------------------------------------
// 1. 임시 git 저장소 — base 커밋 worktree 전후 비교
// ---------------------------------------------------------------------------

describe('generate — 임시 git 저장소, base = 마지막 CheckRun.commit', () => {
  it('의존 추가 · 계약 변경 · 새 블록 · 경계 넘는 간선 · 새 외부 시스템을 감지하고 결정 기록을 연결한다', async () => {
    const repo = await makeRepo();
    const store = await tempStore(repo.root);
    await store.checks.write(checkRunAt(repo.c1, '2026-10-01T00:00:00.000Z', { noReasonEvents: 1, totalEvents: 2 }));
    // 명시 연결: c2 커밋 → 그 커밋의 이벤트 둘(의존 추가 · 계약 변경)에 붙는다. 아래 D-0002도 블록 b + 시각으로 같이 붙지만 이쪽에 이유가 있어 null
    await writeDecision(store.paths, {
      id: 'D-0001',
      title: '환불 API와 redis 클라이언트 도입',
      block: 'a',
      date: '2026-09-01T00:00:00Z',
      decision: 'ioredis를 쓴다',
      reason: '세션 TTL',
      rejected: 'in-memory',
      accepted: '인프라 1개',
      links: { rules: [], commits: [repo.c2], events: [], packages: [], services: [] },
    });
    // 블록 + 시각 연결: 블록 b, 지금 — 이유가 비어 있어 연결된 이벤트는 empty-reason. 기각도 비어 "불완전"
    await writeDecision(store.paths, {
      id: 'D-0002',
      title: '도메인 b 분리',
      block: 'b',
      date: new Date().toISOString(),
      decision: 'b를 따로 둔다',
      reason: '',
      rejected: '',
      accepted: '없음',
      links: { rules: [], commits: [], events: [], packages: [], services: [] },
    });

    const calls = { graph: [] as string[], schemas: [] as string[] };
    const view = await generateChangelogView(ctxOf(repo.root, store, fakeAdapter(calls), repo.c3));

    expect(view.header).toMatchObject({ view: 'changelog', generatedAt: NOW.toISOString(), commit: repo.c3 });
    expect(view.range).toEqual({ base: repo.c1, head: repo.c3, commits: 2 });
    // 어댑터는 HEAD(대상 루트)와 base(임시 worktree)에서 한 번씩 — worktree는 끝나면 지워진다
    expect(calls.graph).toHaveLength(2);
    expect(calls.graph[0]).toBe(repo.root);
    expect(calls.graph[1]).not.toBe(repo.root);
    expect(existsSync(calls.graph[1] as string)).toBe(false);
    expect(sh(repo.root, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);

    const events = allEvents(view);
    expect(events.map((e) => e.kind).sort()).toEqual([
      'block-boundary',
      'contract-changed',
      'cross-block-dependency',
      'dependency-added',
      'external-system',
    ]);
    const byKind = Object.fromEntries(events.map((e) => [e.kind, e]));
    expect(byKind['dependency-added']).toMatchObject({
      title: 'ioredis@5.4.1',
      blocks: ['b'],
      commit: repo.c2,
      session: 'manual',
      decisionIds: ['D-0001', 'D-0002'],
      noReason: null,
    });
    expect(byKind['dependency-added']?.evidence).toEqual([
      { source: 'git', anchor: { file: 'package.json', line: 5 }, excerpt: '+ "ioredis": "^5.4.0"', after: '5.4.1' },
      { source: 'parser', anchor: { file: 'pnpm-lock.yaml', line: 10 }, excerpt: 'ioredis@5.4.1' },
    ]);
    expect(byKind['contract-changed']).toMatchObject({
      title: 'POST /refunds 추가',
      blocks: ['b'],
      commit: repo.c2,
      decisionIds: ['D-0001', 'D-0002'],
      noReason: null,
    });
    expect(byKind['contract-changed']?.evidence[0]).toEqual({
      source: 'parser',
      anchor: { file: 'openapi.yaml', line: 6 },
      excerpt: 'POST /refunds 추가',
    });
    expect(byKind['contract-changed']?.evidence[1]).toMatchObject({ source: 'git', anchor: { file: 'openapi.yaml' } });
    expect(byKind['block-boundary']).toMatchObject({
      title: '새 블록 b',
      blocks: ['b'],
      commit: repo.c3,
      decisionIds: ['D-0002'],
      noReason: 'empty-reason',
    });
    expect(byKind['external-system']).toMatchObject({
      title: 'redis',
      blocks: ['b'],
      commit: repo.c3,
      decisionIds: ['D-0002'],
      noReason: 'empty-reason',
    });
    expect(byKind['cross-block-dependency']).toMatchObject({
      title: 'a → b',
      blocks: ['a'],
      commit: repo.c3,
      decisionIds: [],
      noReason: 'no-record',
      linkedRules: [],
    });
    // ID는 종류 · 대상 · 커밋의 해시 — 다시 생성해도 같다
    for (const e of events) expect(e.id).toMatch(/^E-[0-9a-f]{8}$/);
    const again = await generateChangelogView(ctxOf(repo.root, store, fakeAdapter(), repo.c3));
    expect(allEvents(again).map((e) => e.id)).toEqual(events.map((e) => e.id));

    expect(view.groups.map((g) => [g.commit, g.events.length])).toEqual([
      [repo.c3, 3],
      [repo.c2, 2],
    ]);
    expect(view.metric).toEqual({ noReason: 3, total: 5 });
    expect(view.trend).toEqual([0.5]);
    expect(view.orphanDecisions).toEqual([]);
    expect(view.incompleteRecords).toBe(1);
    expect(view.detectorErrors).toEqual([]);
    expect(view.header.sources).toEqual([
      { kind: 'git', commit: repo.c3, input: `${repo.c1.slice(0, 7)}..${repo.c3.slice(0, 7)}` },
      { kind: 'parser', tool: 'dependency-cruiser', version: '18.5.0' },
      { kind: 'parser', tool: 'openapi', version: '3.1', input: 'openapi.yaml' },
      { kind: 'store', input: 'decisions/' },
      { kind: 'store', input: 'approvals/' },
      { kind: 'execution', tool: 'plumb check', input: 'checks/' },
    ]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);

    const md = renderChangelogView(view);
    expect(md.startsWith('# 기술 변경 로그\n\n출처: git: ')).toBe(true);
    expect(md).toContain(`기준 \`${repo.c1.slice(0, 7)}\` ← \`${repo.c3.slice(0, 7)}\` (2 커밋)`);
    expect(md).toContain('사유 없는 설계 변경 이벤트 3 / 5 (60%)');
    expect(md).toContain('추이 (최근 1회 검사) 50%');
    expect(md).toContain('불완전 기록 1');
    expect(md).toContain(`## \`${repo.c3.slice(0, 7)}\` · `);
    expect(md).toContain(
      '| ⊕ 새 의존성 도입 | ioredis@5.4.1 | `b` | [package.json:5](plumb://open?file=package.json&line=5) · ',
    );
    expect(md).toContain('[D-0001](#d-0001)');
    expect(md).toContain('| ⇄ 블록 경계를 넘는 의존 | a → b | `a` | ');
    expect(md).toContain('🔺 **사유 없음** (기록 없음)');
    expect(md).toContain('[D-0002](#d-0002) · 🔺 **사유 없음** (이유 비어 있음)');
    expect(md).toContain(
      '## 결정 기록\n\n<a id="d-0001"></a>\n\n### D-0001\n\n저장소: decisions/D-0001.md · 3등급(기록)',
    );
    expect(md).toContain('### D-0002\n\n저장소: decisions/D-0002.md · 3등급(기록) · 이벤트 ');
    expect(md).toContain('이유: (비어 있음) 🔺');
    expect(md).toContain('## 고아 결정 기록\n\n없음');
    expect(md).not.toContain('## 감지 실패');

    // 저장 → 다음 생성의 base는 이 View의 커밋(= HEAD) → 범위 비어 있음
    await store.views.write('changelog', view, md);
    const next = await generateChangelogView(ctxOf(repo.root, store, fakeAdapter(), repo.c3));
    expect(next.range).toEqual({ base: repo.c3, head: repo.c3, commits: 0 });
    expect(next.metric).toBe('no-events');
    expect(next.groups).toEqual([]);
    expect(next.orphanDecisions.map((d) => d.id)).toEqual(['D-0001', 'D-0002']);
    const nextMd = renderChangelogView(next);
    expect(nextMd).toContain(
      `이 범위에 설계 변경 이벤트 없음 (기준 \`${repo.c3.slice(0, 7)}\` ← \`${repo.c3.slice(0, 7)}\` (0 커밋))`,
    );
    expect(nextMd).toContain('이벤트에 연결되지 않은 결정 기록 2개');
  }, 60_000);

  it('withBaseWorktree: base를 체크아웃한 루트를 넘기고, 콜백이 던져도 worktree를 지운다', async () => {
    const repo = await makeRepo();
    let seen = '';
    const result = await withBaseWorktree(repo.root, repo.c1, async (baseRoot) => {
      seen = baseRoot;
      expect(existsSync(join(baseRoot, 'src', 'domains', 'a', 'index.ts'))).toBe(true);
      expect(existsSync(join(baseRoot, 'src', 'domains', 'b'))).toBe(false);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(existsSync(seen)).toBe(false);
    await expect(
      withBaseWorktree(repo.root, repo.c2, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sh(repo.root, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. base 없음 — HEAD만, 규칙 변경만
// ---------------------------------------------------------------------------

describe('generate — base 없음(첫 실행)', () => {
  it('전후 비교 감지기는 건너뛰고(어댑터 호출 0) 승인 기록 · 완화 제안만 이벤트가 된다', async () => {
    const repo = await makeRepo();
    const store = await tempStore(repo.root);
    await store.proposals.write(proposalFor(REFUND_RULE));
    const approved = await store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: 'p-0001', by: 'tester' });
    expect(approved.applied).toBe(true);
    await store.proposals.write(
      proposalFor(REFUND_RULE, {
        id: 'p-0002',
        changeKind: 'relax',
        before: REFUND_RULE,
        after: { ...REFUND_RULE, statement: 'WHEN 14일을 초과하면 거절한다' },
        applied: 'pending',
        proposedAt: '2026-10-01T06:00:00.000Z',
      }),
    );

    const calls = { graph: [] as string[], schemas: [] as string[] };
    const view = await generateChangelogView(ctxOf(repo.root, store, fakeAdapter(calls), repo.c3));
    expect(calls).toEqual({ graph: [], schemas: [] });
    expect(view.range).toEqual({ head: repo.c3, commits: 1 });
    expect(view.range.base).toBeUndefined();

    const events = allEvents(view);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 'rule-changed' && e.commit === repo.c3 && e.session === 'manual')).toBe(true);
    const titles = events.map((e) => e.title).sort();
    expect(titles).toEqual(['규칙 완화 제안 pay.refund-window', '규칙 추가 pay.refund-window']);
    const approvalEvent = events.find((e) => e.title.startsWith('규칙 추가'));
    expect(approvalEvent).toMatchObject({
      blocks: ['payment'],
      noReason: 'no-record',
      decisionIds: [],
      evidence: [
        {
          source: 'store',
          excerpt: 'approvals/pay.refund-window.jsonl · approve · tester',
          after: REFUND_RULE.statement,
        },
      ],
    });
    expect(approvalEvent?.at).toBe(approved.applied ? approved.approval.at : '');
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.commit).toBe(repo.c3);
    expect(view.metric).toEqual({ noReason: 2, total: 2 });
    expect(view.trend).toEqual([]);
    expect(view.header.sources).toEqual([
      { kind: 'git', commit: repo.c3, input: 'HEAD' },
      { kind: 'store', input: 'decisions/' },
      { kind: 'store', input: 'approvals/' },
    ]);

    const md = renderChangelogView(view);
    expect(md).toContain(`기준 없음 · HEAD \`${repo.c3.slice(0, 7)}\`만`);
    expect(md).toContain('추이 없음 (검사 지표 기록 없음)');
    expect(md).toContain(
      '| ⚖ 규칙 변경 · 완화 제안 | 규칙 추가 pay.refund-window | `payment` | approvals/pay.refund-window.jsonl · approve · tester | 🔺 **사유 없음** (기록 없음) | 수동 |',
    );
  }, 30_000);

  it('git이 없는 루트: head는 unknown, 커밋 0, 이벤트 없음 — 추정하지 않는다', async () => {
    const root = await tempDir('plumb-changelog-nogit-');
    const store = await tempStore(root);
    const view = await generateChangelogView(ctxOf(root, store, fakeAdapter(), undefined));
    expect(view.range).toEqual({ head: 'unknown', commits: 0 });
    expect(view.metric).toBe('no-events');
    expect(view.header).not.toHaveProperty('commit');
    expect(view.header.sources.some((s) => s.kind === 'git')).toBe(false);
    expect(renderChangelogView(view)).toContain('이 범위에 설계 변경 이벤트 없음 (기준 없음 · HEAD `unknown`만)');
  });
});

// ---------------------------------------------------------------------------
// 3. 감지기 하나 실패
// ---------------------------------------------------------------------------

describe('detectorErrors — 감지기 하나가 던져도 나머지는 계속', () => {
  it('계약 감지기가 던지면 contract-changed만 빠지고 감지 실패 절에 적힌다', async () => {
    const repo = await makeRepo();
    const store = await tempStore(repo.root);
    await store.checks.write(checkRunAt(repo.c1, '2026-10-01T00:00:00.000Z'));
    const detectors = {
      ...DETECTORS,
      contract: {
        ...DETECTORS.contract,
        run: () => {
          throw new Error('openapi.yaml: 파싱 실패\n두 번째 줄');
        },
      },
    };
    const view = await generateChangelogView(ctxOf(repo.root, store, fakeAdapter(), repo.c3), { detectors });
    expect(view.detectorErrors).toEqual([{ kind: 'contract-changed', message: 'openapi.yaml: 파싱 실패\n두 번째 줄' }]);
    expect(
      allEvents(view)
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['block-boundary', 'cross-block-dependency', 'dependency-added', 'external-system']);
    expect(view.metric).toEqual({ noReason: 4, total: 4 });
    const md = renderChangelogView(view);
    expect(md).toContain(
      '## 감지 실패\n\n실패한 종류는 지표의 분모에서 빠진다\n\n| 종류 | 오류 |\n| --- | --- |\n| ≡ 계약 변경 | openapi.yaml: 파싱 실패 |',
    );
  }, 60_000);

  it('detectChangeEvents: base 없음 → needsBase 감지기는 skipped, 그래프 없는 전후 비교는 detectorErrors', async () => {
    const skipped = await detectChangeEvents({
      root: '/nonexistent',
      head: 'unknown',
      headAt: NOW.toISOString(),
      commits: [],
      contractPaths: { openapi: 'openapi.yaml', prisma: 'prisma/schema.prisma', asyncapi: 'asyncapi.yaml' },
      rulesHistory: { approvals: [], proposals: [], rules: [] },
    });
    expect(skipped.events).toEqual([]);
    expect(skipped.detectorErrors).toEqual([]);
    expect(skipped.skipped.sort()).toEqual([
      'block-boundary',
      'contract-changed',
      'cross-block-dependency',
      'dependency-added',
      'dependency-removed',
      'external-system',
    ]);

    const repo = await makeRepo();
    const failed = await detectChangeEvents({
      root: repo.root,
      base: repo.c1,
      head: repo.c3,
      headAt: NOW.toISOString(),
      commits: listCommits(repo.root, repo.c1, repo.c3) ?? [],
      graphError: 'dependency-cruiser가 대상에 설치되어 있지 않다',
      contractPaths: { openapi: 'openapi.yaml', prisma: 'prisma/schema.prisma', asyncapi: 'asyncapi.yaml' },
      rulesHistory: { approvals: [], proposals: [], rules: [] },
    });
    expect(failed.detectorErrors.map((e) => e.kind).sort()).toEqual([
      'block-boundary',
      'cross-block-dependency',
      'external-system',
    ]);
    expect(failed.detectorErrors.every((e) => e.message === 'dependency-cruiser가 대상에 설치되어 있지 않다')).toBe(
      true,
    );
    // 그래프 없이도 의존 추가(블록은 모름 → 빈 배열) · 계약 파일 변경(스키마 없음 → 파일 단위)은 감지된다
    expect(failed.events.map((e) => [e.kind, e.title, e.blocks]).sort()).toEqual([
      ['contract-changed', 'openapi.yaml 변경', []],
      ['dependency-added', 'ioredis@5.4.1', []],
    ]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. examples/testbed 실제 실행 — HEAD만(저장소가 비어 base 없음) → rule propose → approve → rule-changed + D-0001
// ---------------------------------------------------------------------------

describe('changelogView — examples/testbed 실제 실행 (nextjsAdapter, base 없음)', () => {
  it('승인 1건 → rule-changed 1 · links.rules로 D-0001 연결 · Markdown에 D-0001', async () => {
    if (!existsSync(ADAPTER_DIST)) {
      throw new Error(
        `@plumb/adapter-nextjs가 빌드되어 있지 않다: ${ADAPTER_DIST} — pnpm --filter @plumb/adapter-nextjs build`,
      );
    }
    const mod = (await import(/* @vite-ignore */ pathToFileURL(ADAPTER_DIST).href)) as { nextjsAdapter: Adapter };
    const loaded = await loadConfig({ target: TESTBED });
    const dir = await tempDir('plumb-changelog-testbed-');
    const store = openStore({ store: join(dir, 'store'), blocks: loaded.config.blocks }, loaded.root, {
      now: () => NOW,
    });
    await store.init();
    // plumb init(M10) 전까지 결정 기록 예시는 저장소로 복사해 쓴다 (D-0001.md 머리 주석)
    await copyFile(join(TESTBED, 'plumb', 'decisions', 'D-0001.md'), join(store.paths.decisionsDir, 'D-0001.md'));
    const proposal = JSON.parse(await readFile(join(TESTBED, 'plumb', 'proposals', 'pay.refund-window.json'), 'utf8'));
    await store.proposals.write(proposal);
    const approved = await store.approvals.approve({ ruleId: 'pay.refund-window', proposalId: 'p-0001', by: 'tester' });
    expect(approved.applied).toBe(true);

    const view = await changelogView.generate({
      root: loaded.root,
      config: loaded.config,
      store,
      adapter: mod.nextjsAdapter,
      commit: undefined,
      now: () => NOW,
    });
    expect(view.range.base).toBeUndefined();
    expect(view.range.head).toMatch(/^[0-9a-f]{40}$/);
    const events = allEvents(view);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'rule-changed',
      title: '규칙 추가 pay.refund-window',
      blocks: ['payment'],
      session: 'manual',
      decisionIds: ['D-0001'],
      noReason: null,
      linkedRules: [{ ruleId: 'pay.refund-window', status: null, exists: true }],
    });
    expect(view.metric).toEqual({ noReason: 0, total: 1 });
    expect(view.orphanDecisions).toEqual([]);
    expect(view.incompleteRecords).toBe(0);
    expect(view.detectorErrors).toEqual([]);

    const md = changelogView.render(view);
    expect(md).toContain(
      '| ⚖ 규칙 변경 · 완화 제안 | 규칙 추가 pay.refund-window | `payment` | approvals/pay.refund-window.jsonl · approve · tester | [D-0001](#d-0001) | 수동 |',
    );
    expect(md).toContain('### D-0001\n\n저장소: decisions/D-0001.md · 3등급(기록) · 이벤트 `E-');
    expect(md).toContain('연결 규칙 `pay.refund-window` ⬜ · 이유 있음');
    expect(md).not.toContain('사유 없음');

    const stored = await store.views.write('changelog', view, md);
    expect((await store.views.read('changelog'))?.markdown).toBe(stored.markdown.replace(/\n$/, ''));
  }, 60_000);
});
