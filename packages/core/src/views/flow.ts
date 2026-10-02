/**
 * 도메인별 흐름도 View 생성기 (이슈 #59, docs/screens/view-flow.md, 기획안 §6.1).
 *
 * 입력 둘을 합친다 — 두 안 모두 거친다 (view-flow 4.2 "정적 그래프는 두 안의 공통 재료"):
 * - 파서: **정적 호출 그래프** — 어댑터가 TS 컴파일러 API로 만든 `FlowNode` 트리 (진입점당 하나, `evidence: 'static'`).
 *   `Adapter` 인터페이스에는 이 메서드가 없으므로 어댑터 객체가 {@link CallGraphProvider}를 함께 구현했는지 덕 타이핑으로 본다
 * - 실행: **OTel 스팬** — `adapter.collectTraces()`. 스팬이 있으면 `mode: 'trace'`(A안), 없으면 `mode: 'static'`(B안)으로 전환하고
 *   `fallback`에 적는다 (view-flow 5절 "조용히 A안인 척하지 않는다")
 *
 * A안: 시나리오 = 인수 테스트(`test/**`의 JUnit testcase) 하나. 스팬을 `test.file`·`test.name`으로 묶어 트리로 그리고, 정적 그래프에
 * 있는데 스팬에 없는 노드는 `evidence: 'static'`(점선). 어떤 테스트도 지나지 않은 진입점은 `derivedFromStatic` 시나리오(전부 점선).
 * 단위 테스트(`src/**`)는 시나리오가 아니다 (view-flow 3절). B안: 시나리오 = 진입점 하나. 노드 `testRef`는 저장소: 검사 매핑에 있는
 * 테스트 파일이 그 공개 진입점을 import할 때 `referenced`.
 *
 * `uncovered`는 검증 상태 View(#57)가 `untestedFlows`로 읽는다 — 저장소에 `flows.json`을 따로 쓰지 않고 이 View JSON에서 읽는다.
 * 그리지 않는 것: 소요 시간 · 호출 횟수 · 인자 · SQL 본문 · 함수 안의 분기 (view-flow 4.3).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AdapterContext, ToolInfo, TraceResult, TraceSpan } from '../adapter/types.js';
import { allCases, type JunitCase, parseJunit, toRootRelative } from '../checks/junit.js';
import { checkRefsOf } from '../checks/junit-to-results.js';
import type {
  Anchor,
  CheckRun,
  FlowMode,
  FlowNode,
  FlowScenario,
  FlowView,
  Rule,
  RuleId,
  RuleStatus,
  SourceRef,
  UncoveredFlow,
} from '../types/index.js';
import { makeHeader, source } from './header.js';
import { anchorLink, codeSpan, escapeMd, heading, mdTable, mermaid, sourceBar, statusIcon } from './markdown.js';
import { adapterContextOf, type ViewContext, type ViewGenerator } from './types.js';

// ---------------------------------------------------------------------------
// 정적 호출 그래프 — 어댑터가 만들어 주는 모양 (코어는 어댑터 패키지를 import하지 않는다)
// ---------------------------------------------------------------------------

/** 파서: 정적 호출 그래프. 진입점당 `FlowNode` 하나, 모든 노드 `evidence: 'static'` */
export interface StaticCallGraph {
  tool: ToolInfo;
  entries: FlowNode[];
  /** 노드 ID → `file:line` (스팬 이름을 역조회해 앵커를 붙인다 — 정본은 파서, view-flow 3절) */
  symbols: Record<string, Anchor>;
  /** 공개 진입점 노드 ID → 그것을 import하는 테스트 파일 (루트 기준). B안 "참조됨"의 재료 */
  testRefs: Record<string, string[]>;
  /** 못 본 것 (동적 import · DI · 핸들러 연결 등). 화면에 그대로 보인다 */
  warnings: string[];
}

/** 어댑터가 정적 호출 그래프를 제공하면 구현하는 선택 인터페이스. `nextjsAdapter`가 구현한다 */
export interface CallGraphProvider {
  buildCallGraph(ctx: AdapterContext): Promise<StaticCallGraph>;
}

export function hasCallGraph(adapter: unknown): adapter is CallGraphProvider {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as Partial<CallGraphProvider>).buildCallGraph === 'function'
  );
}

/** 테스트가 바꿀 수 있는 입력. 없으면 어댑터 · 파일 시스템에서 읽는다 */
export interface FlowGeneratorDeps {
  callGraph?: (ctx: ViewContext) => Promise<StaticCallGraph>;
  collectTraces?: (ctx: ViewContext) => Promise<TraceResult>;
  /** JUnit XML 본문. 파일이 없으면 `null` */
  readJunit?: (ctx: ViewContext) => Promise<string | null>;
}

