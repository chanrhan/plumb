/**
 * `Adapter.collectTraces()` — Vitest를 OTel 설정과 함께 돌려 스팬 파일을 읽는다 (이슈 #59, view-flow 4.1 (e) · 4.2 A안).
 *
 * 테스트 실행과 수집은 한 번이다: `runTests()`(#44)에 `PLUMB_TRACE_OUT`을 넘겨 testbed의 `instrumentation-test.ts`(Vitest `setupFiles`)가
 * 워커마다 `<traceDir>/spans-<VITEST_POOL_ID>-<pid>.jsonl`에 OTLP JSON `Span`을 한 줄씩 쓰게 한다. JUnit XML도 같은 실행에서 나온다 —
 * 흐름도의 시나리오(JUnit testcase)와 스팬이 같은 실행의 것이어야 하기 때문이다 (기획안 §8 "에이전트의 테스트 실행 결과는 증거가 아니다").
 *
 * 파일이 하나도 없으면 `{ unavailable: 'no-trace', reason }` — 0개라고 쓰지 않는다 (view-flow 5절). 코어는 B안으로 전환한다.
 * 스팬 → 테스트 매핑은 속성 `test.file`(= JUnit `classname`) · `test.name`(= JUnit `name`)으로 (`TraceSpan.testId`).
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AdapterContext, TestRunResult, TraceCollectOptions, TraceResult, TraceSpan } from '@plumb/core';
import { readToolInfo } from './capture.js';
import { runTests } from './run-tests.js';

/** 어댑터 기본 트레이스 디렉토리 (루트 기준). testbed `instrumentation-test.ts`의 기본값과 같다 */
export const DEFAULT_TRACE_DIR = 'reports/traces';

/** `instrumentation-test.ts`가 읽는 환경변수 — 스팬 파일 디렉토리 (루트 기준 상대 또는 절대) */
export const TRACE_OUT_ENV = 'PLUMB_TRACE_OUT';

export interface CollectTracesOptions extends TraceCollectOptions {
  /** 실행할 테스트 파일 글롭 (`TestRunOptions.scope`) */
  scope?: string[];
  timeoutMs?: number;
  /** `false`면 테스트를 다시 돌리지 않고 디렉토리의 파일만 읽는다. 기본 `true` */
  run?: boolean;
}

/** 코어 `TraceResult`에 이 어댑터가 더한 것 — 같은 실행의 테스트 결과 */
export type NextjsTraceResult = TraceResult & { run?: TestRunResult };

// ---------------------------------------------------------------------------
// OTLP JSON Span → TraceSpan
// ---------------------------------------------------------------------------

type OtlpValue =
  | { stringValue: string }
  | { intValue: string | number }
  | { doubleValue: number }
  | { boolValue: boolean }
  | Record<string, unknown>;

interface OtlpKeyValue {
  key: string;
  value: OtlpValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP SpanKind: 0 unspecified · 1 internal · 2 server · 3 client · 4 producer · 5 consumer */
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
}

const SPAN_KINDS: Record<number, TraceSpan['kind']> = {
  0: 'internal',
  1: 'internal',
  2: 'server',
  3: 'client',
  4: 'producer',
  5: 'consumer',
};

const STATUS_CODES: Record<number, 'unset' | 'ok' | 'error'> = { 0: 'unset', 1: 'ok', 2: 'error' };

function attributeValue(value: OtlpValue): string | number | boolean | undefined {
  if ('stringValue' in value && typeof value.stringValue === 'string') return value.stringValue;
  if ('boolValue' in value && typeof value.boolValue === 'boolean') return value.boolValue;
  if ('doubleValue' in value && typeof value.doubleValue === 'number') return value.doubleValue;
  if ('intValue' in value) {
    const n = Number(value.intValue);
    return Number.isFinite(n) ? n : String(value.intValue);
  }
  return undefined;
}

function isOtlpSpan(value: unknown): value is OtlpSpan {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.traceId === 'string' &&
    typeof s.spanId === 'string' &&
    typeof s.name === 'string' &&
    typeof s.startTimeUnixNano === 'string' &&
    typeof s.endTimeUnixNano === 'string'
  );
}

