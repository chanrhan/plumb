/**
 * 아키텍처 다이어그램 View 생성기 (이슈 #54, view-architecture 2·3절, 기획안 §6 · §12).
 *
 * 입력 세 가지를 합쳐 `ArchitectureView` JSON(정본)을 만들고, 그 JSON만 보고 Markdown(Mermaid L0 · L1 + 표)을 그린다:
 * - 파서: 어댑터 `extractDependencies()`의 블록 그래프 (노드 · 간선 · 인프라 · 미분류) + `plumb.config.json`(선언된 방향)
 * - 실행: 최신 `CheckRun`의 정적 결과 `depcruise:block-1-*` · `block-2-*` → 필수 검사 (1)(2). 없으면 ⬜ — 위반 0건이라고 쓰지 않는다
 * - git: `git diff --name-only HEAD~1..HEAD` → 마지막 커밋 하나의 변경 영향 범위. 커밋이 하나뿐이거나 git이 없으면 `unavailable`
 *
 * 추출 실패는 숨기지 않는다 — `extractionError`를 달고, 이전 View JSON이 있으면 그 그래프를 그대로 두고 머리말만 갱신한다 (5절).
 * 함수 본문 · 제어 흐름은 그리지 않는다 (기획안 §16). L2 · L3은 이 View에 없다.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockGraph } from '../adapter/types.js';
import { computeCommonRows } from '../checks/common.js';
import type { Store } from '../store/index.js';
import type {
  ArchitectureView,
  BlockEdge,
  BlockNode,
  CheckRun,
  CommonCheckRow,
  InfraEdge,
  InfraKind,
  RequiredChecks,
  Rule,
  StaticCheckResult,
  StaticViolation,
} from '../types/index.js';
import { makeHeader, source } from './header.js';
import { anchorLink, codeSpan, escapeCell, heading, mdTable, mermaid, shortCommit, sourceBar } from './markdown.js';
import { adapterContextOf, type ViewContext, type ViewGenerator } from './types.js';

// ---------------------------------------------------------------------------
// 상수 — 블록 노드는 공유 타입 `BlockNode` 그대로 (어댑터가 넣는 `risk` · `declared` · `shared`, 생성기가 채우는 `rules`)
// ---------------------------------------------------------------------------

/** L0 앱 노드의 ID. L1 `app`(Route Handler 블록)과 다르다 — "대상 하나 = 노드 하나" (view-architecture 3절 "L0 노드 — 앱") */
export const SYSTEM_NODE_ID = 'system';

const TOOL_NAME = 'dependency-cruiser';
const INFRA_KINDS: readonly InfraKind[] = ['db', 'cache', 'queue', 'external-api'];
const INFRA_LABEL: Record<InfraKind, string> = { db: 'DB', cache: '캐시', queue: '큐', 'external-api': '외부 API' };
const STDERR_TAIL = 20;

// ---------------------------------------------------------------------------
// 글롭 → 정규식 (블록 `paths`로 파일을 블록에 매핑. `**` · `*` · `?` · `{a,b}`만)
// ---------------------------------------------------------------------------

/** 블록 경계 글롭 하나를 정규식으로. 코어에 글롭 라이브러리가 없어 최소한만 지원한다 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const pattern = glob.replace(/^\.\//, '');
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') re += '(?:';
    else if (ch === '}') re += ')';
    else if (ch === ',') re += '|';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** 파일 → 블록 ID (`paths` 글롭 순서대로 첫 번째). 어느 블록에도 안 맞으면 `null` */
