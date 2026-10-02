/**
 * 데이터 모델 / 계약 View 테스트 (#55). 어댑터는 가짜 — 코어는 어댑터 패키지를 import하지 않는다.
 * testbed 실제 실행은 `@plumb/adapter-nextjs`의 `read-schemas.test.ts` 3절이 코어 `contractView`를 끝까지 돌린다.
 *
 * - 파일 상태 네 가지 `match | changed | unapproved | missing`
 * - `codeConformance`: `not-run` · `no-contract-tests` · `pass` · `fail`(실패 ≥ 1일 때만)
 * - 소속 블록 두 출처가 다르면 🟠, 모델 블록은 `repo.ts`가 있는 블록 / 설정 매핑
 * - diff: 임시 git 저장소에서 승인 커밋 → HEAD 헝크. commit 없으면 `no-git`, 승인 없으면 `no-approved-contract`
 * - Markdown: `erDiagram` · API 표 · "계약 테스트 없음"
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, ApiSchema, BlockGraph, DbSchema, SchemaFile, SchemaSet } from '../../adapter/index.js';
import { makeTempStore, type TempStore } from '../../store/__tests__/fixtures.js';
import { sha256 } from '../../store/fs.js';
import type { CheckRun, Operation, PlumbConfig } from '../../types/index.js';
import {
  codeConformanceOf,
  contractView,
  handlerBlocks,
  parseHunks,
  routeFileOf,
  schemaModelDiff,
  toContractFile,
} from '../contract.js';
import type { ViewContext } from '../types.js';

const NOW = new Date('2026-10-02T09:00:00.000Z');

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
    payment: { include: ['src/domains/payment/**'], risk: 'high' },
    auth: { include: ['src/domains/auth/**'] },
  },
};

// ---------------------------------------------------------------------------
// 고정 입력 — testbed 모양을 본뜬 작은 계약
// ---------------------------------------------------------------------------

const SCHEMA_V1 = [
  'enum PaymentStatus {',
  '  PAID',
  '  REFUNDED',
  '}',
  '',
  'model Payment {',
  '  id      String        @id @default(cuid())',
  '  amount  Int',
  '  status  PaymentStatus @default(PAID)',
  '  refunds Refund[]',
  '}',
  '',
  'model Refund {',
  '  id        String  @id @default(cuid())',
  '  paymentId String',
  '  payment   Payment @relation(fields: [paymentId], references: [id])',
  '  amount    Int',
  '}',
  '',
].join('\n');

/** 승인 뒤 `Refund.reason` 추가 (와이어프레임의 "△ 승인 해시 이후 추가") */
const SCHEMA_V2 = SCHEMA_V1.replace('  amount    Int\n}', '  amount    Int\n  reason    String?\n}');

const OPENAPI =
  'openapi: 3.1.0\npaths:\n  /refunds:\n    post: {}\n  /login:\n    post: {}\n  /logout:\n    post: {}\n';

const DB: DbSchema = {
  models: [
    {
      name: 'Payment',
      anchor: { file: 'prisma/schema.prisma', line: 6 },
      fields: [
        { name: 'id', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false, default: 'cuid()' },
        { name: 'amount', type: 'Int', isRequired: true, isList: false, isId: false, isUnique: false },
        {
          name: 'status',
          type: 'PaymentStatus',
          isRequired: true,
          isList: false,
          isId: false,
          isUnique: false,
          default: 'PAID',
        },
        { name: 'refunds', type: 'Refund', isRequired: true, isList: true, isId: false, isUnique: false },
      ],
    },
    {
      name: 'Refund',
      anchor: { file: 'prisma/schema.prisma', line: 13 },
      fields: [
        { name: 'id', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false, default: 'cuid()' },
        { name: 'paymentId', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false },
        { name: 'payment', type: 'Payment', isRequired: true, isList: false, isId: false, isUnique: false },
        { name: 'amount', type: 'Int', isRequired: true, isList: false, isId: false, isUnique: false },
        { name: 'reason', type: 'String', isRequired: false, isList: false, isId: false, isUnique: false },
      ],
    },
  ],
  enums: [{ name: 'PaymentStatus', values: ['PAID', 'REFUNDED'], anchor: { file: 'prisma/schema.prisma', line: 1 } }],
  relations: [
    {
      from: 'Refund',
      to: 'Payment',
      name: 'PaymentToRefund',
      cardinality: 'N:1',
      fromFields: ['paymentId'],
      toFields: ['id'],
    },
  ],
};