/** OTLP JSON `Span` 한 줄 → `TraceSpan`. JSON이 아니거나 모양이 아니면 `null` (건너뛴다) */
export function parseSpanLine(line: string): TraceSpan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isOtlpSpan(raw)) return null;
  const attributes: TraceSpan['attributes'] = {};
  for (const kv of raw.attributes ?? []) {
    if (typeof kv?.key !== 'string' || typeof kv.value !== 'object' || kv.value === null) continue;
    const v = attributeValue(kv.value);
    if (v !== undefined) attributes[kv.key] = v;
  }
  const span: TraceSpan = {
    traceId: raw.traceId,
    spanId: raw.spanId,
    name: raw.name,
    kind: SPAN_KINDS[raw.kind ?? 1] ?? 'internal',
    startTimeUnixNano: raw.startTimeUnixNano,
    endTimeUnixNano: raw.endTimeUnixNano,
    attributes,
  };
  if (raw.parentSpanId) span.parentSpanId = raw.parentSpanId;
  if (raw.status) {
    span.status = { code: STATUS_CODES[raw.status.code ?? 0] ?? 'unset' };
    if (raw.status.message) span.status.message = raw.status.message;
  }
  const file = attributes['test.file'];
  const name = attributes['test.name'];
  if (typeof file === 'string' && file.length > 0 && typeof name === 'string' && name.length > 0) {
    span.testId = { classname: file, name };
  }
  return span;
}

/** 디렉토리의 `*.jsonl` 전부 (이름순) → 스팬. 없는 디렉토리는 빈 결과 */
export async function readTraceDir(dir: string): Promise<{ spans: TraceSpan[]; files: string[] }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return { spans: [], files: [] };
  }
  const spans: TraceSpan[] = [];
  const files: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const text = await readFile(path, 'utf8');
    let count = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const span = parseSpanLine(line);
      if (span) {
        spans.push(span);
        count += 1;
      }
    }
    if (count > 0) files.push(path);
  }
  return { spans, files };
}

/** `opts.traceDir` → 어댑터 기본값. 루트 기준 상대를 절대로 */
export function resolveTraceDir(ctx: AdapterContext, opts: TraceCollectOptions): string {
  const dir = opts.traceDir ?? DEFAULT_TRACE_DIR;
  return isAbsolute(dir) ? dir : resolve(ctx.root, dir);
}

function matchesTestId(span: TraceSpan, ids: NonNullable<TraceCollectOptions['testIds']>): boolean {
  return (
    span.testId !== undefined &&
    ids.some((id) => id.classname === span.testId?.classname && id.name === span.testId?.name)
  );
}

/**
 * 트레이스 수집. 이전 실행의 파일을 "이번 것"으로 착각하지 않도록 디렉토리를 비우고 돌린다.
 * 러너가 없거나 죽어도 던지지 않는다 — `unavailable`에 이유(exit code · 꼬리)를 적는다.
 */
export async function collectTraces(ctx: AdapterContext, opts: CollectTracesOptions = {}): Promise<NextjsTraceResult> {
  const traceDir = resolveTraceDir(ctx, opts);
  let run: TestRunResult | undefined;

  if (opts.run !== false) {
    await rm(traceDir, { recursive: true, force: true });
    await mkdir(traceDir, { recursive: true });
    run = await runTests(ctx, {
      env: { [TRACE_OUT_ENV]: relative(ctx.root, traceDir) || '.' },
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  const { spans, files } = await readTraceDir(traceDir);
  if (files.length === 0) {
    const where = relative(ctx.root, traceDir);
    const detail = run ? ` (vitest exit ${run.exitCode}: ${run.output.tail.slice(-1)[0] ?? ''})`.trimEnd() : '';
    return {
      unavailable: 'no-trace',
      reason: `${where}/*.jsonl 없음 — setupFiles(instrumentation-test.ts) 미설정 또는 exporter 실패${detail}`,
      ...(run ? { run } : {}),
    };
  }

  const tool = await readToolInfo(ctx, '@opentelemetry/sdk-trace-base', 'otel');
  const filtered = opts.testIds ? spans.filter((span) => matchesTestId(span, opts.testIds ?? [])) : spans;
  return {
    spans: filtered,
    files: files.map((f) => relative(ctx.root, f)),
    tool,
    ...(run ? { run } : {}),
  };
}