export function blockMatcher(blocks: readonly BlockNode[]): (file: string) => string | null {
  const table = blocks
    .filter((block) => block.level === 'L1' && block.paths.length > 0)
    .map((block) => ({ id: block.id, patterns: block.paths.map(globToRegExp) }));
  return (file) => {
    const posix = file.replaceAll('\\', '/').replace(/^\.\//, '');
    for (const { id, patterns } of table) {
      if (patterns.some((re) => re.test(posix))) return id;
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// git · 추출 실패 · 이전 View
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

/**
 * 마지막 커밋 하나의 변경 영향 범위 (view-architecture 3절 "마지막 커밋 영향 범위"). `--relative`라 대상 루트 밖의 변경은 세지 않는다.
 * git이 없거나 커밋이 하나뿐(`HEAD~1` 없음)이면 `unavailable` — 0 블록이라고 쓰지 않는다
 */
export function computeImpact(root: string, blocks: readonly BlockNode[]): ArchitectureView['impact'] {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (head === undefined || !/^[0-9a-f]{40}$/.test(head)) return { unavailable: 'no-git' };
  const diff = git(root, ['diff', '--name-only', '--relative', 'HEAD~1..HEAD']);
  if (diff === null) return { unavailable: 'no-git' };
  const blockOf = blockMatcher(blocks);
  const touched = new Set<string>();
  let unclassified = 0;
  for (const file of diff.split('\n').filter((line) => line.length > 0)) {
    const block = blockOf(file);
    if (block === null) unclassified += 1;
    else touched.add(block);
  }
  return { commit: head, blocks: [...touched].sort(), unclassified };
}

/** 어댑터 예외 → `extractionError`. 메시지의 `(exit N)`을 읽고, 없으면 1. 꼬리는 메시지 마지막 20줄 */
export function toExtractionError(error: unknown): NonNullable<ArchitectureView['extractionError']> {
  const message = error instanceof Error ? error.message : String(error);
  const exit = /\(exit (-?\d+)\)/.exec(message);
  const lines = message.split(/\r?\n/).filter((line) => line.length > 0);
  return { exitCode: exit?.[1] === undefined ? 1 : Number(exit[1]), stderrTail: lines.slice(-STDERR_TAIL) };
}

/** 저장소의 이전 아키텍처 View. 없거나 읽을 수 없으면 `null` (추출 실패 때만 쓴다) */
async function readPrevious(store: Store): Promise<ArchitectureView | null> {
  try {
    const stored = await store.views.read('architecture');
    if (stored === null || stored.view.header.view !== 'architecture') return null;
    return stored.view as ArchitectureView;
  } catch {
    return null;
  }
}

/** 대상의 `package.json` `name`. 없으면 `config.service`(`.`이 아닐 때), 그것도 없으면 "앱" */
function appLabel(ctx: ViewContext): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ctx.root, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
  } catch {
    // package.json 없음 — 설정으로
  }
  const service = ctx.config.service;
  return service.length > 0 && service !== '.' ? service : '앱';
}

// ---------------------------------------------------------------------------
// 그래프 가공 — 앱 노드 · 규칙 수 · 순환 · 위반 보강
// ---------------------------------------------------------------------------

function isInfra(block: BlockNode): boolean {
  return (INFRA_KINDS as readonly string[]).includes(block.kind);
}

/** L1 블록만 (L0 인프라 · 앱 노드 제외) */
export function l1Blocks(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.filter((block): block is BlockNode => block.level === 'L1' && !isInfra(block));
}

/** L0 앱 노드를 하나 보장한다. 파일 수는 L1 블록 파일 수의 합 */
function withSystemNode(blocks: readonly BlockNode[], label: string): BlockNode[] {
  const rest = blocks.filter((block) => block.id !== SYSTEM_NODE_ID);
  const files = l1Blocks(rest).reduce((sum, block) => sum + block.files, 0);
  const system: BlockNode = {
    id: SYSTEM_NODE_ID,
    level: 'L0',
    kind: 'app',
    paths: [],
    public: [],
    files,
    label,
  };
  return [system, ...rest.map((block) => ({ ...block }))];
}

function withRuleCounts(blocks: BlockNode[], rules: readonly Rule[]): BlockNode[] {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    if (rule.block !== undefined) counts.set(rule.block, (counts.get(rule.block) ?? 0) + 1);
  }
  return blocks.map((block) =>
    block.level === 'L1' && !isInfra(block) ? { ...block, rules: counts.get(block.id) ?? 0 } : block,
  );
}

/** 블록 수준 순환 — L1 간선의 강결합 요소(Tarjan) 중 블록이 둘 이상인 것. 블록 안 파일 순환은 세지 않는다 (L2 이하) */
export function blockCycles(edges: readonly BlockEdge[]): Array<{ blocks: string[] }> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)?.push(edge.to);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let popped: string | undefined;
      do {
        popped = stack.pop();
        if (popped !== undefined) {
          onStack.delete(popped);
          component.push(popped);
        }
      } while (popped !== undefined && popped !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of [...adjacency.keys()].sort()) {
    if (!index.has(node)) visit(node);
  }
  return components.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? '')).map((blocks) => ({ blocks }));
}