const ERROR_SCHEMA = { name: 'Error', properties: [{ name: 'code', type: 'string', required: true }] };

function op(
  method: string,
  path: string,
  line: number,
  tag: string | undefined,
  responses: Operation['responses'],
): Operation {
  const out: Operation = {
    method,
    path,
    anchor: { file: 'openapi.yaml', line },
    responses,
    block: { mismatch: false },
  };
  if (tag !== undefined) out.block.fromTags = tag;
  return out;
}

const API: ApiSchema = {
  operations: [
    {
      ...op('POST', '/refunds', 3, 'payment', [
        {
          code: '201',
          schema: {
            name: 'Refund',
            properties: [
              { name: 'id', type: 'string', required: true },
              { name: 'paymentId', type: 'string', required: true },
              { name: 'amount', type: 'integer', required: true },
            ],
          },
        },
        { code: '422', schema: ERROR_SCHEMA },
      ]),
      operationId: 'createRefund',
      request: { name: 'CreateRefundBody', properties: [{ name: 'paymentId', type: 'string', required: true }] },
    },
    // 태그는 payment인데 핸들러는 auth를 import → 🟠
    {
      ...op('POST', '/login', 5, 'payment', [{ code: '200' }, { code: '401', schema: ERROR_SCHEMA }]),
      operationId: 'login',
    },
    // route 파일 없음 · 태그 없음
    op('POST', '/logout', 7, undefined, [{ code: '204' }]),
  ],
};