/** 인수 테스트 파일 판정 (view-flow 3절 "`test/acceptance/**`만. 단위 테스트는 시나리오가 아니다") */
export const ACCEPTANCE_TEST_PREFIX = 'test/';

export function isAcceptanceTestFile(file: string | undefined): file is string {
  return file?.startsWith(ACCEPTANCE_TEST_PREFIX) ?? false;
}

// ---------------------------------------------------------------------------
// 노드 헬퍼
// ---------------------------------------------------------------------------

function cloneNode(node: FlowNode, patch: (n: FlowNode) => void): FlowNode {
  const copy: FlowNode = { ...node, children: node.children.map((child) => cloneNode(child, patch)) };
  patch(copy);
  return copy;
}

export function walkNodes(node: FlowNode, visit: (n: FlowNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children) walkNodes(child, visit, depth + 1);
}

function nodeIds(node: FlowNode): string[] {
  const ids: string[] = [];
  walkNodes(node, (n) => ids.push(n.id));
  return ids;
}

function findNode(node: FlowNode, id: string): FlowNode | undefined {
  let found: FlowNode | undefined;
  walkNodes(node, (n) => {
    if (found === undefined && n.id === id) found = n;
  });
  return found;
}

/** `entry:POST /refunds` → `{ method, path }` */
export function parseEntryId(id: string): { method: string; path: string } | undefined {
  const match = /^entry:([A-Z]+) (\S.*)$/.exec(id);
  return match?.[1] && match[2] ? { method: match[1], path: match[2] } : undefined;
}

// ---------------------------------------------------------------------------
// 검사 매핑 — 테스트 파일 → 규칙 (저장소:)
// ---------------------------------------------------------------------------

export interface CheckIndex {
  /** 테스트 파일(루트 기준) → 규칙 ID */
  rulesByFile: Map<string, RuleId[]>;
  statusOf: (ruleId: RuleId) => RuleStatus;
  /** 마지막 검사의 결과 (check.ref → outcome) */
  outcomeOf: (file: string) => 'pass' | 'fail' | 'none';
}

export function buildCheckIndex(
  rules: readonly Rule[],
  statuses: ReadonlyMap<RuleId, RuleStatus>,
  lastCheck: CheckRun | null,
  root?: string,
): CheckIndex {
  const rulesByFile = new Map<string, RuleId[]>();
  for (const rule of rules) {
    for (const check of checkRefsOf(rule)) {
      if (check.kind === 'static') continue;
      const key = toRootRelative(check.ref, root);
      const list = rulesByFile.get(key) ?? [];
      if (!list.includes(rule.id)) list.push(rule.id);
      rulesByFile.set(key, list);
    }
  }
  const outcomes = new Map<string, 'pass' | 'fail'>();
  for (const result of lastCheck?.results ?? []) {
    if (result.check.kind === 'static') continue;
    const key = toRootRelative(result.check.ref, root);
    if (result.outcome === 'pass') outcomes.set(key, outcomes.get(key) ?? 'pass');
    else if (result.outcome === 'fail' || result.outcome === 'error') outcomes.set(key, 'fail');
  }
  return {
    rulesByFile,
    statusOf: (ruleId) => statuses.get(ruleId) ?? 'unchecked',
    outcomeOf: (file) => outcomes.get(toRootRelative(file, root)) ?? 'none',
  };
}

function rulesFor(index: CheckIndex, file: string | undefined): FlowScenario['rules'] {
  if (file === undefined) return [];
  return (index.rulesByFile.get(file) ?? []).map((ruleId) => ({ ruleId, status: index.statusOf(ruleId) }));
}

// ---------------------------------------------------------------------------
// A안 — 스팬 → 노드 트리
// ---------------------------------------------------------------------------

/** 어댑터가 `testId`를 안 심었으면 속성에서 (`instrumentation-test.ts`가 쓰는 키) */
export function spanTestId(span: TraceSpan): { classname: string; name: string } | undefined {
  if (span.testId) return span.testId;
  const file = span.attributes['test.file'];
  const name = span.attributes['test.name'];
  if (typeof file === 'string' && file.length > 0 && typeof name === 'string' && name.length > 0) {
    return { classname: file, name };
  }
  return undefined;
}

function attr(span: TraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : value === undefined ? undefined : String(value);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]?.toLowerCase() + text.slice(1);
}

/** 외부 시스템 노드 ID. 정적 그래프(`prisma.<model>.<op>`)와 같은 꼴로 맞춘다 — Prisma 스팬의 `model`은 대문자로 시작한다 */
export function externalNodeId(system: string, model: string, operation: string): string {
  return `ext:${system}:${lowerFirst(model)}.${operation}`;
}

interface SpanTree {
  span: TraceSpan;
  children: SpanTree[];
}