/** 위반의 `fromBlock` · `toBlock`을 블록 글롭으로 채운다 (`checks/common.ts`는 메시지만 보므로 비어 있을 수 있다) */
function enrichViolations(result: StaticCheckResult, blockOf: (file: string) => string | null): StaticCheckResult {
  if (result.status !== 'fail') return result;
  const [first, ...rest] = result.violations.map(
    (violation): StaticViolation => ({
      ...violation,
      fromBlock: violation.fromBlock.length > 0 ? violation.fromBlock : (blockOf(violation.from.file) ?? ''),
      toBlock: violation.toBlock.length > 0 ? violation.toBlock : (blockOf(violation.to) ?? ''),
    }),
  );
  if (first === undefined) return result;
  return { status: 'fail', violations: [first, ...rest] };
}

/** 최신 `CheckRun`의 정적 결과 → 필수 검사 3행. 검사가 없으면 (1)(2) ⬜, (3)은 git 유무만 */
export function computeRequiredChecks(
  latest: CheckRun | null,
  edges: readonly BlockEdge[],
  blockOf: (file: string) => string | null,
  gitAvailable: boolean,
): RequiredChecks {
  const rows = computeCommonRows(latest?.results ?? []);
  const access = staticResultOfRow(rows.find((row) => row.index === 1));
  const direction = staticResultOfRow(rows.find((row) => row.index === 2));
  const checks: RequiredChecks = {
    publicAccessOnly: enrichViolations(access, blockOf),
    declaredDirectionsOnly: { ...enrichViolations(direction, blockOf), cycles: blockCycles(edges) },
    signatureChanges: gitAvailable ? { changes: [] } : { unavailable: 'no-git' },
  };
  if (latest !== null) {
    checks.lastCheck = { runId: latest.runId, commit: latest.commit, finishedAt: latest.finishedAt };
  }
  return checks;
}

/** `CommonCheckRow.result`의 정적 변형만 — (3)의 `events` 변형은 여기 오지 않는다. 행이 없으면 ⬜ */
function staticResultOfRow(row: CommonCheckRow | undefined): StaticCheckResult {
  const result = row?.result;
  if (result === undefined || result.status === 'events') return { status: 'unchecked' };
  return result;
}

function violationCount(result: StaticCheckResult): number {
  return result.status === 'fail' ? result.violations.length : 0;
}

/** 블록 그래프 중 View에 옮기는 부분. 어댑터 결과와 이전 View JSON이 둘 다 이 모양이다 */
type GraphPart = Pick<BlockGraph, 'tool' | 'blocks' | 'edges' | 'infraEdges' | 'undetectedInfra' | 'unclassified'>;

/** 빈 그래프 — 추출 실패에 이전 결과도 없을 때 */
function emptyGraph(): GraphPart {
  return {
    tool: { name: TOOL_NAME, version: 'unknown' },
    blocks: [],
    edges: [],
    infraEdges: [],
    undetectedInfra: [...INFRA_KINDS],
    unclassified: [],
  };
}

// ---------------------------------------------------------------------------
// 생성기
// ---------------------------------------------------------------------------