const GRAPH: BlockGraph = {
  generatedAt: NOW.toISOString(),
  tool: { name: 'dependency-cruiser', version: '18.5.0' },
  blocks: [
    { id: 'app', level: 'L1', kind: 'entry', paths: ['src/app/**'], public: [], files: 2 },
    {
      id: 'payment',
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/payment/**'],
      public: ['src/domains/payment/index.ts'],
      files: 3,
    },
    {
      id: 'auth',
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/auth/**'],
      public: ['src/domains/auth/index.ts'],
      files: 1,
    },
    { id: 'lib', level: 'L1', kind: 'domain', paths: ['src/lib/**'], public: ['src/lib/http.ts'], files: 1 },
    { id: 'db:postgresql', level: 'L0', kind: 'db', paths: [], public: [], files: 0, label: 'PostgreSQL' },
  ],
  edges: [
    {
      from: 'app',
      to: 'payment',
      count: 1,
      declared: true,
      imports: [{ file: 'src/app/api/refunds/route.ts', line: 3, specifier: '@/domains/payment', viaPublic: true }],
    },
    {
      from: 'app',
      to: 'auth',
      count: 1,
      declared: true,
      imports: [{ file: 'src/app/api/login/route.ts', line: 2, specifier: '@/domains/auth/session', viaPublic: false }],
    },
    {
      from: 'app',
      to: 'lib',
      count: 2,
      declared: true,
      imports: [
        { file: 'src/app/api/refunds/route.ts', line: 4, specifier: '@/lib/http', viaPublic: true },
        { file: 'src/app/api/login/route.ts', line: 3, specifier: '@/lib/http', viaPublic: true },
      ],
    },
  ],
  infraEdges: [],
  undetectedInfra: [],
  unclassified: [],
};

interface FakeInput {
  prisma: SchemaFile<DbSchema>;
  openapi: SchemaFile<ApiSchema>;
  graph?: BlockGraph;
}

function fakeAdapter(input: FakeInput): Adapter {
  return {
    name: 'nextjs',
    async extractDependencies() {
      return input.graph ?? GRAPH;
    },
    async generateStubs() {
      throw new Error('unused');
    },
    async runTests() {
      throw new Error('unused');
    },
    async readSchemas(): Promise<SchemaSet> {
      return { prisma: input.prisma, openapi: input.openapi, asyncapi: { path: 'asyncapi.yaml', status: 'missing' } };
    },
    async collectTraces() {
      throw new Error('unused');
    },
  };
}

function parsedPrisma(text: string): SchemaFile<DbSchema> {
  return {
    path: 'prisma/schema.prisma',
    status: 'parsed',
    hash: sha256(text),
    tool: { name: 'prisma', version: '6.19.3' },
    data: DB,
  };
}

function parsedOpenApi(): SchemaFile<ApiSchema> {
  return {
    path: 'openapi.yaml',
    status: 'parsed',
    hash: sha256(OPENAPI),
    tool: { name: 'openapi', version: '3.1.0' },
    data: API,
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=plumb-test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** 임시 레포: v1을 커밋(승인 커밋) → v2로 바꿔 커밋(HEAD). route · repo.ts 파일도 둔다 */
async function makeRepo(root: string): Promise<{ approvedCommit: string; head: string }> {
  await mkdir(join(root, 'prisma'), { recursive: true });
  await mkdir(join(root, 'src/app/api/refunds'), { recursive: true });
  await mkdir(join(root, 'src/app/api/login'), { recursive: true });
  await mkdir(join(root, 'src/domains/payment'), { recursive: true });
  await mkdir(join(root, 'src/domains/auth'), { recursive: true });
  await writeFile(join(root, 'prisma/schema.prisma'), SCHEMA_V1);
  await writeFile(join(root, 'openapi.yaml'), OPENAPI);
  await writeFile(
    join(root, 'src/app/api/refunds/route.ts'),
    "// POST /refunds\nimport * as payment from '@/domains/payment';\n\nexport async function POST(request: Request) {\n  return payment.refund(request);\n}\n",
  );
  await writeFile(
    join(root, 'src/app/api/login/route.ts'),
    "import { login } from '@/domains/auth/session';\nexport const POST = login;\n",
  );
  await writeFile(join(root, 'src/domains/payment/repo.ts'), 'export const repo = 1;\n');
  await writeFile(join(root, 'src/domains/auth/index.ts'), 'export const auth = 1;\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'v1');
  const approvedCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'prisma/schema.prisma'), SCHEMA_V2);
  git(root, 'commit', '-q', '-am', 'v2: Refund.reason');
  return { approvedCommit, head: git(root, 'rev-parse', 'HEAD') };
}

function checkRun(results: CheckRun['results']): CheckRun {
  return {
    runId: 'c-0007',
    commit: 'abc1234',
    startedAt: '2026-10-02T08:00:00.000Z',
    finishedAt: '2026-10-02T08:00:30.000Z',
    runner: { exitCode: 0 },
    results,
    quarantined: [],
    counts: { junit: results.length, static: 0 },
    storeStatus: 'ok',
  };
}

const CONTRACT_PASS: CheckRun['results'][number] = {
  check: { kind: 'contract', ref: 'test/contract/refunds.spec.ts' },
  ruleIds: ['pay.refund-contract'],
  outcome: 'pass',
};

const CONTRACT_FAIL: CheckRun['results'][number] = {
  check: { kind: 'contract', ref: 'test/contract/refund-window.spec.ts' },
  ruleIds: ['pay.refund-window'],
  outcome: 'fail',
  failure: {
    check: { kind: 'contract', ref: 'test/contract/refund-window.spec.ts' },
    anchor: { block: 'payment', file: 'test/contract/refund-window.spec.ts', line: 42 },
    message: 'expected 422 REFUND_WINDOW_EXCEEDED, got 201',
  },
};

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

let t: TempStore;
let repo: { approvedCommit: string; head: string };

beforeEach(async () => {
  t = await makeTempStore({ blocks: config.blocks });
  await mkdir(t.root, { recursive: true });
  repo = await makeRepo(t.root);
});

afterEach(() => t.cleanup());

function ctxWith(adapter: Adapter, opts: { noGit?: boolean } = {}): ViewContext {
  const commit = opts.noGit ? undefined : repo.head;
  return { root: t.root, config, store: t.store, adapter, commit, now: () => NOW };
}

describe('contractView.generate — 파일 상태 · 소속 블록 · 코드 일치 · diff', () => {
  it('승인 기록 없음: unapproved · unapproved · missing, 코드 일치 not-run, diff no-approved-contract', async () => {
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
    );

    expect(view.header).toEqual({
      view: 'contract',
      generatedAt: NOW.toISOString(),
      commit: repo.head,
      sources: [
        { kind: 'parser', tool: 'prisma', version: '6.19.3', input: 'prisma/schema.prisma' },
        { kind: 'parser', tool: 'openapi', version: '3.1', input: 'openapi.yaml' },
        { kind: 'parser', tool: 'dependency-cruiser', version: '18.5.0', input: 'src/app/api/**/route.ts' },
        { kind: 'store', input: 'contracts/' },
        { kind: 'git', commit: repo.head },
      ],
    });
    expect(view.files).toEqual([
      { path: 'openapi.yaml', kind: 'openapi', exists: true, hash: sha256(OPENAPI), status: 'unapproved' },
      { path: 'prisma/schema.prisma', kind: 'prisma', exists: true, hash: sha256(SCHEMA_V2), status: 'unapproved' },
      { path: 'asyncapi.yaml', kind: 'asyncapi', exists: false, status: 'missing' },
    ]);
    expect(view.codeConformance).toEqual({ status: 'none', reason: 'not-run' });
    expect(view.diff).toEqual({ unavailable: 'no-approved-contract' });
    expect(view.events).toBeUndefined();
  });

  it('승인 뒤: openapi match · prisma changed(헝크 +1) · asyncapi missing — 네 상태가 다 나온다', async () => {
    await t.store.contracts.approve({
      path: 'openapi.yaml',
      hash: sha256(OPENAPI),
      commit: repo.approvedCommit,
      by: 'ui',
    });
    await t.store.contracts.approve({
      path: 'prisma/schema.prisma',
      hash: sha256(SCHEMA_V1),
      commit: repo.approvedCommit,
      decision: 'D-0007',
      by: 'ui',
    });
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
    );

    expect(view.files.map((f) => f.status)).toEqual(['match', 'changed', 'missing']);
    expect(view.files[1]?.approved).toEqual({
      hash: sha256(SCHEMA_V1),
      approvedAt: expect.any(String),
      commit: repo.approvedCommit,
      decision: 'D-0007',
    });
    expect(view.diff).toEqual([
      { file: 'openapi.yaml', hunks: [], codeConformance: 'none' },
      {
        file: 'prisma/schema.prisma',
        decision: 'D-0007',
        codeConformance: 'none',
        hunks: [
          { anchor: { file: 'prisma/schema.prisma', line: 15 }, added: 1, removed: 0, excerpt: '+  reason    String?' },
        ],
      },
    ]);
    expect(view.header.sources.at(-1)).toEqual({ kind: 'git', commit: repo.head });
  });

  it('commit 없음(git 없음): 해시 비교는 되고 diff는 no-git, 머리말에 commit 키 없음', async () => {
    await t.store.contracts.approve({
      path: 'openapi.yaml',
      hash: sha256(OPENAPI),
      commit: repo.approvedCommit,
      by: 'ui',
    });
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() }), { noGit: true }),
    );
    expect(view.files[0]?.status).toBe('match');
    expect(view.diff).toEqual({ unavailable: 'no-git' });
    expect(view.header).not.toHaveProperty('commit');
    expect(view.header.sources.some((s) => s.kind === 'git')).toBe(false);
  });

  it('소속 블록: 태그=핸들러면 일치, 다르면 mismatch(둘 다 보인다), route 없으면 handler 없음 · 모델은 repo.ts가 있는 payment', async () => {
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
    );
    const [refunds, login, logout] = view.api?.operations ?? [];
    expect(refunds?.block).toEqual({ fromTags: 'payment', fromHandler: 'payment', mismatch: false });
    expect(refunds?.anchor).toEqual({ file: 'openapi.yaml', line: 3, block: 'payment' });
    expect(refunds?.handler).toEqual({
      anchor: { file: 'src/app/api/refunds/route.ts', line: 4, block: 'app' },
      viaPublic: true,
    });
    expect(refunds?.schemaModelDiff).toEqual([
      { schema: 'Refund', model: 'Refund', onlyInSchema: [], onlyInModel: ['payment', 'reason'] },
    ]);

    expect(login?.block).toEqual({ fromTags: 'payment', fromHandler: 'auth', mismatch: true });
    expect(login?.handler).toEqual({
      anchor: { file: 'src/app/api/login/route.ts', line: 2, block: 'app' },
      viaPublic: false,
    });

    expect(logout?.block).toEqual({ mismatch: false });
    expect(logout?.handler).toBeUndefined();
    expect(logout?.anchor).toEqual({ file: 'openapi.yaml', line: 7 });

    expect(view.db?.models.map((m) => [m.name, m.block, m.anchor.block])).toEqual([
      ['Payment', 'payment', 'payment'],
      ['Refund', 'payment', 'payment'],
    ]);
  });

  it('모델 블록: config.contracts.models 매핑이 repo.ts보다 우선, repo.ts 블록이 여럿이면 비운다', async () => {
    const mapped: PlumbConfig = { ...config, contracts: { models: { Refund: 'refunds' } } };
    const ctx = {
      ...ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
      config: mapped,
    };
    const view = await contractView.generate(ctx);
    expect(view.db?.models.map((m) => m.block)).toEqual(['payment', 'refunds']);

    await writeFile(join(t.root, 'src/domains/auth/repo.ts'), 'export const repo = 2;\n');
    const ambiguous = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
    );
    expect(ambiguous.db?.models.map((m) => m.block)).toEqual([undefined, undefined]);
  });

  it('codeConformance: contract 검사 없는 CheckRun → no-contract-tests, 통과만 → pass, 실패 1 → fail + failures', async () => {
    const adapter = fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() });

    await t.store.checks.write(checkRun([{ ...CONTRACT_PASS, check: { kind: 'acceptance', ref: 'x.spec.ts' } }]));
    expect((await contractView.generate(ctxWith(adapter))).codeConformance).toEqual({
      status: 'none',
      reason: 'no-contract-tests',
    });

    await t.store.checks.write({
      ...checkRun([CONTRACT_PASS, CONTRACT_PASS]),
      runId: 'c-0008',
      finishedAt: '2026-10-02T08:10:00.000Z',
    });
    const pass = await contractView.generate(ctxWith(adapter));
    expect(pass.codeConformance).toEqual({
      status: 'pass',
      passed: 2,
      failed: 0,
      ruleIds: ['pay.refund-contract'],
      lastCheck: { runId: 'c-0008', commit: 'abc1234', finishedAt: '2026-10-02T08:10:00.000Z' },
    });
    expect(pass.header.sources).toContainEqual({ kind: 'execution', tool: 'plumb check', input: 'checks/c-0008.json' });

    await t.store.checks.write({
      ...checkRun([CONTRACT_PASS, CONTRACT_FAIL]),
      runId: 'c-0009',
      finishedAt: '2026-10-02T08:20:00.000Z',
    });
    await t.store.contracts.approve({
      path: 'openapi.yaml',
      hash: sha256(OPENAPI),
      commit: repo.approvedCommit,
      by: 'ui',
    });
    const fail = await contractView.generate(ctxWith(adapter));
    expect(fail.codeConformance).toMatchObject({
      status: 'fail',
      passed: 1,
      failed: 1,
      ruleIds: ['pay.refund-contract', 'pay.refund-window'],
      failures: [CONTRACT_FAIL.failure],
    });
    expect(Array.isArray(fail.diff) && fail.diff[0]?.codeConformance).toBe('fail');
  });

  it('파싱 실패: parseError + 해시는 코어가 센다, db 절 없음 · 승인 해시와 비교는 그대로', async () => {
    await t.store.contracts.approve({
      path: 'prisma/schema.prisma',
      hash: sha256(SCHEMA_V2),
      commit: repo.head,
      by: 'ui',
    });
    const broken: SchemaFile<DbSchema> = {
      path: 'prisma/schema.prisma',
      status: 'error',
      message: 'Error validating model "Refund"',
      line: 13,
    };
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: broken, openapi: { path: 'openapi.yaml', status: 'missing' } })),
    );
    expect(view.files[1]).toMatchObject({
      status: 'match',
      hash: sha256(SCHEMA_V2),
      parseError: { message: 'Error validating model "Refund"', anchor: { file: 'prisma/schema.prisma', line: 13 } },
    });
    expect(view.db).toBeUndefined();
    expect(view.api).toBeUndefined();
    expect(view.header.sources.filter((s) => s.kind === 'parser').map((s) => s.tool)).toEqual(['dependency-cruiser']);
  });
});

