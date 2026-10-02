// Vitest setupFiles — 테스트 실행 중 OpenTelemetry 스팬 수집 (이슈 #59 spike → A안으로 남긴 설정, view-flow 4.1 (b)·(e)·(f)).
//
// Next.js `instrumentation.ts`의 `register()`는 Vitest 실행 중에 불리지 않으므로(view-flow 4.1 (a)) SDK 초기화는 여기서 한다.
// 각 워커 프로세스(`pool: 'forks'`)마다 한 번 실행되고, 스팬은 끝날 때마다 OTLP JSON 한 줄로 파일에 적는다:
//   `${PLUMB_TRACE_OUT ?? reports/traces}/spans-<VITEST_POOL_ID>-<pid>.jsonl`
// `@plumb/adapter-nextjs`의 `collectTraces()`가 이 디렉토리를 읽는다. 외부 collector 없음.
//
// 세 가지를 한다:
//   1. SDK: NodeTracerProvider + SimpleSpanProcessor(파일 exporter). 동기 export — 테스트 시간 영향은 spike 항목 2
//   2. 외부 시스템 계측: @prisma/instrumentation 등록 → `prisma:client:operation` 등 스팬 (spike 항목 1)
//   3. 블록 공개 진입점 래핑: `src/domains/<d>/index.ts`의 export 함수를 `vi.doMock`으로 `<d>.<fn>` 스팬에 감싼다.
//      도메인 소스는 건드리지 않는다 (view-flow 4.1 (c))
// 테스트별 루트 스팬: `beforeEach`에서 열고 `afterEach`에서 닫는다. 래퍼 스팬은 이 루트 아래에 붙으므로
// 테스트 사이에서 섞이지 않는다 (spike 항목 3). `test.concurrent`는 지원하지 않는다 — 현재 테스트는 둘이 섞일 수 있다.
import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Attributes, type Context, context, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { type ReadableSpan, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';

/** testbed 루트 — 이 파일이 루트에 있다 */
const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, process.env.PLUMB_TRACE_OUT ?? 'reports/traces');
const outFile = join(outDir, `spans-${process.env.VITEST_POOL_ID ?? '0'}-${process.pid}.jsonl`);

// ---------------------------------------------------------------------------
// 1. SDK — 파일 exporter (OTLP JSON Span 한 줄씩)
// ---------------------------------------------------------------------------

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function toOtlpValue(value: unknown): OtlpValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: typeof value === 'string' ? value : JSON.stringify(value) };
}

function toNano([sec, nano]: [number, number]): string {
  return (BigInt(sec) * 1_000_000_000n + BigInt(nano)).toString();
}

/** OTLP JSON `Span` 모양 (kind·status.code는 OTLP 정수) — collectTraces()가 이 모양을 읽는다 */
function toOtlpSpan(span: ReadableSpan): Record<string, unknown> {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: span.kind + 1,
    startTimeUnixNano: toNano(span.startTime),
    endTimeUnixNano: toNano(span.endTime),
    attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) })),
    status: { code: span.status.code, ...(span.status.message ? { message: span.status.message } : {}) },
    resource: Object.entries(span.resource.attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) })),
  };
}

class JsonlFileExporter implements SpanExporter {
  private ready = false;
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      if (!this.ready) {
        mkdirSync(outDir, { recursive: true });
        this.ready = true;
      }
      appendFileSync(outFile, `${spans.map((s) => JSON.stringify(toOtlpSpan(s))).join('\n')}\n`);
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    'service.name': 'plumb-testbed-vitest',
    'plumb.pool_id': process.env.VITEST_POOL_ID ?? '0',
  }),
  spanProcessors: [new SimpleSpanProcessor(new JsonlFileExporter())],
});
provider.register();

// 2. 외부 시스템 계측 — Prisma. 모듈 패치가 아니라 globalThis 훅이라 Vitest의 모듈 외부화와 무관하게 붙는다 (4.1 (d))
registerInstrumentations({ instrumentations: [new PrismaInstrumentation()] });

const tracer = trace.getTracer('plumb-testbed', '0.0.0');

// ---------------------------------------------------------------------------
// 테스트별 루트 스팬 (4.1 (f))
// ---------------------------------------------------------------------------

let currentRoot: Span | undefined;
let currentCtx: Context | undefined;

function testAttributes(): Attributes {
  const state = expect.getState();
  const file = state.testPath ? relative(root, state.testPath) : '';
  return { 'test.name': state.currentTestName ?? '', 'test.file': file };
}

beforeEach(() => {
  const attrs = testAttributes();
  currentRoot = tracer.startSpan(`test ${attrs['test.file']}::${attrs['test.name']}`, {
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
  currentCtx = trace.setSpan(context.active(), currentRoot);
});

afterEach((ctx) => {
  if (!currentRoot) return;
  const state = ctx.task.result?.state;
  if (state === 'fail')
    currentRoot.setStatus({ code: SpanStatusCode.ERROR, message: ctx.task.result?.errors?.[0]?.message });
  currentRoot.setAttribute('test.result', state ?? 'unknown');
  currentRoot.end();
  currentRoot = undefined;
  currentCtx = undefined;
});

afterAll(async () => {
  await provider.forceFlush();
});

// ---------------------------------------------------------------------------
// 3. 블록 공개 진입점 래핑 — src/domains/<d>/index.ts 의 export 함수마다 `<d>.<fn>` 스팬
// ---------------------------------------------------------------------------

function wrapWithSpans(block: string, file: string, mod: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    // 클래스(오류 타입 등)는 그대로 — prototype이 있는 함수는 생성자다
    const isPlainFn = typeof value === 'function' && !/^class\s/.test(Function.prototype.toString.call(value));
    if (!isPlainFn) {
      wrapped[name] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    wrapped[name] = function plumbWrapped(this: unknown, ...args: unknown[]) {
      const parent = currentCtx ?? context.active();
      const span = tracer.startSpan(
        `${block}.${name}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            'code.function': name,
            'code.namespace': block,
            'code.filepath': file,
            'plumb.block': block,
            ...testAttributes(),
          },
        },
        parent,
      );
      const end = (error?: unknown) => {
        if (error !== undefined) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error instanceof Error ? error : new Error(String(error)));
        }
        span.end();
      };
      return context.with(trace.setSpan(parent, span), () => {
        let result: unknown;
        try {
          result = fn.apply(this, args);
        } catch (error) {
          end(error);
          throw error;
        }
        if (result instanceof Promise) {
          return result.then(
            (v) => {
              end();
              return v;
            },
            (error: unknown) => {
              end(error);
              throw error;
            },
          );
        }
        end();
        return result;
      });
    };
  }
  return wrapped;
}

const domainsDir = join(root, 'src', 'domains');
let domains: string[] = [];
try {
  domains = readdirSync(domainsDir).filter((d) => statSync(join(domainsDir, d, 'index.ts')).isFile());
} catch {
  // src/domains 없음
}
for (const block of domains) {
  const entry = join(domainsDir, block, 'index.ts');
  const rel = relative(root, entry);
  vi.doMock(entry, async (importOriginal) =>
    wrapWithSpans(block, rel, (await importOriginal()) as Record<string, unknown>),
  );
}