function compareNano(a: string, b: string): number {
  const diff = BigInt(a) - BigInt(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

function buildSpanForest(spans: readonly TraceSpan[]): SpanTree[] {
  const nodes = new Map<string, SpanTree>();
  for (const span of spans) nodes.set(span.spanId, { span, children: [] });
  const roots: SpanTree[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentSpanId ? nodes.get(node.span.parentSpanId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: SpanTree[]) => {
    list.sort((a, b) => compareNano(a.span.startTimeUnixNano, b.span.startTimeUnixNano));
    for (const item of list) sort(item.children);
  };
  sort(roots);
  return roots;
}

/** 스팬 트리 아래 어딘가의 `db.system` (Prisma는 `prisma:engine:db_query`에 단다) */
function dbSystemOf(tree: SpanTree): string | undefined {
  const direct = attr(tree.span, 'db.system');
  if (direct) return direct;
  for (const child of tree.children) {
    const found = dbSystemOf(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * 스팬 하나 → 흐름 노드 (view-flow 4.0 해상도에 드는 것만). 해상도 밖의 스팬(테스트 루트 · Prisma 내부 · 알 수 없는 것)은
 * `null` — 자식을 부모에게 올린다. 이름과 종류는 어댑터 계측(`instrumentation-test.ts`)과 OTel 시맨틱 속성에서 온다.
 */
export function spanToNode(tree: SpanTree, symbols: Record<string, Anchor>): FlowNode | null {
  const { span } = tree;
  const block = attr(span, 'plumb.block') ?? attr(span, 'code.namespace');
  const fn = attr(span, 'code.function');
  const httpMethod = attr(span, 'http.request.method') ?? attr(span, 'http.method');
  const route = attr(span, 'http.route') ?? attr(span, 'url.path') ?? attr(span, 'http.target');
  const topic = attr(span, 'messaging.destination.name') ?? attr(span, 'messaging.destination');

  let node: FlowNode | null = null;
  if (block && fn) {
    const id = `${block}.${fn}`;
    node = { id, kind: 'public', label: id, children: [], evidence: 'span' };
  } else if (span.name === 'prisma:client:operation') {
    const model = attr(span, 'model') ?? 'unknown';
    const operation = attr(span, 'method') ?? 'unknown';
    const system = dbSystemOf(tree) ?? 'db';
    const id = externalNodeId('db', model, operation);
    node = {
      id,
      kind: 'external',
      label: `db: ${lowerFirst(model)}.${operation}`,
      children: [],
      evidence: 'span',
      external: { system, operation: `${lowerFirst(model)}.${operation}` },
    };
  } else if (httpMethod && route && span.kind === 'server') {
    const id = `entry:${httpMethod.toUpperCase()} ${route}`;
    node = { id, kind: 'entry', label: `${httpMethod.toUpperCase()} ${route}`, children: [], evidence: 'span' };
  } else if (topic && (span.kind === 'producer' || span.kind === 'consumer')) {
    const id = `event:${topic}`;
    node =
      span.kind === 'producer'
        ? { id, kind: 'emit', label: `emit ${topic}`, children: [], evidence: 'span' }
        : { id, kind: 'handler', label: `handle ${topic}`, children: [], evidence: 'span' };
  }
  if (node) {
    const anchor = symbols[node.id];
    if (anchor) node.anchor = { ...anchor };
  }
  return node;
}

/** 스팬 포레스트 → 노드 포레스트. 해상도 밖 스팬은 투명(자식을 올림), 같은 ID의 연속 형제는 하나로 (호출 횟수는 그리지 않는다) */
export function spanForestToNodes(forest: SpanTree[], symbols: Record<string, Anchor>): FlowNode[] {
  const out: FlowNode[] = [];
  for (const tree of forest) {
    const node = spanToNode(tree, symbols);
    const children = spanForestToNodes(tree.children, symbols);
    if (node === null) {
      mergeInto(out, children);
      continue;
    }
    node.children = children;
    mergeInto(out, [node]);
  }
  return out;
}

function mergeInto(target: FlowNode[], nodes: FlowNode[]): void {
  for (const node of nodes) {
    const last = target[target.length - 1];
    if (last && last.id === node.id && last.kind === node.kind) {
      mergeInto(last.children, node.children);
      if (node.evidence === 'span' && last.evidence === 'static') last.evidence = 'both';
      continue;
    }
    target.push(node);
  }
}

/** 정적 그래프에서 이 스팬 묶음이 가장 많이 겹치는 진입점. 겹침 0이면 없음 */
export function matchEntry(entries: readonly FlowNode[], coveredIds: ReadonlySet<string>): FlowNode | undefined {
  let best: { entry: FlowNode; overlap: number } | undefined;
  for (const entry of entries) {
    const overlap = new Set(nodeIds(entry).filter((id) => coveredIds.has(id))).size;
    if (overlap > 0 && (best === undefined || overlap > best.overlap)) best = { entry, overlap };
  }
  return best?.entry;
}

/**
 * 정적 노드를 스팬 트리에 겹친다. 스팬이 지나간 노드(`coveredIds`)는 그 스팬 노드를 `both`로 표시하고 그 아래로 내려가며,
 * 스팬에 없는 정적 노드는 `evidence: 'static'`(점선) 사본으로 덧붙인다. 스팬에만 있는 노드(핸들러 · DI)는 그대로 실선.
 */
export function overlayStatic(
  root: FlowNode,
  staticChildren: readonly FlowNode[],
  coveredIds: ReadonlySet<string>,
): void {
  const place = (target: FlowNode, staticNode: FlowNode) => {
    if (coveredIds.has(staticNode.id)) {
      const spanNode = findNode(root, staticNode.id);
      if (spanNode) {
        if (spanNode.evidence === 'span') spanNode.evidence = 'both';
        if (spanNode.anchor === undefined && staticNode.anchor) spanNode.anchor = { ...staticNode.anchor };
        if (spanNode.external === undefined && staticNode.external) spanNode.external = { ...staticNode.external };
        for (const child of staticNode.children) place(spanNode, child);
        return;
      }
    }
    const copy: FlowNode = { ...staticNode, children: [], evidence: 'static' };
    target.children.push(copy);
    for (const child of staticNode.children) place(copy, child);
  };
  for (const child of staticChildren) place(root, child);
}

export function countStatic(root: FlowNode): number {
  let count = 0;
  walkNodes(root, (n) => {
    if (n.evidence === 'static') count += 1;
  });
  return count;
}

export interface TraceScenarioInput {
  testcase: JunitCase;
  spans: readonly TraceSpan[];
  graph: StaticCallGraph | undefined;
  index: CheckIndex;
}

/** 인수 테스트 하나 → 시나리오. 스팬 트리가 뼈대, 정적 그래프가 점선 */
export function buildTraceScenario({ testcase, spans, graph, index }: TraceScenarioInput): FlowScenario {
  const symbols = graph?.symbols ?? {};
  const forest = spanForestToNodes(buildSpanForest(spans), symbols);
  const coveredIds = new Set<string>();
  for (const node of forest) for (const id of nodeIds(node)) coveredIds.add(id);

  const entry = graph ? matchEntry(graph.entries, coveredIds) : undefined;
  let root: FlowNode;
  if (entry) {
    const spanEntry = forest.find((n) => n.id === entry.id);
    root = spanEntry ?? { ...entry, children: [], evidence: 'static' };
    if (!spanEntry) {
      for (const node of forest) root.children.push(node);
    }
    overlayStatic(root, entry.children, coveredIds);
  } else if (forest.length === 1 && forest[0]) {
    root = forest[0];
  } else {
    // 진입점을 못 찾았다 — 테스트가 라우트를 거치지 않고 공개 진입점을 직접 불렀거나 스팬이 0개 (view-flow 5절)
    root = {
      id: `test:${testcase.id}`,
      kind: 'entry',
      label: forest.length === 0 ? '스팬 0개 — 공개 진입점을 거치지 않는 테스트' : '테스트 직접 호출 (진입점 없음)',
      children: forest,
      evidence: forest.length === 0 ? 'static' : 'span',
    };
  }

  if (testcase.status === 'fail' || testcase.status === 'error') {
    const last = [...spans].sort((a, b) => compareNano(b.endTimeUnixNano, a.endTimeUnixNano))[0];
    const lastNode = last ? findLastSpanNode(root, last, symbols) : undefined;
    if (lastNode) lastNode.failurePoint = true;
  }

  const scenario: FlowScenario = {
    id: testcase.id,
    unit: 'scenario',
    testId: { classname: testcase.classname, name: testcase.name },
    rules: rulesFor(index, testcase.file),
    result: testcase.status === 'pass' ? 'pass' : testcase.status === 'skipped' ? 'none' : 'fail',
    root,
    uncoveredCount: countStatic(root),
    spanCount: spans.length,
  };
  if (testcase.file) scenario.test = { file: testcase.file };
  const parsed = parseEntryId(root.id);
  if (parsed) scenario.entry = { ...parsed, ...(root.anchor ? { anchor: { ...root.anchor } } : {}) };
  const block = firstBlock(root);
  if (block) scenario.block = block;
  return scenario;
}

function findLastSpanNode(root: FlowNode, last: TraceSpan, symbols: Record<string, Anchor>): FlowNode | undefined {
  const node = spanToNode({ span: last, children: [] }, symbols);
  if (!node) return undefined;
  let found: FlowNode | undefined;
  walkNodes(root, (n) => {
    if (n.id === node.id && n.evidence !== 'static') found = n;
  });
  return found;
}

function firstBlock(root: FlowNode): string | undefined {
  let block: string | undefined;
  walkNodes(root, (n) => {
    if (block === undefined && n.kind !== 'entry' && n.anchor?.block) block = n.anchor.block;
  });
  return block;
}

/** 어떤 테스트도 지나지 않은 진입점 → 전부 점선 시나리오 (view-flow 3절 "정적 그래프에서만 도출된 시나리오") */
export function derivedScenario(entry: FlowNode): FlowScenario {
  const root = cloneNode(entry, (n) => {
    n.evidence = 'static';
  });
  const scenario: FlowScenario = {
    id: entry.id,
    unit: 'entry',
    rules: [],
    result: 'none',
    root,
    uncoveredCount: countStatic(root),
    spanCount: 0,
    derivedFromStatic: true,
  };
  const parsed = parseEntryId(entry.id);
  if (parsed) scenario.entry = { ...parsed, ...(entry.anchor ? { anchor: { ...entry.anchor } } : {}) };
  const block = firstBlock(root);
  if (block) scenario.block = block;
  return scenario;
}

// ---------------------------------------------------------------------------
// B안 — 진입점 → 시나리오 ("테스트 있음/없음"은 검사 매핑 + 테스트 import 그래프)
// ---------------------------------------------------------------------------

export function staticScenario(entry: FlowNode, graph: StaticCallGraph, index: CheckIndex): FlowScenario {
  /** 이 진입점 아래 공개 노드를 import하는, 검사 매핑에 있는 테스트 파일 */
  const mappedTests = new Set<string>();
  walkNodes(entry, (n) => {
    if (n.kind !== 'public') return;
    for (const file of graph.testRefs[n.id] ?? []) {
      if (index.rulesByFile.has(toRootRelative(file))) mappedTests.add(toRootRelative(file));
    }
  });
  const referenced = new Set<string>();
  walkNodes(entry, (n) => {
    if (n.kind !== 'public') return;
    if ((graph.testRefs[n.id] ?? []).some((file) => mappedTests.has(toRootRelative(file)))) referenced.add(n.id);
  });

  const root = cloneNode(entry, (n) => {
    n.evidence = undefined;
    if (n.kind === 'entry') n.testRef = mappedTests.size > 0 ? 'referenced' : 'static';
    else if (n.kind === 'public') n.testRef = referenced.has(n.id) ? 'referenced' : 'static';
    else if (n.kind === 'internal') n.testRef = 'internal';
    else n.testRef = 'static';
    if (n.kind === 'emit') n.handlerUnknown = true;
  });

  const testFile = [...mappedTests].sort()[0];
  const scenario: FlowScenario = {
    id: entry.id,
    unit: 'entry',
    rules: testFile ? rulesFor(index, testFile) : [],
    result: testFile ? index.outcomeOf(testFile) : 'none',
    root,
    uncoveredCount: testFile ? 0 : 1,
  };
  if (testFile) scenario.test = { file: testFile };
  const parsed = parseEntryId(entry.id);
  if (parsed) scenario.entry = { ...parsed, ...(entry.anchor ? { anchor: { ...entry.anchor } } : {}) };
  const block = firstBlock(root);
  if (block) scenario.block = block;
  return scenario;
}

// ---------------------------------------------------------------------------
// 검사 범위 밖 — 검증 상태 View(#57)가 읽는 값
// ---------------------------------------------------------------------------

export function computeUncovered(
  mode: FlowMode,
  scenarios: readonly FlowScenario[],
  graph: StaticCallGraph | undefined,
): FlowView['uncovered'] {
  if (mode === 'static') {
    const items: UncoveredFlow[] = scenarios
      .filter((s) => s.uncoveredCount > 0)
      .map((s) => ({ kind: 'uncovered-flow', scenarioOrEntry: s.id, nodeIds: nodeIds(s.root), mode }));
    return { count: items.length, total: scenarios.length, items };
  }
  const allStatic = new Set<string>();
  for (const entry of graph?.entries ?? []) for (const id of nodeIds(entry)) allStatic.add(id);
  const covered = new Set<string>();
  const items: UncoveredFlow[] = [];
  for (const scenario of scenarios) {
    const dotted: string[] = [];
    walkNodes(scenario.root, (n) => {
      if (n.evidence === 'static') dotted.push(n.id);
      else covered.add(n.id);
    });
    if (dotted.length > 0) items.push({ kind: 'uncovered-flow', scenarioOrEntry: scenario.id, nodeIds: dotted, mode });
  }
  const count = [...allStatic].filter((id) => !covered.has(id)).length;
  return { count, total: allStatic.size, items };
}

// ---------------------------------------------------------------------------
// 생성기
// ---------------------------------------------------------------------------

const DEFAULT_JUNIT_PATH = 'reports/junit.xml';

async function defaultReadJunit(ctx: ViewContext): Promise<string | null> {
  const path = resolve(ctx.root, ctx.config.checks?.junitReport ?? DEFAULT_JUNIT_PATH);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function defaultCallGraph(ctx: ViewContext): Promise<StaticCallGraph> {
  if (!hasCallGraph(ctx.adapter)) {
    throw new Error(`어댑터 "${ctx.adapter.name}"는 정적 호출 그래프(buildCallGraph)를 제공하지 않는다`);
  }
  return ctx.adapter.buildCallGraph(adapterContextOf(ctx));
}

async function defaultCollectTraces(ctx: ViewContext): Promise<TraceResult> {
  try {
    return await ctx.adapter.collectTraces(adapterContextOf(ctx), {});
  } catch (error) {
    // 미구현 · 전제 미충족 — 트레이스 없음으로 적고 B안으로 간다. 숨기지 않는다
    return { unavailable: 'no-trace', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function createFlowGenerator(deps: FlowGeneratorDeps = {}): ViewGenerator<FlowView> {
  const callGraph = deps.callGraph ?? defaultCallGraph;
  const collectTraces = deps.collectTraces ?? defaultCollectTraces;
  const readJunit = deps.readJunit ?? defaultReadJunit;

  return {
    name: 'flow',

    async generate(ctx) {
      const modeConfig = ctx.config.flow?.mode ?? 'auto';
      const sources: SourceRef[] = [];

      // 1. 파서: 정적 호출 그래프 (항상)
      let graph: StaticCallGraph | undefined;
      let graphError: string | undefined;
      try {
        graph = await callGraph(ctx);
        sources.push(
          source.parser(
            graph.tool.name,
            graph.tool.version,
            (ctx.config.flow?.entryGlob ?? ['src/app/api/**/route.ts']).join(','),
          ),
        );
      } catch (error) {
        graphError = error instanceof Error ? error.message : String(error);
      }

      // 2. 실행: 트레이스 (설정이 static이 아니면 시도)
      let traces: TraceResult | undefined;
      if (modeConfig !== 'static') {
        traces = await collectTraces(ctx);
        if ('spans' in traces)
          sources.push(source.execution(traces.tool.name, traces.tool.version, `${traces.files.length} files`));
      }
      const spans: TraceSpan[] = traces && 'spans' in traces ? traces.spans : [];
      const mode: FlowMode = traces && 'spans' in traces ? 'trace' : 'static';

      // 3. 실행: JUnit · 저장소: 규칙 · 상태 · 마지막 검사
      const junitXml = await readJunit(ctx);
      const cases = junitXml ? allCases(parseJunit(junitXml, { root: ctx.root })) : [];
      const acceptance = cases.filter((c) => isAcceptanceTestFile(c.file));
      if (junitXml)
        sources.push(source.execution('vitest-junit', undefined, ctx.config.checks?.junitReport ?? DEFAULT_JUNIT_PATH));

      const [rules, statusRecords, lastRun] = await Promise.all([
        ctx.store.rules.list(),
        ctx.store.ruleStatus.list(),
        ctx.store.checks.latest(),
      ]);
      const statuses = new Map<RuleId, RuleStatus>(statusRecords.map((r) => [r.ruleId, r.detail.status]));
      const index = buildCheckIndex(rules, statuses, lastRun, ctx.root);
      sources.push(source.store('rules.yaml'));

      // 4. 시나리오
      const scenarios: FlowScenario[] = [];
      if (mode === 'trace') {
        const byTest = new Map<string, TraceSpan[]>();
        for (const span of spans) {
          const id = spanTestId(span);
          if (!id) continue;
          const key = `${id.classname}::${id.name}`;
          const list = byTest.get(key) ?? [];
          list.push(span);
          byTest.set(key, list);
        }
        const usedEntries = new Set<string>();
        for (const testcase of acceptance) {
          const scenario = buildTraceScenario({ testcase, spans: byTest.get(testcase.id) ?? [], graph, index });
          if (scenario.root.kind === 'entry' && graph?.entries.some((e) => e.id === scenario.root.id)) {
            usedEntries.add(scenario.root.id);
          }
          scenarios.push(scenario);
        }
        for (const entry of graph?.entries ?? []) {
          if (!usedEntries.has(entry.id)) scenarios.push(derivedScenario(entry));
        }
      } else if (graph) {
        for (const entry of graph.entries) scenarios.push(staticScenario(entry, graph, index));
      }

      const view: FlowView = {
        header: makeHeader('flow', { commit: ctx.commit, now: ctx.now(), sources }),
        mode,
        uncovered: computeUncovered(mode, scenarios, graph),
        scenarios,
      };
      if (traces && !('spans' in traces)) view.fallback = { reason: 'no-trace-files' };
      if (graphError !== undefined) {
        view.graphError = graphError;
        if (mode === 'trace') view.fallback = view.fallback ?? { reason: 'graph-failed' };
      }
      if (lastRun) view.lastCheck = { runId: lastRun.runId, commit: lastRun.commit, finishedAt: lastRun.finishedAt };
      if (traces && 'spans' in traces) view.traceCount = traces.files.length;
      if (!graph) view.empty = 'no-graph';
      else if (graph.entries.length === 0) view.empty = 'no-entries';
      else if (mode === 'trace' && acceptance.length === 0) view.empty = 'no-acceptance-tests';
      return view;
    },

    render(view) {
      return renderFlow(view);
    },
  };
}

/** 기본 생성기 — 어댑터 · 파일 시스템에서 읽는다 */
export const flowGenerator: ViewGenerator<FlowView> = createFlowGenerator();

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<FlowNode['kind'], string> = {
  entry: '진입점',
  public: '공개 진입점',
  internal: '내부 (한 단계)',
  external: '외부 시스템',
  emit: '이벤트 emit',
  handler: '이벤트 핸들러',
};

function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

function mermaidShape(node: FlowNode): string {
  const label = mermaidLabel(node.label);
  switch (node.kind) {
    case 'entry':
      return `([${label}])`;
    case 'external':
      return `[(${label})]`;
    case 'emit':
      return `>${label}]`;
    case 'handler':
      return `[[${label}]]`;
    case 'internal':
      return `[/${label}/]`;
    default:
      return `[${label}]`;
  }
}

/** 시나리오 하나의 `flowchart TD`. 실행 노드 `-->`, 정적만 `-.->`. B안은 전부 `-->` (구분 없음, view-flow 2.2) */
export function scenarioMermaid(scenario: FlowScenario, mode: FlowMode): string {
  const lines = ['flowchart TD'];
  let counter = 0;
  const declare = (node: FlowNode): string => {
    const id = `n${counter++}`;
    lines.push(`  ${id}${mermaidShape(node)}`);
    if (node.failurePoint) lines.push(`  style ${id} stroke:#d33,stroke-width:3px`);
    return id;
  };
  const visit = (node: FlowNode, id: string) => {
    for (const child of node.children) {
      const childId = declare(child);
      const arrow = mode === 'trace' && child.evidence === 'static' ? '-.->' : '-->';
      lines.push(`  ${id} ${arrow} ${childId}`);
      visit(child, childId);
    }
  };
  visit(scenario.root, declare(scenario.root));
  return lines.join('\n');
}

function evidenceLabel(node: FlowNode, mode: FlowMode): string {
  if (mode === 'trace') {
    if (node.evidence === 'both') return '실행: span + 파서: static';
    if (node.evidence === 'span') return '실행: span';
    return '파서: static (점선)';
  }
  if (node.testRef === 'referenced') return '참조됨 (테스트 import)';
  if (node.testRef === 'internal') return '내부';
  return '파서: static';
}

function scenarioTable(scenario: FlowScenario, mode: FlowMode): string {
  const rows: string[][] = [];
  walkNodes(scenario.root, (node, depth) => {
    const indent = depth === 0 ? '' : `${'  '.repeat(depth - 1)}└ `;
    const anchor = node.anchor ? anchorLink(node.anchor) : '';
    const extra = [node.failurePoint ? '실패 지점' : '', node.handlerUnknown ? '⚠ 핸들러 연결 불명' : '']
      .filter(Boolean)
      .join(' · ');
    rows.push([
      `${indent}${codeSpan(node.label)}`,
      KIND_LABEL[node.kind],
      node.anchor?.block ?? (node.kind === 'external' ? (node.external?.system ?? '') : ''),
      anchor,
      extra ? `${evidenceLabel(node, mode)} · ${extra}` : evidenceLabel(node, mode),
    ]);
  });
  return mdTable(['노드', '종류', '블록', '위치', '근거'], rows);
}

function scenarioHeading(scenario: FlowScenario): string {
  const entry = scenario.entry ? `${scenario.entry.method} ${scenario.entry.path}` : scenario.root.label;
  const test = scenario.testId ? scenario.testId.name : '테스트 없음';
  return heading(3, `${escapeMd(entry)} — ${escapeMd(test)}`);
}

function scenarioStatusLine(scenario: FlowScenario, mode: FlowMode): string {
  const parts: string[] = [];
  if (scenario.unit === 'scenario') {
    parts.push(scenario.result === 'pass' ? '✔ 통과' : scenario.result === 'fail' ? '✘ 실패' : '결과 없음');
    if (scenario.test?.file) parts.push(codeSpan(scenario.test.file));
  } else if (mode === 'static') {
    parts.push(scenario.test?.file ? `테스트 있음: ${codeSpan(scenario.test.file)}` : '테스트 없음');
    if (scenario.result !== 'none') parts.push(scenario.result === 'pass' ? '✔ 통과' : '✘ 실패');
  } else {
    parts.push('테스트 없음 · 정적 그래프에서만 도출 (전부 점선)');
  }
  parts.push(
    scenario.rules.length === 0
      ? '(규칙 없음)'
      : `규칙 ${scenario.rules.map((r) => `${codeSpan(r.ruleId)} ${statusIcon(r.status)}`).join(', ')}`,
  );
  if (mode === 'trace' && scenario.spanCount !== undefined) {
    parts.push(
      scenario.spanCount === 0 && !scenario.derivedFromStatic
        ? '스팬 0개 — 공개 진입점을 거치지 않는 테스트'
        : `스팬 ${scenario.spanCount}개`,
    );
    parts.push(`점선 ${scenario.uncoveredCount}개`);
  }
  return parts.join(' · ');
}

export function renderFlow(view: FlowView): string {
  const out: string[] = [heading(1, '도메인별 흐름도'), '', sourceBar(view.header.sources), ''];

  if (view.mode === 'trace') {
    const count = view.scenarios.filter((s) => s.unit === 'scenario').length;
    out.push(
      `모드: 트레이스 — 트레이스 ${count}개 시나리오 · 스팬 파일 ${view.traceCount ?? 0}개. 실선 = 실행: OTel 스팬, 점선 = 파서: 정적 호출 그래프에만 있음 (테스트가 지나가지 않음)`,
    );
  } else {
    out.push(
      '모드: 정적 — 트레이스 없음 — 정적 호출 그래프만. 실선·점선 구분 없음. "테스트 있음/없음"은 저장소: 검사 매핑 + 파서: 테스트 import 그래프에서 (참조됨 ≠ 실행됨)',
    );
  }
  if (view.fallback) {
    out.push(
      view.fallback.reason === 'no-trace-files'
        ? '⚠ 트레이스 없음 — 이번 실행에서 스팬이 수집되지 않았다 (setupFiles 미설정 또는 exporter 실패). 정적(대체) 표현으로 전환'
        : '⚠ 정적 그래프 생성 실패 — 실선만 그린다. 점선 없음',
    );
  }
  if (view.graphError !== undefined) out.push(`정적 그래프 생성 실패: ${escapeMd(view.graphError)}`);
  if (view.empty === 'no-graph') out.push('아직 생성되지 않음. `plumb views flow`');
  if (view.empty === 'no-entries')
    out.push(
      '진입점 없음 — `src/app/api/**/route.ts`에서 export된 메서드가 없다. `plumb.config.json` `flow.entryGlob`을 확인한다',
    );
  if (view.empty === 'no-acceptance-tests')
    out.push('인수 테스트 없음 — `test/**`의 JUnit testcase가 0개. 모든 진입점을 정적 그래프에서만 그린다 (전부 점선)');
  if (view.mode === 'static')
    out.push(
      '',
      '정적 그래프에서 안 보이는 것 — 이벤트 핸들러 연결 · 미들웨어 순서 · DI 구현 · 동적 import. 호출 순서는 표시하지 않는다',
    );
  out.push('');

  if (view.scenarios.length === 0) out.push('시나리오 없음', '');
  for (const scenario of view.scenarios) {
    out.push(scenarioHeading(scenario), '', scenarioStatusLine(scenario, view.mode), '');
    out.push(mermaid(scenarioMermaid(scenario, view.mode)), '');
    out.push(scenarioTable(scenario, view.mode), '');
  }

  const { count, total } = view.uncovered;
  if (view.mode === 'trace') {
    out.push(
      heading(
        2,
        total === 0 && view.graphError
          ? '테스트가 안 지나간 흐름 — 측정 불가 (정적 그래프 없음)'
          : `테스트가 안 지나간 흐름 ${count} / 전체 ${total}`,
      ),
    );
  } else {
    out.push(
      heading(
        2,
        total === 0
          ? '테스트가 안 지나간 흐름 — 측정 불가 (진입점 없음)'
          : `테스트가 안 지나간 흐름 ${count} / 전체 ${total} (테스트가 참조하지 않는 진입점)`,
      ),
    );
  }
  if (view.uncovered.items.length > 0) {
    out.push('');
    out.push(
      mdTable(
        ['시나리오 · 진입점', '노드'],
        view.uncovered.items.map((item) => [codeSpan(item.scenarioOrEntry), item.nodeIds.map(codeSpan).join(', ')]),
      ),
    );
  }
  out.push('', '→ 검증 상태 View "검사 범위 밖"');
  return `${out.join('\n')}\n`;
}