export const architectureView: ViewGenerator<ArchitectureView> = {
  name: 'architecture',

  async generate(ctx: ViewContext): Promise<ArchitectureView> {
    let graph: GraphPart;
    let extractionError: ArchitectureView['extractionError'];
    try {
      graph = await ctx.adapter.extractDependencies(adapterContextOf(ctx));
    } catch (error) {
      extractionError = toExtractionError(error);
      const previous = await readPrevious(ctx.store);
      graph = previous === null ? emptyGraph() : previous;
    }

    const [latest, rules] = await Promise.all([ctx.store.checks.latest(), ctx.store.rules.list()]);
    const blocks = withRuleCounts(withSystemNode(graph.blocks, appLabel(ctx)), rules);
    const edges: BlockEdge[] = graph.edges.map((edge) => ({
      ...edge,
      imports: edge.imports.map((site) => ({ ...site })),
    }));
    const infraEdges: InfraEdge[] = graph.infraEdges.map((edge) => ({ ...edge, blocks: [...edge.blocks] }));
    const blockOf = blockMatcher(blocks);
    const impact = computeImpact(ctx.root, blocks);
    const requiredChecks = computeRequiredChecks(latest, edges, blockOf, !('unavailable' in impact));
    const contractChanges =
      'changes' in requiredChecks.signatureChanges ? requiredChecks.signatureChanges.changes.length : 0;

    const sources = [source.parser(TOOL_NAME, graph.tool.version, 'src'), source.parser('plumb.config.json')];
    if (latest !== null) sources.push(source.execution('plumb check', undefined, `checks/${latest.runId}.json`));
    if (!('unavailable' in impact)) sources.push(source.git(impact.commit, 'HEAD~1..HEAD'));

    const headerOpts =
      ctx.commit === undefined ? { now: ctx.now(), sources } : { commit: ctx.commit, now: ctx.now(), sources };
    const view: ArchitectureView = {
      header: makeHeader('architecture', headerOpts),
      tool: { ...graph.tool },
      blocks,
      edges,
      infraEdges,
      undetectedInfra: [...graph.undetectedInfra],
      unclassified: [...graph.unclassified],
      requiredChecks,
      impact,
      summary: {
        blocks: l1Blocks(blocks).length,
        crossingImports: edges.reduce((sum, edge) => sum + edge.count, 0),
        violations: {
          access: violationCount(requiredChecks.publicAccessOnly),
          direction: violationCount(requiredChecks.declaredDirectionsOnly),
        },
        cycles: requiredChecks.declaredDirectionsOnly.cycles.length,
        unclassified: graph.unclassified.length,
        contractChanges,
      },
      configMissing: ctx.config.blocks === undefined,
    };
    if (extractionError !== undefined) view.extractionError = extractionError;
    return view;
  },

  render(view: ArchitectureView): string {
    return renderArchitecture(view);
  },
};

// ---------------------------------------------------------------------------
// Mermaid — 노드 ID 정규화
// ---------------------------------------------------------------------------

const MERMAID_RESERVED = new Set([
  'end',
  'graph',
  'subgraph',
  'flowchart',
  'style',
  'class',
  'classDef',
  'click',
  'linkStyle',
  'direction',
  'default',
]);

/** 블록 ID → Mermaid 노드 ID. 영숫자·`_`만 남기고(`external-api` → `external_api`), 숫자로 시작하거나 예약어면 `b_` 접두어. 충돌은 번호로 */
export class MermaidIds {
  private readonly byId = new Map<string, string>();
  private readonly used = new Set<string>();

  of(id: string): string {
    const existing = this.byId.get(id);
    if (existing !== undefined) return existing;
    let base = id.replace(/[^A-Za-z0-9_]/g, '_');
    if (base.length === 0 || /^[0-9]/.test(base) || MERMAID_RESERVED.has(base)) base = `b_${base}`;
    let candidate = base;
    for (let n = 2; this.used.has(candidate); n++) candidate = `${base}_${n}`;
    this.used.add(candidate);
    this.byId.set(id, candidate);
    return candidate;
  }
}

/** Mermaid 라벨 안의 큰따옴표 → `#quot;`, 줄바꿈 → `<br/>` */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/\r?\n/g, '<br/>');
}

const DASHED_CLASS = 'classDef dashed fill:none,stroke-dasharray: 4 4';

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

function blockKindLabel(block: BlockNode): string {
  if (block.shared === true) return '공유';
  switch (block.kind) {
    case 'entry':
      return '진입점';
    case 'domain':
      return '도메인';
    case 'test':
      return '테스트';
    case 'unclassified':
      return '미분류';
    case 'app':
      return '앱';
    default:
      return INFRA_LABEL[block.kind as InfraKind] ?? block.kind;
  }
}

function l1NodeLabel(block: BlockNode): string {
  const lines = [block.id];
  const path = block.paths[0]?.replace(/\/?\*\*$/, '/');
  const where = block.kind === 'entry' && path === undefined ? 'Route Handler' : path;
  lines.push([where, `파일 ${block.files}`].filter((p): p is string => p !== undefined).join(' · '));
  if (block.risk === 'high') lines.push('고위험');
  return lines.join('\n');
}

