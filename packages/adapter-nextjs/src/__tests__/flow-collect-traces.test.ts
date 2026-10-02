/**
 * #59 — `collectTraces()`를 `examples/testbed`에 **실제로** 돌린다: Vitest + `instrumentation-test.ts`(setupFiles) → `reports/traces/*.jsonl`.
 * testbed 단위 테스트는 repo를 모킹하므로 DB 없이 돈다 — 그래서 여기 스팬은 블록 공개 진입점 래퍼(`payment.refund` 등)와 테스트 루트
 * 스팬뿐이고 `prisma:client:operation`은 없다 (DB 스팬은 spike에서 실제 DB로 확인했다. PR 본문의 측정 표).
 *
 * 마지막 describe는 코어 `createFlowGenerator()`를 어댑터와 함께 끝까지 돌려 View JSON·Markdown을 만든다 (`.work/flow-view.md`, gitignore).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AdapterContext,
  createFlowGenerator,
  type FlowView,
  loadConfigFile,
  openStore,
  spanTestId,
  type TraceSpan,
  type ViewContext,
} from '@plumb/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectTraces, parseSpanLine, readTraceDir, resolveTraceDir, TRACE_OUT_ENV } from '../collect-traces.js';
import { nextjsAdapter } from '../index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const packageDir = join(here, '../..');
const testbedRoot = join(here, '../../../../examples/testbed');

let ctx: AdapterContext;

beforeAll(async () => {
  const loaded = await loadConfigFile(join(testbedRoot, 'plumb.config.json'));
  ctx = { root: testbedRoot, config: loaded.config };
});

const RUNNER_TIMEOUT = 120_000;

describe('parseSpanLine — OTLP JSON Span 한 줄 → TraceSpan', () => {
  it('kind · status 정수를 이름으로, 속성 KeyValue[]를 레코드로, test.file·test.name을 testId로', () => {
    const line = JSON.stringify({
      traceId: 't1',
      spanId: 's2',
      parentSpanId: 's1',
      name: 'payment.refund',
      kind: 1,
      startTimeUnixNano: '10',
      endTimeUnixNano: '20',
      attributes: [
        { key: 'plumb.block', value: { stringValue: 'payment' } },
        { key: 'test.file', value: { stringValue: 'test/acceptance/refund.spec.ts' } },
        { key: 'test.name', value: { stringValue: '정상 환불' } },
        { key: 'retries', value: { intValue: '2' } },
        { key: 'ok', value: { boolValue: true } },
      ],
      status: { code: 2, message: 'boom' },
    });
    expect(parseSpanLine(line)).toEqual<TraceSpan>({
      traceId: 't1',
      spanId: 's2',
      parentSpanId: 's1',
      name: 'payment.refund',
      kind: 'internal',
      startTimeUnixNano: '10',
      endTimeUnixNano: '20',
      attributes: {
        'plumb.block': 'payment',
        'test.file': 'test/acceptance/refund.spec.ts',
        'test.name': '정상 환불',
        retries: 2,
        ok: true,
      },
      status: { code: 'error', message: 'boom' },
      testId: { classname: 'test/acceptance/refund.spec.ts', name: '정상 환불' },
    });
  });

  it('JSON이 아니거나 Span 모양이 아니면 null', () => {
    expect(parseSpanLine('not json')).toBeNull();
    expect(parseSpanLine('{"foo":1}')).toBeNull();
  });
});

describe('collectTraces(): testbed에서 Vitest를 OTel setupFiles와 함께 실행', () => {
  it(
    '스팬 파일이 생기고 payment.refund · payment.createPayment 래퍼 스팬과 테스트별 루트 스팬이 있다 (스팬 ≥ 1)',
    async () => {
      const result = await collectTraces(ctx, {});

      expect('spans' in result).toBe(true);
      if (!('spans' in result)) return;

      expect(result.spans.length).toBeGreaterThanOrEqual(1);
      expect(result.files.length).toBeGreaterThanOrEqual(1);
      for (const file of result.files) expect(file).toMatch(/^reports\/traces\/spans-\d+-\d+\.jsonl$/);
      expect(result.tool.name).toBe('otel');
      expect(result.tool.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.run?.exitCode).toBe(0);
      expect(result.run?.output.command).toMatch(/^node_modules\/\.bin\/vitest run /);

      const names = result.spans.map((s) => s.name);
      expect(names.filter((n) => n === 'payment.refund').length).toBeGreaterThanOrEqual(1);
      expect(names.filter((n) => n === 'payment.createPayment').length).toBeGreaterThanOrEqual(1);

      // 테스트별 루트 스팬 — 단위 테스트 7개, 서로 다른 test.name, 부모 없음
      const roots = result.spans.filter((s) => s.parentSpanId === undefined);
      expect(roots).toHaveLength(7);
      expect(new Set(roots.map((r) => r.attributes['test.name'])).size).toBe(7);

      // 섞이지 않는다: 래퍼 스팬의 test.name == 그 루트 스팬의 test.name
      const byId = new Map(result.spans.map((s) => [s.spanId, s]));
      for (const span of result.spans) {
        if (span.parentSpanId === undefined) continue;
        let root = span;
        while (root.parentSpanId && byId.has(root.parentSpanId)) root = byId.get(root.parentSpanId) as TraceSpan;
        expect(span.attributes['test.name']).toBe(root.attributes['test.name']);
        expect(spanTestId(span)).toEqual({
          classname: root.attributes['test.file'],
          name: root.attributes['test.name'],
        });
      }

      // 어댑터가 심은 testId = JUnit classname(파일) + name
      const wrapper = result.spans.find((s) => s.name === 'payment.refund');
      expect(wrapper?.testId).toEqual({
        classname: 'src/domains/payment/__tests__/payment.unit.test.ts',
        name: expect.stringMatching(/^refund > /),
      });
      expect(wrapper?.attributes['code.filepath']).toBe('src/domains/payment/index.ts');

      // 같은 실행의 JUnit XML
      const xml = await readFile(join(testbedRoot, 'reports', 'junit.xml'), 'utf8');
      expect(xml.match(/<testcase\b/g) ?? []).toHaveLength(7);
    },
    RUNNER_TIMEOUT,
  );

  it(
    'testIds로 좁히면 그 테스트의 스팬만',
    async () => {
      const result = await collectTraces(ctx, {
        run: false,
        testIds: [
          {
            classname: 'src/domains/payment/__tests__/payment.unit.test.ts',
            name: 'refund > 없는 결제면 PaymentNotFoundError',
          },
        ],
      });
      expect('spans' in result).toBe(true);
      if (!('spans' in result)) return;
      expect(result.spans.length).toBeGreaterThanOrEqual(1);
      for (const span of result.spans) expect(span.testId?.name).toBe('refund > 없는 결제면 PaymentNotFoundError');
      expect(result.run).toBeUndefined();
    },
    RUNNER_TIMEOUT,
  );

  it('readTraceDir: 없는 디렉토리는 빈 결과, resolveTraceDir: 루트 기준', async () => {
    expect(await readTraceDir(join(testbedRoot, 'reports', '__none__'))).toEqual({ spans: [], files: [] });
    expect(resolveTraceDir(ctx, {})).toBe(join(testbedRoot, 'reports', 'traces'));
    expect(resolveTraceDir(ctx, { traceDir: 'out/t' })).toBe(join(testbedRoot, 'out', 't'));
    expect(TRACE_OUT_ENV).toBe('PLUMB_TRACE_OUT');
  });

  it('러너가 없는 루트: unavailable no-trace + 이유 (던지지 않는다)', async () => {
    const workDir = join(packageDir, '.work');
    await mkdir(workDir, { recursive: true });
    const emptyRoot = await mkdtemp(join(workDir, 'no-runner-'));
    try {
      const result = await collectTraces({ root: emptyRoot, config: ctx.config }, {});
      expect(result).toMatchObject({
        unavailable: 'no-trace',
        reason: expect.stringContaining('reports/traces/*.jsonl 없음'),
      });
      expect('run' in result && result.run?.exitCode).toBe(127);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it('nextjsAdapter.collectTraces가 이 구현이다', async () => {
    const result = await nextjsAdapter.collectTraces(ctx, { run: false } as never);
    expect('spans' in result || 'unavailable' in result).toBe(true);
  });
});

describe('FlowView 끝까지: 코어 생성기 + 이 어댑터 (testbed)', () => {
  let storeDir: string;
  afterAll(async () => {
    if (storeDir) await rm(storeDir, { recursive: true, force: true });
  });

  it(
    'mode trace · 인수 테스트 0개 → 진입점 2개가 정적 그래프에서만 도출(전부 점선) · Markdown에 Mermaid 펜스',
    async () => {
      storeDir = await mkdtemp(join(tmpdir(), 'plumb-flow-store-'));
      const store = openStore({ store: storeDir }, testbedRoot);
      await store.init();
      const viewCtx: ViewContext = {
        root: testbedRoot,
        config: ctx.config,
        store,
        adapter: nextjsAdapter,
        commit: undefined,
        now: () => new Date('2026-10-02T09:00:00.000Z'),
      };
      const generator = createFlowGenerator();
      const view: FlowView = await generator.generate(viewCtx);

      expect(view.header).toMatchObject({ view: 'flow', generatedAt: '2026-10-02T09:00:00.000Z' });
      expect(view.header.sources.map((s) => s.kind)).toEqual(['parser', 'execution', 'execution', 'store']);
      expect(view.mode).toBe('trace');
      expect(view.fallback).toBeUndefined();
      expect(view.traceCount).toBeGreaterThanOrEqual(1);
      expect(view.empty).toBe('no-acceptance-tests');
      expect(view.scenarios.map((s) => s.id)).toEqual(['entry:POST /payments', 'entry:POST /refunds']);
      for (const scenario of view.scenarios) {
        expect(scenario).toMatchObject({ unit: 'entry', derivedFromStatic: true, result: 'none', rules: [] });
        expect(scenario.uncoveredCount).toBeGreaterThan(0);
      }
      expect(view.uncovered).toMatchObject({ count: 11, total: 11 });
      expect(view.uncovered.items.map((i) => i.scenarioOrEntry)).toEqual([
        'entry:POST /payments',
        'entry:POST /refunds',
      ]);

      const markdown = generator.render(view);
      expect(markdown.startsWith('# 도메인별 흐름도\n')).toBe(true);
      expect(markdown).toContain('출처: 파서: typescript ');
      expect(markdown).toContain('모드: 트레이스');
      expect(markdown).toContain('### POST /refunds — 테스트 없음');
      expect(markdown).toContain('```mermaid\nflowchart TD');
      expect(markdown).toContain('-.->');
      expect(markdown).toContain('## 테스트가 안 지나간 흐름 11 / 전체 11');

      await store.views.write('flow', view, markdown);
      const stored = await store.views.read('flow');
      expect(stored?.view).toEqual(view);

      await mkdir(join(testbedRoot, '.work'), { recursive: true });
      await writeFile(join(testbedRoot, '.work', 'flow-view.md'), markdown, 'utf8');
      await writeFile(join(testbedRoot, '.work', 'flow-view.json'), JSON.stringify(view, null, 2), 'utf8');
    },
    RUNNER_TIMEOUT,
  );
});