describe('contractView.render — Markdown', () => {
  it('제목 · 출처 표시줄 · 계약 파일 표 · 모델 표 + erDiagram · API 표(🟠) · "계약 테스트 없음" · 변경', async () => {
    await t.store.checks.write(checkRun([]));
    await t.store.contracts.approve({
      path: 'prisma/schema.prisma',
      hash: sha256(SCHEMA_V1),
      commit: repo.approvedCommit,
      decision: 'D-0007',
      by: 'ui',
    });
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
    );
    const md = contractView.render(view);

    expect(
      md.startsWith(
        '# 데이터 모델 / 계약\n\n출처: 파서: prisma 6.19.3 (prisma/schema.prisma) · 파서: openapi 3.1 (openapi.yaml) · ',
      ),
    ).toBe(true);
    expect(md).toContain(
      `· 저장소: contracts/ · 실행: plumb check (checks/c-0007.json) · git: ${repo.head.slice(0, 7)}\n`,
    );

    // 계약 파일 표
    expect(md).toContain('## 계약 파일');
    expect(md).toContain(
      `| \`prisma/schema.prisma\` | Prisma | 변경 🔴 | \`${sha256(SCHEMA_V2).slice(0, 7)}\` | \`${sha256(SCHEMA_V1).slice(0, 7)}\` | \`${repo.approvedCommit.slice(0, 7)}\` | D-0007 |`,
    );
    expect(md).toContain('| `openapi.yaml` | OpenAPI | 미승인 ⚠ |');
    expect(md).toContain('| `asyncapi.yaml` | AsyncAPI | 파일 없음 | — | — | — | — |');

    // 데이터 모델
    expect(md).toContain('## 데이터 모델\n\n모델 2 · enum 1 · 관계 1');
    expect(md).toContain(
      '### Refund — [prisma/schema.prisma:13](plumb://open?file=prisma%2Fschema.prisma&line=13) · 블록 `payment`',
    );
    expect(md).toContain('| `paymentId` | String | 예 | FK |  |  |');
    expect(md).toContain('| `payment` | Payment | 예 |  | → Payment (N:1) |  |');
    expect(md).toContain('| `reason` | String? | 아니오 |  |  |  |');
    expect(md).toContain('| `PaymentStatus` | `PAID` · `REFUNDED` |');
    expect(md).toContain(
      [
        '```mermaid',
        'erDiagram',
        '    Payment ||--o{ Refund : "refunds"',
        '',
        '    Payment {',
        '        String id PK',
        '        Int amount',
        '        PaymentStatus status',
        '    }',
        '    Refund {',
        '        String id PK',
        '        String paymentId FK',
        '        Int amount',
        '        String reason "nullable"',
        '    }',
        '```',
      ].join('\n'),
    );

    // API 표 — 🟠는 소속 불일치 행에만
    expect(md).toContain('## API\n\n엔드포인트 3 · 블록: payment 1 · auth 1 · (소속 없음) 1');
    expect(md).toContain(
      '| `POST` | [/refunds](plumb://open?file=openapi.yaml&line=3) | `createRefund` | payment | CreateRefundBody | 201 Refund · 422 Error | `payment` (태그 · 핸들러) | [src/app/api/refunds/route.ts:4](plumb://open?file=src%2Fapp%2Fapi%2Frefunds%2Froute.ts&line=4) 🟢 공개 진입점 |',
    );
    expect(md).toContain(
      '| 🟠 소속 불일치 — 태그 `payment` · 핸들러 `auth` | [src/app/api/login/route.ts:2](plumb://open?file=src%2Fapp%2Fapi%2Flogin%2Froute.ts&line=2) 🔴 내부 파일 import |',
    );
    expect(md).toContain(
      '| `POST` | [/logout](plumb://open?file=openapi.yaml&line=7) | — | — | — | 204 | — | route 없음 |',
    );
    expect(md).toContain('- `Refund` ↔ 모델 `Refund` — 모델에만: `payment`, `reason`');

    // 계약 ↔ 코드: 테스트 없음 → 판정하지 않는다. 422는 "계약에 정의됨 · 검사 없음"
    expect(md).toContain('## 계약 ↔ 코드\n\n⬜ 계약 테스트 없음 — 상태 판정 불가');
    expect(md).toContain('| POST /refunds | 201 · 422 | 계약에 정의됨 · 검사 없음 |');
    expect(md).not.toContain('코드 불일치');

    // 변경
    expect(md).toContain(
      `### \`prisma/schema.prisma\` — \`${repo.approvedCommit.slice(0, 7)}\` → \`${repo.head.slice(0, 7)}\` · 승인 D-0007`,
    );
    expect(md).toContain('헝크 1 · +1 −0');
    expect(md).toContain(
      '| [prisma/schema.prisma:15](plumb://open?file=prisma%2Fschema.prisma&line=15) | 1 | 0 | `+  reason    String?` |',
    );
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toContain('\n\n\n');
  });

  it('비어 있을 때: 스키마 없음 · OpenAPI 없음 · 이벤트 없음 · 검사 없음 · 승인 없음 — 추정하지 않는다', async () => {
    const view = await contractView.generate(
      ctxWith(
        fakeAdapter({
          prisma: { path: 'prisma/schema.prisma', status: 'missing' },
          openapi: { path: 'openapi.yaml', status: 'missing' },
        }),
      ),
    );
    const md = contractView.render(view);
    expect(md).toContain('## 데이터 모델\n\n스키마 파일 없음 (`prisma/schema.prisma`)');
    expect(md).toContain(
      '## API\n\nOpenAPI 문서 없음 (`openapi.yaml`) — Route Handler에서 엔드포인트를 추정하지 않는다',
    );
    expect(md).toContain('## 이벤트\n\n이벤트 계약 없음 (`asyncapi.yaml` 없음)');
    expect(md).toContain('## 계약 ↔ 코드\n\n⬜ 검사 없음 — `plumb check`가 아직 실행되지 않았다');
    expect(md).toContain('## 변경\n\n승인된 계약 없음 — 비교 기준 없음\n');
    expect(md).not.toContain('```mermaid');
  });

  it('코드 불일치 🔴는 계약 테스트 실패가 있을 때만, 실패 표 + §5.4 안내', async () => {
    await t.store.checks.write(checkRun([CONTRACT_PASS, CONTRACT_FAIL]));
    const view = await contractView.generate(
      ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() })),
    );
    const md = contractView.render(view);
    expect(md).toContain(
      '🔴 코드 불일치 — 계약 테스트 1/2 실패 (`abc1234` · 2026-10-02T08:00:30.000Z). 계약 변경 승인 직후의 불일치는 정상 상태다',
    );
    expect(md).toContain(
      '| `test/contract/refund-window.spec.ts` | [test/contract/refund-window.spec.ts:42](plumb://open?file=test%2Fcontract%2Frefund-window.spec.ts&line=42) | expected 422 REFUND_WINDOW_EXCEEDED, got 201 |',
    );
    expect(md).toContain('규칙: `pay.refund-contract` · `pay.refund-window`');

    await t.store.checks.write({
      ...checkRun([CONTRACT_PASS]),
      runId: 'c-0010',
      finishedAt: '2026-10-02T08:30:00.000Z',
    });
    const ok = contractView.render(
      await contractView.generate(ctxWith(fakeAdapter({ prisma: parsedPrisma(SCHEMA_V2), openapi: parsedOpenApi() }))),
    );
    expect(ok).toContain('🟢 코드 일치 — 계약 테스트 1/1 통과 (`abc1234` · 2026-10-02T08:30:00.000Z)');
  });
});