/** L0 시스템: 앱 subgraph(L1 블록 묶음) + 감지된 인프라 노드 + 미감지 인프라 점선 노드. 간선은 앱 → 인프라 한 방향 */
export function renderL0(view: ArchitectureView): string {
  const ids = new MermaidIds();
  const system = view.blocks.find((block) => block.id === SYSTEM_NODE_ID);
  const systemId = ids.of(SYSTEM_NODE_ID);
  const lines = ['flowchart LR'];
  lines.push(`    subgraph ${systemId}["${mermaidLabel(`앱: ${system?.label ?? '앱'}`)}"]`);
  for (const block of l1Blocks(view.blocks)) {
    lines.push(`        ${ids.of(block.id)}["${mermaidLabel(block.id)}"]`);
  }
  lines.push('    end');

  const infra = view.blocks.filter((block) => block.level === 'L0' && isInfra(block));
  for (const node of infra) {
    const label = mermaidLabel(node.label ?? node.id);
    const shape =
      node.kind === 'queue' ? `[["${label}"]]` : node.kind === 'external-api' ? `["${label}"]` : `[("${label}")]`;
    lines.push(`    ${ids.of(node.id)}${shape}`);
  }
  const dashed: string[] = [];
  for (const kind of view.undetectedInfra) {
    const id = ids.of(`none-${kind}`);
    dashed.push(id);
    lines.push(`    ${id}("${mermaidLabel(`${INFRA_LABEL[kind]}: 감지된 설정 없음`)}")`);
  }

  // 같은 (대상, 근거)의 간선은 하나로 — 라벨 첫 줄 근거, 둘째 줄 쓰는 블록
  const grouped = new Map<string, { to: string; via: string; blocks: Set<string> }>();
  for (const edge of view.infraEdges) {
    const key = `${edge.to}\u0000${edge.via.kind}:${edge.via.name}`;
    const via = edge.via.kind === 'env' ? `process.env.${edge.via.name}` : edge.via.name;
    const entry = grouped.get(key) ?? { to: edge.to, via, blocks: new Set<string>() };
    for (const block of edge.blocks.length > 0 ? edge.blocks : [edge.from]) entry.blocks.add(block);
    grouped.set(key, entry);
  }
  for (const entry of grouped.values()) {
    const label = mermaidLabel([entry.via, [...entry.blocks].sort().join(' · ')].join('\n'));
    lines.push(`    ${systemId} -->|"${label}"| ${ids.of(entry.to)}`);
  }
  if (dashed.length > 0) {
    lines.push(`    ${DASHED_CLASS}`);
    lines.push(`    class ${dashed.join(',')} dashed`);
  }
  return lines.join('\n');
}

/** 간선에 걸린 위반 수 — (1)(2)의 위반 중 `fromBlock → toBlock`이 이 간선인 것 */
function violationsOfEdge(view: ArchitectureView, edge: BlockEdge): number {
  const all: StaticViolation[] = [];
  for (const result of [view.requiredChecks.publicAccessOnly, view.requiredChecks.declaredDirectionsOnly]) {
    if (result.status === 'fail') all.push(...result.violations);
  }
  return all.filter((v) => v.fromBlock === edge.from && v.toBlock === edge.to).length;
}

/** L1 도메인: 블록 노드 + 간선. 라벨 = import 수 (· 공개 / 내부 n) (· ⚠ n). 미선언 간선은 점선. 미분류는 간선 없는 점선 노드 */
export function renderL1(view: ArchitectureView): string {
  const ids = new MermaidIds();
  const lines = ['flowchart LR'];
  const blocks = l1Blocks(view.blocks);
  for (const block of blocks) {
    lines.push(`    ${ids.of(block.id)}["${mermaidLabel(l1NodeLabel(block))}"]`);
  }
  const dashed: string[] = [];
  if (view.unclassified.length > 0) {
    const id = ids.of('unclassified-files');
    dashed.push(id);
    lines.push(`    ${id}["${mermaidLabel(`미분류 ${view.unclassified.length} ▲`)}"]`);
  }
  for (const edge of view.edges) {
    const internal = edge.imports.filter((site) => !site.viaPublic).length;
    const parts = [String(edge.count), internal === 0 ? '공개' : `내부 ${internal}`];
    const violations = violationsOfEdge(view, edge);
    if (violations > 0) parts.push(`⚠ ${violations}`);
    const arrow = edge.declared ? '-->' : '-.->';
    lines.push(`    ${ids.of(edge.from)} ${arrow}|"${mermaidLabel(parts.join(' · '))}"| ${ids.of(edge.to)}`);
  }
  if (dashed.length > 0) {
    lines.push(`    ${DASHED_CLASS}`);
    lines.push(`    class ${dashed.join(',')} dashed`);
  }
  return lines.join('\n');
}

