/**
 * `readSchemas()` 테스트 (#55).
 *
 * 1) `examples/testbed`를 **실제로** 읽는다 — Prisma DMMF(`Payment` · `Refund` · `PaymentStatus`) · OpenAPI(`POST /payments` · `POST /refunds` ·
 *    422 응답 정의) · 파일별 SHA-256 안정성 · asyncapi 없음.
 * 2) 오류 변형: 파일 없음 → `missing`, 깨진 스키마 → `error`(메시지 · 줄). 이전 성공 결과를 대신 돌려주지 않는다.
 * 3) 코어 `contractView`를 testbed 전체로 돌려 Markdown에 `erDiagram` · API 표 · "계약 테스트 없음"이 나오는지 — 어댑터와 코어를 잇는 유일한 자리다
 *    (코어 테스트는 어댑터 패키지를 import할 수 없다). View JSON은 `examples/testbed/reports/contract-view.json`에 쓴다 (gitignore).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AdapterContext,
  contractView,
  loadConfig,
  openStore,
  type PlumbConfig,
  type ViewContext,
} from '@plumb/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextjsAdapter } from '../index.js';
import {
  contractPaths,
  DEFAULT_CONTRACT_PATHS,
  type NextjsSchemaSet,
  PrismaLineFinder,
  prismaToolInfo,
  readSchemas,
  toSchemaRef,
} from '../read-schemas.js';

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

// ---------------------------------------------------------------------------
// 1. examples/testbed 실제
// ---------------------------------------------------------------------------

describe('readSchemas — examples/testbed 실제', () => {
  let ctx: AdapterContext;
  let set: NextjsSchemaSet;

  beforeAll(async () => {
    const loaded = await loadConfig({ target: TESTBED });
    ctx = { root: loaded.root, config: loaded.config };
    set = await readSchemas(ctx);
  }, 60_000);

  it('기본 경로 세 개: openapi.yaml · prisma/schema.prisma · asyncapi.yaml(없음 → missing)', () => {
    expect(contractPaths(ctx)).toEqual(DEFAULT_CONTRACT_PATHS);
    expect(set.openapi.path).toBe('openapi.yaml');
    expect(set.prisma.path).toBe('prisma/schema.prisma');
    expect(set.asyncapi).toEqual({ path: 'asyncapi.yaml', status: 'missing' });
  });

  it('Prisma: Payment · Refund 모델, PaymentStatus enum, Refund N:1 Payment 관계, file:line', () => {
    expect(set.prisma.status).toBe('parsed');
    if (set.prisma.status !== 'parsed') throw new Error(`prisma: ${set.prisma.status}`);
    const db = set.prisma.data;
    expect(set.prisma.tool).toEqual({ name: 'prisma', version: prismaToolInfo().version });
    expect(set.prisma.tool.version).toMatch(/^\d+\.\d+\.\d+/);

    expect(db.models.map((m) => m.name)).toEqual(['Payment', 'Refund']);
    expect(db.enums).toEqual([
      { name: 'PaymentStatus', values: ['PAID', 'REFUNDED'], anchor: { file: 'prisma/schema.prisma', line: 13 } },
    ]);

    const payment = db.models[0];
    const refund = db.models[1];
    if (!payment || !refund) throw new Error('모델 둘');
    expect(payment.anchor).toEqual({ file: 'prisma/schema.prisma', line: 18 });
    expect(refund.anchor).toEqual({ file: 'prisma/schema.prisma', line: 28 });
    expect(payment.fields.map((f) => f.name)).toEqual([
      'id',
      'amount',
      'currency',
      'paidAt',
      'status',
      'refunds',
      'createdAt',
    ]);

    const id = payment.fields.find((f) => f.name === 'id');
    expect(id).toMatchObject({ type: 'String', kind: 'scalar', isId: true, isRequired: true, default: 'cuid()' });
    expect(id?.anchor).toEqual({ file: 'prisma/schema.prisma', line: 19 });
    expect(payment.fields.find((f) => f.name === 'status')).toMatchObject({
      type: 'PaymentStatus',
      kind: 'enum',
      default: 'PAID',
    });
    expect(payment.fields.find((f) => f.name === 'refunds')).toMatchObject({
      type: 'Refund',
      kind: 'object',
      isList: true,
      relationName: 'PaymentToRefund',
    });
    expect(payment.fields.find((f) => f.name === 'createdAt')?.default).toBe('now()');

    expect(db.relations).toEqual([
      {
        from: 'Refund',
        to: 'Payment',
        name: 'PaymentToRefund',
        cardinality: 'N:1',
        fromFields: ['paymentId'],
        toFields: ['id'],
      },
    ]);
  });

  it('OpenAPI: POST /payments · POST /refunds, operationId · tags · 요청/응답 스키마($ref 해소) · 422 정의 · 줄 번호', () => {
    expect(set.openapi.status).toBe('parsed');
    if (set.openapi.status !== 'parsed') return;
    expect(set.openapi.tool).toEqual({ name: 'openapi', version: '3.1.0' });

    const ops = set.openapi.data.operations;
    expect(ops.map((o) => `${o.method} ${o.path}`)).toEqual(['POST /payments', 'POST /refunds']);

    const payments = ops[0];
    const refunds = ops[1];
    if (!payments || !refunds) throw new Error('엔드포인트 둘');

    expect(payments).toMatchObject({
      operationId: 'createPayment',
      tags: ['payment'],
      summary: '결제 생성',
      block: { fromTags: 'payment', mismatch: false },
      anchor: { file: 'openapi.yaml', line: 26 },
    });
    expect(payments.request).toEqual({
      name: 'CreatePaymentBody',
      properties: [
        { name: 'amount', type: 'integer', required: true, minimum: 1 },
        { name: 'currency', type: 'string', required: true },
      ],
    });
    expect(payments.responses.map((r) => [r.code, r.schema?.name])).toEqual([
      ['201', 'Payment'],
      ['400', 'Error'],
    ]);

    expect(refunds).toMatchObject({ operationId: 'createRefund', anchor: { file: 'openapi.yaml', line: 51 } });
    expect(refunds.responses.map((r) => r.code)).toEqual(['201', '400', '404', '422']);
    const r422 = refunds.responses.find((r) => r.code === '422');
    expect(r422?.schema?.name).toBe('Error');
    expect(r422?.description).toContain('REFUND_WINDOW_EXCEEDED');

    expect(set.openapi.data.schemas.map((s) => s.name)).toEqual([
      'CreatePaymentBody',
      'CreateRefundBody',
      'Error',
      'Payment',
      'Refund',
    ]);
    const paymentSchema = set.openapi.data.schemas.find((s) => s.name === 'Payment');
    expect(paymentSchema?.properties.map((p) => p.name)).toEqual(['id', 'amount', 'currency', 'paidAt', 'status']);
    expect(paymentSchema?.properties.find((p) => p.name === 'paidAt')).toEqual({
      name: 'paidAt',
      type: 'string',
      required: true,
      format: 'date-time',
    });
  });

  it('해시: 파일 내용의 SHA-256, 다시 읽어도 같다', async () => {
    const sha = async (rel: string) =>
      createHash('sha256')
        .update(await readFile(join(TESTBED, rel), 'utf8'))
        .digest('hex');
    if (set.openapi.status !== 'parsed' || set.prisma.status !== 'parsed') throw new Error('parsed');
    expect(set.openapi.hash).toBe(await sha('openapi.yaml'));
    expect(set.prisma.hash).toBe(await sha('prisma/schema.prisma'));
    expect(set.openapi.hash).toMatch(/^[0-9a-f]{64}$/);

    const again = await readSchemas(ctx);
    expect(again.openapi.status === 'parsed' && again.openapi.hash).toBe(set.openapi.hash);
    expect(again.prisma.status === 'parsed' && again.prisma.hash).toBe(set.prisma.hash);
  });

  it('어댑터 인터페이스 `nextjsAdapter.readSchemas`가 같은 결과를 돌려준다', async () => {
    const viaAdapter = await nextjsAdapter.readSchemas(ctx);
    expect(viaAdapter).toEqual(set);
  });
});

// ---------------------------------------------------------------------------
// 2. 오류 변형 · 순수 함수
// ---------------------------------------------------------------------------

describe('readSchemas — 파일 없음 · 파싱 실패', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-schemas-'));
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('세 파일이 모두 없으면 전부 missing (예외 아님)', async () => {
    const set = await readSchemas({ root: dir, config: baseConfig });
    expect(set).toEqual({
      openapi: { path: 'openapi.yaml', status: 'missing' },
      prisma: { path: 'prisma/schema.prisma', status: 'missing' },
      asyncapi: { path: 'asyncapi.yaml', status: 'missing' },
    });
  });

  it('config.contracts 경로를 따른다 (앞의 ./ 제거)', async () => {
    const config: PlumbConfig = {
      ...baseConfig,
      contracts: { openapi: './api/spec.yaml', prisma: 'db/schema.prisma' },
    };
    const set = await readSchemas({ root: dir, config });
    expect(set.openapi.path).toBe('api/spec.yaml');
    expect(set.prisma.path).toBe('db/schema.prisma');
    expect(set.asyncapi.path).toBe('asyncapi.yaml');
  });

  it('깨진 Prisma 스키마 → error + 메시지 + 줄 (ANSI 없음)', async () => {
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(
      join(dir, 'prisma', 'schema.prisma'),
      'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel X {\n  id String\n}\n',
    );
    const set = await readSchemas({ root: dir, config: baseConfig });
    expect(set.prisma.status).toBe('error');
    if (set.prisma.status !== 'error') return;
    expect(set.prisma.message).toMatch(/Error validating model "X"/);
    expect(set.prisma.message).not.toContain('\u001b');
    expect(set.prisma.line).toBeTypeOf('number');
    expect(set.prisma).not.toHaveProperty('data');
  });

  it('깨진 YAML → error + 줄, OpenAPI 아님 → error, AsyncAPI 있으면 parsed', async () => {
    await writeFile(join(dir, 'openapi.yaml'), 'openapi: 3.1.0\npaths:\n  /a:\n   get: [\n');
    let set = await readSchemas({ root: dir, config: baseConfig });
    expect(set.openapi.status).toBe('error');
    if (set.openapi.status === 'error') expect(set.openapi.line).toBeTypeOf('number');

    await writeFile(join(dir, 'openapi.yaml'), 'title: not an api\n');
    set = await readSchemas({ root: dir, config: baseConfig });
    expect(set.openapi).toMatchObject({ status: 'error', message: expect.stringContaining('OpenAPI 문서가 아니다') });

    await writeFile(
      join(dir, 'asyncapi.yaml'),
      [
        'asyncapi: 3.0.0',
        'channels:',
        '  payment.refunded:',
        '    messages:',
        '      RefundCreated:',
        "        payload: { $ref: '#/components/schemas/RefundEvent' }",
        'components:',
        '  schemas:',
        '    RefundEvent:',
        '      type: object',
        '      required: [id]',
        '      properties: { id: { type: string }, amount: { type: integer } }',
      ].join('\n'),
    );
    set = await readSchemas({ root: dir, config: baseConfig });
    expect(set.asyncapi.status).toBe('parsed');
    if (set.asyncapi.status !== 'parsed') return;
    expect(set.asyncapi.tool).toEqual({ name: 'asyncapi', version: '3.0.0' });
    expect(set.asyncapi.data).toEqual({
      channels: [
        {
          name: 'payment.refunded',
          messages: [
            {
              name: 'RefundCreated',
              payload: {
                name: 'RefundEvent',
                properties: [
                  { name: 'id', type: 'string', required: true },
                  { name: 'amount', type: 'integer', required: false },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it('toSchemaRef: 인라인 스키마는 이름 없이, 해소 안 되는 $ref는 이름만', () => {
    expect(toSchemaRef({ type: 'object', properties: { a: { type: 'string' } } }, {})).toEqual({
      properties: [{ name: 'a', type: 'string', required: false }],
    });
    expect(toSchemaRef({ $ref: '#/components/schemas/Nope' }, {})).toEqual({ name: 'Nope', properties: [] });
    expect(toSchemaRef('x', {})).toBeUndefined();
  });

  it('PrismaLineFinder: 블록 줄 · 필드 줄, 못 찾으면 1 / undefined', () => {
    const finder = new PrismaLineFinder('enum E {\n  A\n}\n\nmodel M {\n  id String @id\n  n  Int\n}\n');
    expect(finder.block('model', 'M')).toBe(5);
    expect(finder.block('enum', 'E')).toBe(1);
    expect(finder.block('model', 'Nope')).toBe(1);
    expect(finder.field('model', 'M', 'n')).toEqual({ line: 7, text: '  n  Int' });
    expect(finder.field('model', 'M', 'A')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. 코어 contractView를 testbed 전체로 — Markdown
// ---------------------------------------------------------------------------

describe('contractView.generate + render — examples/testbed 실제', () => {
  let dir: string;
  let markdown: string;
  let view: Awaited<ReturnType<typeof contractView.generate>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-contract-store-'));
    const loaded = await loadConfig({ target: TESTBED });
    const store = openStore({ store: dir, blocks: loaded.config.blocks }, loaded.root);
    await store.init();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TESTBED, encoding: 'utf8' }).trim();
    // M5 상태: `plumb check`는 돌았지만 계약 테스트(`kind: contract`)는 없다 → "계약 테스트 없음"
    await store.checks.write({
      runId: 'c-0001',
      commit,
      startedAt: '2026-10-02T08:59:00.000Z',
      finishedAt: '2026-10-02T08:59:30.000Z',
      runner: { exitCode: 0 },
      results: [
        { check: { kind: 'static', ref: 'depcruise:block-1-public-entry-only' }, ruleIds: [], outcome: 'pass' },
      ],
      quarantined: [],
      counts: { junit: 0, static: 1 },
      storeStatus: 'ok',
    });
    const ctx: ViewContext = {
      root: loaded.root,
      config: loaded.config,
      store,
      adapter: nextjsAdapter,
      commit,
      now: () => new Date('2026-10-02T09:00:00.000Z'),
    };
    view = await contractView.generate(ctx);
    markdown = contractView.render(view);
    // JSON(정본)은 `examples/testbed/reports/`(gitignore)에 남긴다. Markdown은 `contractView.render(JSON)`로 언제든 다시 만든다
    await mkdir(join(TESTBED, 'reports'), { recursive: true });
    await writeFile(join(TESTBED, 'reports', 'contract-view.json'), `${JSON.stringify(view, null, 2)}\n`);
  }, 120_000);

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('계약 파일: 승인 기록 없음 → unapproved 둘 · asyncapi missing', () => {
    expect(view.files.map((f) => [f.path, f.status])).toEqual([
      ['openapi.yaml', 'unapproved'],
      ['prisma/schema.prisma', 'unapproved'],
      ['asyncapi.yaml', 'missing'],
    ]);
  });

  it('엔드포인트 소속: tags[0] = payment, 핸들러 import = payment (일치, 공개 진입점) · 모델 블록 = repo.ts가 있는 payment', () => {
    const refunds = view.api?.operations.find((o) => o.path === '/refunds');
    expect(refunds?.block).toEqual({ fromTags: 'payment', fromHandler: 'payment', mismatch: false });
    expect(refunds?.handler).toEqual({
      anchor: { file: 'src/app/api/refunds/route.ts', line: 20, block: 'app' },
      viaPublic: true,
    });
    expect(refunds?.schemaModelDiff).toEqual([
      { schema: 'Refund', model: 'Refund', onlyInSchema: [], onlyInModel: ['payment', 'createdAt'] },
    ]);
    expect(view.db?.models.map((m) => [m.name, m.block])).toEqual([
      ['Payment', 'payment'],
      ['Refund', 'payment'],
    ]);
  });

  it('계약 테스트 없음(no-contract-tests) · 승인 없음 → diff 비교 기준 없음 · 출처 여섯', () => {
    expect(view.codeConformance).toEqual({ status: 'none', reason: 'no-contract-tests' });
    expect(view.diff).toEqual({ unavailable: 'no-approved-contract' });
    expect(view.header.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(view.header.sources.map((s) => `${s.kind}:${s.tool ?? s.input ?? ''}`)).toEqual([
      'parser:prisma',
      'parser:openapi',
      'parser:dependency-cruiser',
      'store:contracts/',
      'execution:plumb check',
      'git:',
    ]);
  });

  it('Markdown: erDiagram · API 표 · "검사 없음" · 422가 계약에 정의됨(🔴 아님)', () => {
    expect(markdown.startsWith('# 데이터 모델 / 계약\n\n출처: 파서: prisma ')).toBe(true);
    expect(markdown).toContain('```mermaid\nerDiagram\n    Payment ||--o{ Refund : "refunds"');
    expect(markdown).toContain(
      '| `POST` | [/refunds](plumb://open?file=openapi.yaml&line=51) | `createRefund` | payment |',
    );
    expect(markdown).toContain('201 Refund · 400 Error · 404 Error · 422 Error');
    expect(markdown).toContain('`payment` (태그 · 핸들러)');
    expect(markdown).toContain('⬜ 계약 테스트 없음 — 상태 판정 불가');
    expect(markdown).toContain('| POST /refunds | 201 · 400 · 404 · 422 | 계약에 정의됨 · 검사 없음 |');
    expect(markdown).not.toContain('🔴');
    expect(markdown).not.toContain('🟠');
    expect(markdown).toContain('승인된 계약 없음 — 비교 기준 없음');
  });
});