describe('순수 함수', () => {
  it('routeFileOf: 경로 매개변수 {id} → [id]', () => {
    expect(routeFileOf('/payments')).toBe('src/app/api/payments/route.ts');
    expect(routeFileOf('/payments/{id}/refunds')).toBe('src/app/api/payments/[id]/refunds/route.ts');
    expect(routeFileOf('/', 'app/api')).toBe('app/api/route.ts');
  });

  it('handlerBlocks: 도메인 블록만 · 선언된 블록 우선 · viaPublic은 모든 import가 공개 진입점일 때', () => {
    expect(handlerBlocks(GRAPH, 'src/app/api/refunds/route.ts', new Set(['payment', 'auth']))).toEqual({
      blocks: ['payment'],
      viaPublic: true,
    });
    expect(handlerBlocks(GRAPH, 'src/app/api/refunds/route.ts', new Set())).toEqual({
      blocks: ['lib', 'payment'],
      viaPublic: true,
    });
    expect(handlerBlocks(GRAPH, 'src/app/api/login/route.ts', new Set(['auth']))).toEqual({
      blocks: ['auth'],
      viaPublic: false,
    });
    expect(handlerBlocks(GRAPH, 'src/app/api/none/route.ts', new Set())).toEqual({ blocks: [], viaPublic: true });
  });

  it('toContractFile: 네 상태', () => {
    const parsed: SchemaFile<unknown> = {
      path: 'openapi.yaml',
      status: 'parsed',
      hash: 'h1',
      tool: { name: 'openapi', version: '3.1.0' },
      data: {},
    };
    const approval = { path: 'openapi.yaml', hash: 'h1', approvedAt: NOW.toISOString(), commit: 'c1' };
    expect(toContractFile(t.root, 'openapi', parsed, approval).status).toBe('match');
    expect(toContractFile(t.root, 'openapi', parsed, { ...approval, hash: 'h2' }).status).toBe('changed');
    expect(toContractFile(t.root, 'openapi', parsed, undefined).status).toBe('unapproved');
    expect(toContractFile(t.root, 'openapi', { path: 'openapi.yaml', status: 'missing' }, approval)).toEqual({
      path: 'openapi.yaml',
      kind: 'openapi',
      exists: false,
      status: 'missing',
    });
  });

  it('codeConformanceOf: skipped는 세지 않는다, failure 없는 error는 메시지로 채운다', () => {
    expect(codeConformanceOf(null)).toEqual({ status: 'none', reason: 'not-run' });
    expect(codeConformanceOf(checkRun([{ ...CONTRACT_PASS, outcome: 'skipped' }]))).toEqual({
      status: 'none',
      reason: 'no-contract-tests',
    });
    const errored = codeConformanceOf(checkRun([{ ...CONTRACT_PASS, outcome: 'error' }]));
    expect(errored).toMatchObject({
      status: 'fail',
      failed: 1,
      failures: [{ check: CONTRACT_PASS.check, anchor: {}, message: 'error: 실패 상세 없음' }],
    });
  });

  it('parseHunks · schemaModelDiff', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,3 @@',
      ' a',
      '+b',
      ' c',
      '@@ -10 +11,0 @@',
      '-z',
    ].join('\n');
    expect(parseHunks('x', diff)).toEqual([
      { anchor: { file: 'x', line: 1 }, added: 1, removed: 0, excerpt: '+b' },
      { anchor: { file: 'x', line: 11 }, added: 0, removed: 1, excerpt: '-z' },
    ]);
    expect(
      schemaModelDiff(
        {
          name: 'Refund',
          properties: [
            { name: 'id', type: 'string', required: true },
            { name: 'note', type: 'string', required: false },
          ],
        },
        DB.models[1] as NonNullable<(typeof DB.models)[1]>,
      ),
    ).toEqual({
      schema: 'Refund',
      model: 'Refund',
      onlyInSchema: ['note'],
      onlyInModel: ['paymentId', 'payment', 'amount', 'reason'],
    });
  });
});