function staticResultCell(result: StaticCheckResult): string {
  if (result.status === 'unchecked') return '⬜ 검사 없음';
  if (result.status === 'pass') return '🟢 0';
  return `🔴 ${result.violations.length}`;
}

function violationDetail(result: StaticCheckResult): string {
  if (result.status !== 'fail') return '';
  const [first, ...rest] = result.violations;
  const where = anchorLink({ file: first.from.file, line: first.from.line });
  const target = first.to.length > 0 ? ` → ${codeSpan(first.to)}` : '';
  const pair =
    first.fromBlock.length > 0 || first.toBlock.length > 0
      ? `${first.fromBlock || '?'} → ${first.toBlock || '?'} · `
      : '';
  const more = rest.length > 0 ? ` 외 ${rest.length}건` : '';
  return `${pair}${where}${target} (${first.rule})${more}`;
}

function renderRequiredChecks(view: ArchitectureView): string[] {
  const checks = view.requiredChecks;
  const cycles = checks.declaredDirectionsOnly.cycles;
  const directionDetail = [violationDetail(checks.declaredDirectionsOnly)];
  if (cycles.length > 0)
    directionDetail.push(`순환 ${cycles.length}: ${cycles.map((c) => c.blocks.join(' ⇄ ')).join(', ')}`);

  let signature: [string, string];
  if ('unavailable' in checks.signatureChanges) signature = ['git 이력 없음', ''];
  else if (checks.signatureChanges.changes.length === 0)
    signature = ['⬜ 감지 없음', '공개 진입점 시그니처 비교는 M8 wave 1 — 아직 비교하지 않았다'];
  else {
    const changes = checks.signatureChanges.changes;
    signature = [`△ ${changes.length}`, changes.map((c) => `${c.block}/${c.file} ${codeSpan(c.symbol)}`).join(', ')];
  }

  const rows = [
    [
      '(1)',
      '공개 계약으로만 접근',
      staticResultCell(checks.publicAccessOnly),
      violationDetail(checks.publicAccessOnly),
    ],
    [
      '(2)',
      '선언된 방향만 · 순환 금지',
      staticResultCell(checks.declaredDirectionsOnly),
      directionDetail.filter((d) => d.length > 0).join(' · '),
    ],
    ['(3)', '공개 계약 시그니처 변경은 설계 변경 이벤트', signature[0], signature[1]],
  ];
  const out = [mdTable(['#', '검사', '결과', '상세'], rows), ''];
  const last = checks.lastCheck;
  out.push(
    last === undefined
      ? '검사 없음 — `plumb check`가 한 번도 돌지 않았다. 간선 표시는 파서 결과(공개/내부 · 선언/미선언)만으로 한다'
      : `실행: plumb check · ${codeSpan(last.runId)} · ${shortCommit(last.commit)} · ${last.finishedAt}`,
  );
  return out;
}

function renderSummaryBand(view: ArchitectureView): string {
  const s = view.summary;
  const checked =
    view.requiredChecks.publicAccessOnly.status !== 'unchecked' ||
    view.requiredChecks.declaredDirectionsOnly.status !== 'unchecked';
  const violations = checked
    ? `위반 접근 ${s.violations.access} / 방향 ${s.violations.direction}`
    : '위반 검사 없음 ⬜';
  const parts = [
    `블록 ${s.blocks}`,
    `경계 넘는 import ${s.crossingImports}`,
    violations,
    `순환 ${s.cycles}`,
    `미분류 ${s.unclassified}${s.unclassified > 0 ? ' ▲' : ''}`,
  ];
  if (s.contractChanges > 0) parts.push(`계약 변경 ${s.contractChanges}`);
  return parts.join(' · ');
}

