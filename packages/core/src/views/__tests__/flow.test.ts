/**
 * #59 — 흐름도 생성기를 가짜 정적 그래프 · 가짜 스팬 · 가짜 JUnit으로 검증한다 (어댑터 없이).
 * 트리 조립(스팬 뼈대 + 정적 점선) · 점선 계산 · B안 전환 · Markdown(Mermaid 펜스 · "테스트가 안 지나간 흐름").
 * testbed 실제 실행은 `@plumb/adapter-nextjs`의 `flow-collect-traces.test.ts`가 한다.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, StaticCallGraph, TraceResult, TraceSpan } from '../../adapter/index.js';
import { makeTempStore, REFUND_RULE, type TempStore } from '../../store/__tests__/fixtures.js';
import type { CheckRun, FlowNode, FlowView, PlumbConfig, RuleStatusRecord } from '../../types/index.js';
import {
  buildCheckIndex,
  buildTraceScenario,
  computeUncovered,
  createFlowGenerator,
  externalNodeId,
  flowGenerator,
  hasCallGraph,
  isAcceptanceTestFile,
  matchEntry,
  overlayStatic,
  parseEntryId,
  renderFlow,
  scenarioMermaid,
  spanForestToNodes,
  spanTestId,
  staticScenario,
} from '../flow.js';
import type { ViewContext } from '../types.js';

const NOW = new Date('2026-10-02T09:00:00.000Z');

// ---------------------------------------------------------------------------
// 가짜 입력 — view-flow 2.1 와이어프레임의 testbed 가정
// ---------------------------------------------------------------------------

function node(id: string, kind: FlowNode['kind'], children: FlowNode[] = [], extra: Partial<FlowNode> = {}): FlowNode {
  const label = id
    .replace(/^entry:/, '')
    .replace(/^ext:db:/, 'db: ')
    .replace(/^event:/, 'emit ');
  return { id, kind, label, children, evidence: 'static', ...extra };
}

const REFUNDS_ENTRY = node(
  'entry:POST /refunds',
  'entry',
  [
    node(
      'payment.refund',
      'public',
      [
        node('payment.findPayment', 'internal', [node('ext:db:payment.findUnique', 'external')]),
        node('payment.insertRefund', 'internal', [
          node('ext:db:refund.create', 'external'),
          node('ext:db:payment.update', 'external'),
        ]),
        node('event:payment.refunded', 'emit', [], { handlerUnknown: true }),
      ],
      { anchor: { block: 'payment', file: 'src/domains/payment/payment.ts', line: 31 } },
    ),
  ],
  { anchor: { block: 'app', file: 'src/app/api/refunds/route.ts', line: 20 } },
);

const PAYMENTS_ENTRY = node(
  'entry:POST /payments',
  'entry',
  [
    node(
      'payment.createPayment',
      'public',
      [node('payment.insertPayment', 'internal', [node('ext:db:payment.create', 'external')])],
      {
        anchor: { block: 'payment', file: 'src/domains/payment/payment.ts', line: 15 },
      },
    ),
  ],
  { anchor: { block: 'app', file: 'src/app/api/payments/route.ts', line: 20 } },
);

const GRAPH: StaticCallGraph = {
  tool: { name: 'typescript', version: '5.9.3' },
  entries: [PAYMENTS_ENTRY, REFUNDS_ENTRY],
  symbols: {
    'entry:POST /refunds': { block: 'app', file: 'src/app/api/refunds/route.ts', line: 20 },
    'payment.refund': { block: 'payment', file: 'src/domains/payment/payment.ts', line: 31 },
    'ext:db:refund.create': { file: 'src/domains/payment/repo.ts', line: 28 },
  },
  testRefs: {
    'payment.refund': [
      'test/acceptance/refund-window.property.spec.ts',
      'src/domains/payment/__tests__/payment.unit.test.ts',
    ],
    'payment.createPayment': ['src/domains/payment/__tests__/payment.unit.test.ts'],
  },
  warnings: [],
};

const TEST_FILE = 'test/acceptance/refund-window.property.spec.ts';
const TEST_NAME = '정상 환불 (7일 이내)';

function span(
  spanId: string,
  name: string,
  start: number,
  attributes: TraceSpan['attributes'] = {},
  parentSpanId?: string,
  kind: TraceSpan['kind'] = 'internal',
): TraceSpan {
  const s: TraceSpan = {
    traceId: 'trace-1',
    spanId,
    name,
    kind,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 5),
    attributes: { 'test.file': TEST_FILE, 'test.name': TEST_NAME, ...attributes },
  };
  if (parentSpanId) s.parentSpanId = parentSpanId;
  return s;
}

/** 테스트가 `payment.refund()`를 직접 불렀고 실제 DB를 거쳤다 — 라우트 스팬은 없다 (view-flow 4.1 (g)) */
const SPANS: TraceSpan[] = [
  span('root', `test ${TEST_FILE}::${TEST_NAME}`, 100),
  span('refund', 'payment.refund', 110, { 'plumb.block': 'payment', 'code.function': 'refund' }, 'root'),
  span('op1', 'prisma:client:operation', 120, { model: 'Payment', method: 'findUnique' }, 'refund'),
  span('q1', 'prisma:engine:db_query', 121, { 'db.system': 'postgresql' }, 'op1'),
  span('tx', 'prisma:client:transaction', 130, { method: '$transaction' }, 'refund'),
  span('op2', 'prisma:client:operation', 131, { model: 'Refund', method: 'create' }, 'tx'),
  span('q2', 'prisma:engine:db_query', 132, { 'db.system': 'postgresql' }, 'op2'),
  span('op3', 'prisma:client:operation', 140, { model: 'Payment', method: 'update' }, 'tx'),
];

const JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.1">
  <testsuite name="${TEST_FILE}" tests="1" failures="0" errors="0" skipped="0" time="0.05">
    <testcase classname="${TEST_FILE}" name="${TEST_NAME}" time="0.05"></testcase>
  </testsuite>
  <testsuite name="src/domains/payment/__tests__/payment.unit.test.ts" tests="1" failures="0" errors="0" skipped="0" time="0.05">
    <testcase classname="src/domains/payment/__tests__/payment.unit.test.ts" name="refund &gt; 1일 지난 결제는 전액 환불된다" time="0.05"></testcase>
  </testsuite>
</testsuites>`;

const CHECK_RUN: CheckRun = {
  runId: 'c-20261002-0900',
  commit: 'abc1234def',
  startedAt: '2026-10-02T08:59:00.000Z',
  finishedAt: '2026-10-02T08:59:30.000Z',
  runner: { exitCode: 0 },
  results: [
    {
      check: REFUND_RULE.checks[0] as CheckRun['results'][number]['check'],
      ruleIds: [REFUND_RULE.id],
      outcome: 'pass',
    },
  ],
  quarantined: [],
  counts: { junit: 1, static: 0 },
  storeStatus: 'ok',
};

const REFUND_STATUS: RuleStatusRecord = {
  ruleId: REFUND_RULE.id,
  detail: { status: 'pass-unverified', reason: 'no-injection' },
  since: '2026-10-02T08:59:30.000Z',
  commit: 'abc1234def',
  checkedAt: '2026-10-02T08:59:30.000Z',
  history: ['pass-unverified'],
};

const fakeAdapter: Adapter = {
  name: 'nextjs',
  extractDependencies: () => Promise.reject(new Error('unused')),
  generateStubs: () => Promise.reject(new Error('unused')),
  runTests: () => Promise.reject(new Error('unused')),
  readSchemas: () => Promise.reject(new Error('unused')),
  collectTraces: () => Promise.resolve({ unavailable: 'no-trace' }),
};

let temp: TempStore | undefined;
afterEach(async () => {
  await temp?.cleanup();
  temp = undefined;
});

async function makeCtx(
  options: {
    flowMode?: PlumbConfig['flow'] extends infer F ? (F extends { mode: infer M } ? M : never) : never;
    withRule?: boolean;
  } = {},
) {
  temp = await makeTempStore({ now: () => NOW });
  if (options.withRule !== false) {
    const proposal = await temp.store.proposals.write({
      id: 'p-0001',
      ruleId: REFUND_RULE.id,
      changeKind: 'add',
      proposedBy: 'cli',
      proposedAt: '2026-10-01T05:00:00.000Z',
      after: REFUND_RULE,
      requiresPriorApproval: false,
      applied: 'provisional',
    });
    await temp.store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: proposal.id, by: 'tester' });
    await temp.store.checks.write(CHECK_RUN);
    await temp.store.ruleStatus.write([REFUND_STATUS]);
  }
  const config: PlumbConfig = {
    service: 'testbed',
    adapter: 'nextjs',
    roles: {
      'test-writer': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
      implementer: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
      injector: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
      'rule-drafter': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    },
    stopBlockLimit: 3,
    ...(options.flowMode ? { flow: { mode: options.flowMode } } : {}),
  };
  const ctx: ViewContext = {
    root: temp.root,
    config,
    store: temp.store,
    adapter: fakeAdapter,
    commit: 'abc1234def',
    now: () => NOW,
  };
  return ctx;
}

const traces: TraceResult = {
  spans: SPANS,
  files: ['reports/traces/spans-1-1.jsonl'],
  tool: { name: 'otel', version: '2.11.0' },
};

// ---------------------------------------------------------------------------
// 순수 함수
// ---------------------------------------------------------------------------

describe('헬퍼', () => {
  it('spanTestId · externalNodeId · parseEntryId · isAcceptanceTestFile · hasCallGraph', () => {
    expect(spanTestId(SPANS[1] as TraceSpan)).toEqual({ classname: TEST_FILE, name: TEST_NAME });
    expect(spanTestId({ ...(SPANS[1] as TraceSpan), attributes: {} })).toBeUndefined();
    expect(externalNodeId('db', 'Refund', 'create')).toBe('ext:db:refund.create');
    expect(parseEntryId('entry:POST /refunds')).toEqual({ method: 'POST', path: '/refunds' });
    expect(parseEntryId('payment.refund')).toBeUndefined();
    expect(isAcceptanceTestFile('test/acceptance/x.spec.ts')).toBe(true);
    expect(isAcceptanceTestFile('src/domains/payment/__tests__/x.test.ts')).toBe(false);
    expect(hasCallGraph(fakeAdapter)).toBe(false);
    expect(hasCallGraph({ ...fakeAdapter, buildCallGraph: async () => GRAPH })).toBe(true);
  });
});

describe('스팬 → 노드 트리 (A안)', () => {
  it('해상도 밖 스팬(테스트 루트 · prisma 내부 · 트랜잭션)은 투명, 외부 시스템 노드 ID는 정적 그래프와 같은 꼴', () => {
    const scenario = buildTraceScenario({
      testcase: {
        id: `${TEST_FILE}::${TEST_NAME}`,
        name: TEST_NAME,
        classname: TEST_FILE,
        file: TEST_FILE,
        status: 'pass',
      },
      spans: SPANS,
      graph: GRAPH,
      index: buildCheckIndex([REFUND_RULE], new Map([[REFUND_RULE.id, 'pass-unverified']]), CHECK_RUN),
    });

    // 루트: 테스트가 라우트를 거치지 않았으므로 진입점은 정적(점선)이고, 그 아래 payment.refund는 실행됨
    expect(scenario.root).toMatchObject({ id: 'entry:POST /refunds', kind: 'entry', evidence: 'static' });
    expect(scenario.entry).toEqual({
      method: 'POST',
      path: '/refunds',
      anchor: { block: 'app', file: 'src/app/api/refunds/route.ts', line: 20 },
    });
    const refund = scenario.root.children[0] as FlowNode;
    expect(refund).toMatchObject({
      id: 'payment.refund',
      kind: 'public',
      evidence: 'both',
      anchor: { block: 'payment', file: 'src/domains/payment/payment.ts', line: 31 },
    });
    // 스팬 뼈대: findUnique · refund.create · payment.update 가 실행 순서대로 (정적 그래프에도 있으므로 both), 그 뒤 정적 점선(내부 함수 · emit)
    expect(refund.children.map((c) => [c.id, c.evidence])).toEqual([
      ['ext:db:payment.findUnique', 'both'],
      ['ext:db:refund.create', 'both'],
      ['ext:db:payment.update', 'both'],
      ['payment.findPayment', 'static'],
      ['payment.insertRefund', 'static'],
      ['event:payment.refunded', 'static'],
    ]);
    // 점선 내부 함수 아래의 외부 노드는 스팬에서 이미 그렸으므로 중복하지 않는다
    expect(refund.children.find((c) => c.id === 'payment.insertRefund')?.children).toEqual([]);
    expect(refund.children[1]).toMatchObject({
      label: 'db: refund.create',
      external: { system: 'postgresql', operation: 'refund.create' },
      anchor: { file: 'src/domains/payment/repo.ts', line: 28 },
    });

    expect(scenario).toMatchObject({
      id: `${TEST_FILE}::${TEST_NAME}`,
      unit: 'scenario',
      testId: { classname: TEST_FILE, name: TEST_NAME },
      test: { file: TEST_FILE },
      rules: [{ ruleId: 'pay.refund-window', status: 'pass-unverified' }],
      result: 'pass',
      spanCount: 8,
      uncoveredCount: 4, // 진입점 · findPayment · insertRefund · emit
      block: 'payment',
    });
  });

  it('실패한 시나리오는 마지막 스팬이 실패 지점', () => {
    const scenario = buildTraceScenario({
      testcase: { id: 'x', name: TEST_NAME, classname: TEST_FILE, file: TEST_FILE, status: 'fail' },
      spans: SPANS,
      graph: GRAPH,
      index: buildCheckIndex([], new Map(), null),
    });
    const refund = scenario.root.children[0] as FlowNode;
    expect(refund.children.find((c) => c.id === 'ext:db:payment.update')?.failurePoint).toBe(true);
    expect(scenario.result).toBe('fail');
  });

  it('스팬 0개면 "공개 진입점을 거치지 않는 테스트" 루트, 정적 그래프가 없으면 스팬만', () => {
    const empty = buildTraceScenario({
      testcase: { id: 'x', name: 'n', classname: TEST_FILE, file: TEST_FILE, status: 'pass' },
      spans: [],
      graph: GRAPH,
      index: buildCheckIndex([], new Map(), null),
    });
    expect(empty.root).toMatchObject({ id: 'test:x', kind: 'entry', children: [], evidence: 'static' });
    expect(empty.spanCount).toBe(0);

    const noGraph = buildTraceScenario({
      testcase: { id: 'x', name: 'n', classname: TEST_FILE, file: TEST_FILE, status: 'pass' },
      spans: SPANS,
      graph: undefined,
      index: buildCheckIndex([], new Map(), null),
    });
    expect(noGraph.root).toMatchObject({ id: 'payment.refund', evidence: 'span' });
    expect(noGraph.root.children.map((c) => c.id)).toEqual([
      'ext:db:payment.findUnique',
      'ext:db:refund.create',
      'ext:db:payment.update',
    ]);
    expect(noGraph.uncoveredCount).toBe(0);
  });

  it('spanForestToNodes · matchEntry · overlayStatic 단독', () => {
    const forest = spanForestToNodes(
      [{ span: SPANS[1] as TraceSpan, children: [{ span: SPANS[2] as TraceSpan, children: [] }] }],
      GRAPH.symbols,
    );
    expect(forest.map((n) => n.id)).toEqual(['payment.refund']);
    expect(matchEntry(GRAPH.entries, new Set(['payment.refund']))?.id).toBe('entry:POST /refunds');
    expect(matchEntry(GRAPH.entries, new Set(['nothing']))).toBeUndefined();

    const root: FlowNode = { ...REFUNDS_ENTRY, children: forest, evidence: 'static' };
    overlayStatic(root, REFUNDS_ENTRY.children, new Set(['payment.refund', 'ext:db:payment.findUnique']));
    const refund = root.children[0] as FlowNode;
    expect(refund.evidence).toBe('both');
    expect(refund.children.map((c) => [c.id, c.evidence])).toEqual([
      ['ext:db:payment.findUnique', 'both'],
      ['payment.findPayment', 'static'],
      ['payment.insertRefund', 'static'],
      ['event:payment.refunded', 'static'],
    ]);
    expect(refund.children[2]?.children.map((c) => c.id)).toEqual(['ext:db:refund.create', 'ext:db:payment.update']);
  });
});

describe('B안 — 진입점 단위 시나리오', () => {
  it('검사 매핑에 있는 테스트 파일이 공개 진입점을 import하면 referenced · 테스트 있음, 아니면 테스트 없음', () => {
    const index = buildCheckIndex([REFUND_RULE], new Map([[REFUND_RULE.id, 'pass-unverified']]), CHECK_RUN);
    const refunds = staticScenario(REFUNDS_ENTRY, GRAPH, index);
    expect(refunds).toMatchObject({
      id: 'entry:POST /refunds',
      unit: 'entry',
      test: { file: TEST_FILE },
      rules: [{ ruleId: 'pay.refund-window', status: 'pass-unverified' }],
      result: 'pass',
      uncoveredCount: 0,
    });
    expect(refunds.root.testRef).toBe('referenced');
    expect(refunds.root.evidence).toBeUndefined();
    const refund = refunds.root.children[0] as FlowNode;
    expect(refund.testRef).toBe('referenced');
    expect(refund.children.map((c) => c.testRef)).toEqual(['internal', 'internal', 'static']);
    expect(refund.children[2]?.handlerUnknown).toBe(true);

    // 단위 테스트만 import하는 진입점은 "테스트 없음" (단위 테스트는 검사 매핑에 없다)
    const payments = staticScenario(PAYMENTS_ENTRY, GRAPH, index);
    expect(payments).toMatchObject({ rules: [], result: 'none', uncoveredCount: 1 });
    expect(payments.test).toBeUndefined();
    expect(payments.root.testRef).toBe('static');
    expect((payments.root.children[0] as FlowNode).testRef).toBe('static');

    expect(computeUncovered('static', [payments, refunds], GRAPH)).toEqual({
      count: 1,
      total: 2,
      items: [
        {
          kind: 'uncovered-flow',
          scenarioOrEntry: 'entry:POST /payments',
          nodeIds: ['entry:POST /payments', 'payment.createPayment', 'payment.insertPayment', 'ext:db:payment.create'],
          mode: 'static',
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// generate() · render()
// ---------------------------------------------------------------------------

describe('generate(): A안', () => {
  it('트레이스 있음 → mode trace, 인수 테스트 1개 = 시나리오 1개 + 테스트가 안 지나간 진입점 1개(점선 전용), 단위 테스트는 시나리오가 아니다', async () => {
    const ctx = await makeCtx();
    const generator = createFlowGenerator({
      callGraph: async () => GRAPH,
      collectTraces: async () => traces,
      readJunit: async () => JUNIT,
    });
    const view = await generator.generate(ctx);

    expect(view.header).toEqual({
      view: 'flow',
      generatedAt: NOW.toISOString(),
      commit: 'abc1234def',
      sources: [
        { kind: 'parser', tool: 'typescript', version: '5.9.3', input: 'src/app/api/**/route.ts' },
        { kind: 'execution', tool: 'otel', version: '2.11.0', input: '1 files' },
        { kind: 'execution', tool: 'vitest-junit', input: 'reports/junit.xml' },
        { kind: 'store', input: 'rules.yaml' },
      ],
    });
    expect(view.mode).toBe('trace');
    expect(view.fallback).toBeUndefined();
    expect(view.traceCount).toBe(1);
    expect(view.empty).toBeUndefined();
    expect(view.lastCheck).toEqual({
      runId: 'c-20261002-0900',
      commit: 'abc1234def',
      finishedAt: '2026-10-02T08:59:30.000Z',
    });
    expect(view.scenarios.map((s) => [s.id, s.unit, s.derivedFromStatic ?? false])).toEqual([
      [`${TEST_FILE}::${TEST_NAME}`, 'scenario', false],
      ['entry:POST /payments', 'entry', true],
    ]);
    // 전체 12 노드(payments 4 + refunds 8) 중 실행된 것: payment.refund · findUnique · refund.create · payment.update = 4 → 안 지나간 8
    expect(view.uncovered.count).toBe(8);
    expect(view.uncovered.total).toBe(12);
    expect(view.uncovered.items.map((i) => i.scenarioOrEntry)).toEqual([
      `${TEST_FILE}::${TEST_NAME}`,
      'entry:POST /payments',
    ]);
    expect(view.uncovered.items[1]?.nodeIds).toEqual([
      'entry:POST /payments',
      'payment.createPayment',
      'payment.insertPayment',
      'ext:db:payment.create',
    ]);

    // JSON 왕복 · 저장소 쓰기 (View JSON 자체를 #57이 읽는다 — flows.json 없음)
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    await ctx.store.views.write('flow', view, generator.render(view));
    expect((await ctx.store.views.read('flow'))?.view).toEqual(view);
  });

  it('A안 설정인데 트레이스가 없으면 static으로 전환하고 fallback에 적는다 (조용히 A안인 척하지 않는다)', async () => {
    const ctx = await makeCtx({ flowMode: 'trace' });
    const generator = createFlowGenerator({
      callGraph: async () => GRAPH,
      collectTraces: async () => ({ unavailable: 'no-trace', reason: 'setupFiles 없음' }),
      readJunit: async () => JUNIT,
    });
    const view = await generator.generate(ctx);
    expect(view.mode).toBe('static');
    expect(view.fallback).toEqual({ reason: 'no-trace-files' });
    expect(view.traceCount).toBeUndefined();
    expect(view.scenarios.map((s) => [s.id, s.unit, s.uncoveredCount])).toEqual([
      ['entry:POST /payments', 'entry', 1],
      ['entry:POST /refunds', 'entry', 0],
    ]);
    expect(view.uncovered).toMatchObject({ count: 1, total: 2 });
    expect(generator.render(view)).toContain('⚠ 트레이스 없음');
  });

  it('정적 그래프 실패 + 트레이스 있음 → 실선만, graphError · fallback graph-failed', async () => {
    const ctx = await makeCtx();
    const generator = createFlowGenerator({
      callGraph: async () => {
        throw new Error('TS 파싱 오류 1건');
      },
      collectTraces: async () => traces,
      readJunit: async () => JUNIT,
    });
    const view = await generator.generate(ctx);
    expect(view.mode).toBe('trace');
    expect(view.graphError).toBe('TS 파싱 오류 1건');
    expect(view.fallback).toEqual({ reason: 'graph-failed' });
    expect(view.empty).toBe('no-graph');
    expect(view.scenarios).toHaveLength(1);
    expect(view.scenarios[0]?.root.id).toBe('payment.refund');
    expect(view.uncovered).toEqual({ count: 0, total: 0, items: [] });
    expect(generator.render(view)).toContain('정적 그래프 생성 실패: TS 파싱 오류 1건');
  });
});

describe('generate(): B안 · 비어 있을 때', () => {
  it('flow.mode static이면 트레이스를 시도하지 않는다. 어댑터에 buildCallGraph가 없으면 graphError + no-graph', async () => {
    const ctx = await makeCtx({ flowMode: 'static' });
    let traceCalls = 0;
    const generator = createFlowGenerator({
      collectTraces: async () => {
        traceCalls += 1;
        return traces;
      },
      readJunit: async () => null,
    });
    const view = await generator.generate(ctx);
    expect(traceCalls).toBe(0);
    expect(view.mode).toBe('static');
    expect(view.fallback).toBeUndefined();
    expect(view.graphError).toContain('buildCallGraph');
    expect(view.empty).toBe('no-graph');
    expect(view.scenarios).toEqual([]);
    expect(view.header.sources).toEqual([{ kind: 'store', input: 'rules.yaml' }]);
    const md = generator.render(view);
    expect(md).toContain('아직 생성되지 않음');
    expect(md).toContain('측정 불가');
  });

  it('기본 생성기(flowGenerator)는 어댑터의 collectTraces가 던져도 unavailable로 받아 B안으로 간다', async () => {
    const ctx = await makeCtx({ withRule: false });
    const adapter: Adapter & { buildCallGraph(): Promise<StaticCallGraph> } = {
      ...fakeAdapter,
      collectTraces: () => Promise.reject(new Error('collectTraces는 M8에 구현 예정')),
      buildCallGraph: async () => GRAPH,
    };
    const view = await flowGenerator.generate({ ...ctx, adapter });
    expect(view.mode).toBe('static');
    expect(view.fallback).toEqual({ reason: 'no-trace-files' });
    expect(view.scenarios).toHaveLength(2);
    expect(view.scenarios.every((s) => s.rules.length === 0 && s.result === 'none')).toBe(true);
  });

  it('진입점 0개 → empty no-entries', async () => {
    const ctx = await makeCtx({ withRule: false });
    const view = await createFlowGenerator({
      callGraph: async () => ({ ...GRAPH, entries: [] }),
      collectTraces: async () => traces,
      readJunit: async () => JUNIT,
    }).generate(ctx);
    expect(view.empty).toBe('no-entries');
    expect(renderFlow(view)).toContain('진입점 없음');
  });
});

describe('render()', () => {
  async function traceView(): Promise<FlowView> {
    const ctx = await makeCtx();
    return createFlowGenerator({
      callGraph: async () => GRAPH,
      collectTraces: async () => traces,
      readJunit: async () => JUNIT,
    }).generate(ctx);
  }

  it('머리글 · 출처 표시줄 · 모드 안내 · 시나리오 제목 · Mermaid 펜스(실선 · 점선 · 외부 시스템 · 이벤트) · 표 · 마지막 절', async () => {
    const view = await traceView();
    const md = renderFlow(view);
    const lines = md.split('\n');
    expect(lines[0]).toBe('# 도메인별 흐름도');
    expect(lines[2]).toBe(
      '출처: 파서: typescript 5.9.3 (src/app/api/**/route.ts) · 실행: otel 2.11.0 (1 files) · 실행: vitest-junit (reports/junit.xml) · 저장소: rules.yaml',
    );
    expect(md).toContain('모드: 트레이스 — 트레이스 1개 시나리오 · 스팬 파일 1개');
    expect(md).toContain(`### POST /refunds — ${TEST_NAME}`);
    expect(md).toContain('### POST /payments — 테스트 없음');
    expect(md).toContain(
      '✔ 통과 · `test/acceptance/refund-window.property.spec.ts` · 규칙 `pay.refund-window` 🟡 · 스팬 8개 · 점선 4개',
    );
    expect(md).toContain('테스트 없음 · 정적 그래프에서만 도출 (전부 점선)');

    const fences = md.match(/```mermaid\nflowchart TD[\s\S]*?```/g) ?? [];
    expect(fences).toHaveLength(2);
    const refunds = fences[0] as string;
    expect(refunds).toContain('n0(["POST /refunds"])');
    expect(refunds).toContain('n0 --> n1'); // 진입점 → payment.refund: 자식이 실행됐으면 실선 (점선은 자식이 정적만일 때)
    expect(refunds).toContain('[("db: refund.create")]');
    expect(refunds).toContain('>"emit payment.refunded"]');
    expect(refunds).toMatch(/n1 -\.-> n\d+/); // payment.refund → 점선 자식
    expect(refunds).toMatch(/n1 --> n\d+/); // payment.refund → 실선 자식

    expect(md).toContain('| 노드 | 종류 | 블록 | 위치 | 근거 |');
    expect(md).toContain(
      '[src/domains/payment/payment.ts:31](plumb://open?file=src%2Fdomains%2Fpayment%2Fpayment.ts&line=31)',
    );
    expect(md).toContain('실행: span + 파서: static');
    expect(md).toContain('파서: static (점선)');
    expect(md).toContain('⚠ 핸들러 연결 불명');
    expect(md).toContain('## 테스트가 안 지나간 흐름 8 / 전체 12');
    expect(md.endsWith('→ 검증 상태 View "검사 범위 밖"\n')).toBe(true);
  });

  it('scenarioMermaid: B안은 전부 실선', async () => {
    const index = buildCheckIndex([], new Map(), null);
    const code = scenarioMermaid(staticScenario(REFUNDS_ENTRY, GRAPH, index), 'static');
    expect(code.startsWith('flowchart TD\n')).toBe(true);
    expect(code).not.toContain('-.->');
    expect(code.match(/-->/g)?.length).toBe(7);
  });

  it('render는 ctx 없이 JSON만 본다 — 저장된 JSON에서 같은 Markdown', async () => {
    const view = await traceView();
    const roundTrip = JSON.parse(JSON.stringify(view)) as FlowView;
    expect(renderFlow(roundTrip)).toBe(renderFlow(view));
  });
});