function renderBlocksTable(view: ArchitectureView): string {
  const rows = l1Blocks(view.blocks).map((block) => {
    const publicCell =
      block.shared === true
        ? `전체 (${block.public.length})`
        : block.public.length === 0
          ? block.kind === 'entry'
            ? '— (진입점 블록)'
            : '없음'
          : block.public.map(codeSpan).join(', ');
    return [
      codeSpan(block.id),
      blockKindLabel(block),
      String(block.files),
      publicCell,
      block.risk === 'high' ? '🔺 고위험' : '—',
      block.rules === undefined ? '—' : String(block.rules),
    ];
  });
  return mdTable(['블록', '종류', '파일 수', '공개 진입점', '고위험', '규칙 수'], rows);
}

function renderEdgesTable(view: ArchitectureView): string {
  const rows = view.edges.map((edge) => {
    const viaPublic = edge.imports.filter((site) => site.viaPublic).length;
    const first = edge.imports[0];
    return [
      `${codeSpan(edge.from)} → ${codeSpan(edge.to)}`,
      String(edge.count),
      edge.declared ? '예' : '아니오 (미선언)',
      `${viaPublic}/${edge.imports.length}`,
      first === undefined ? '' : anchorLink({ file: first.file, line: first.line }),
    ];
  });
  return mdTable(['from → to', 'import 수', '선언됨', '공개 경유', '첫 import'], rows);
}

function renderImpact(view: ArchitectureView): string {
  if ('unavailable' in view.impact) return 'git 이력 없음 — 커밋이 하나뿐이거나 git이 없다';
  const { commit, blocks, unclassified } = view.impact;
  const list = blocks.length > 0 ? ` (${blocks.join(', ')})` : '';
  return `마지막 커밋(${shortCommit(commit)}) 영향 범위: ${blocks.length} 블록${list} + 미분류 ${unclassified}`;
}

/** `ArchitectureView` JSON → Markdown. `ctx` 없이 JSON만 본다 */
export function renderArchitecture(view: ArchitectureView): string {
  const header = view.header;
  const out: string[] = [heading(1, '아키텍처'), ''];
  out.push(sourceBar(header.sources), '');
  out.push(
    `생성: ${header.commit === undefined ? '생성 커밋 기록 없음' : shortCommit(header.commit)} · ${header.generatedAt} · ${view.tool.name} ${view.tool.version}`,
    '',
  );

  if (view.extractionError !== undefined) {
    const hasGraph = l1Blocks(view.blocks).length > 0 || view.edges.length > 0;
    out.push(
      `> **추출 실패 (exit ${view.extractionError.exitCode})** — ${hasGraph ? '아래 그래프는 이전 성공 결과다. 생성 커밋·시각을 확인한다' : '이전 성공 결과가 없어 빈 그래프다'}`,
    );
    for (const line of view.extractionError.stderrTail) out.push(`> ${escapeCell(line)}`);
    out.push('');
  }
  if (view.configMissing === true) {
    out.push('> **plumb.config.json `blocks` 없음: 방향 선언 없음** — 모든 간선이 미선언으로 표시된다', '');
  }

  out.push(renderSummaryBand(view), '');
  out.push(heading(2, 'L0 시스템'), '', mermaid(renderL0(view)), '');
  out.push(heading(2, 'L1 도메인'), '', mermaid(renderL1(view)), '');
  out.push(heading(2, '블록'), '', renderBlocksTable(view), '');
  out.push(heading(2, '간선'), '', view.edges.length === 0 ? '경계를 넘는 import 없음' : renderEdgesTable(view), '');
  out.push(heading(2, `미분류 파일 ${view.unclassified.length}개`), '');
  if (view.unclassified.length === 0) out.push('없음 — 모든 파일이 블록 글롭에 맞는다');
  else for (const file of view.unclassified) out.push(`- ${anchorLink({ file })} — 어느 블록 글롭에도 안 맞음`);
  out.push('');
  out.push(heading(2, '필수 검사'), '', ...renderRequiredChecks(view), '');
  out.push(heading(2, '변경 영향 범위'), '', renderImpact(view), '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
