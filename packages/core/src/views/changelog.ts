/**
 * 기술 변경 로그 View 생성기 (이슈 #58, view-changelog.md, 기획안 §6.2 · §14). "무엇이 왜 바뀌었나" — 도구가 diff에서 감지한 설계 변경
 * 이벤트 6종(`changelog/detect.ts`)에 에이전트가 남긴 결정 기록 D-xxxx(`changelog/link.ts`)를 붙이고, 기록이 없거나 이유가 비면
 * **"사유 없음"**이다. 지표는 사유 없는 이벤트 비율 — 낮을수록 좋다.
 *
 * 입력은 전부 파서 · 실행 · 저장소 · git이다 (기획안 §6):
 * - `git:` `base..head` 커밋 · 계약 파일 diff · `package.json` · lockfile 전후. base는 (1) 마지막 changelog View의 생성 커밋 →
 *   (2) 마지막 `CheckRun.commit`(HEAD와 다른 가장 최근 것) → (3) 없으면 **HEAD만**(첫 실행, 5절 "기준 커밋이 없다")
 * - `파서:` 어댑터 `extractDependencies()` · `readSchemas()`를 HEAD와 base(임시 worktree)에서 각각 돌려 전후 비교
 * - `저장소:` `decisions/` 결정 기록 · `approvals/` + `proposals/` 규칙 변경 이력 · `rule-status/`
 * - `실행:` 최근 5회 `CheckRun.metrics` → 추이 (`plumb check`가 지표를 쓰는 것은 #60 이후 — 없으면 빈 배열)
 *
 * 하지 않는 것: 커밋 메시지 · 세션 로그를 입력으로 쓰지 않는다 (에이전트 자기 보고). 결정 기록 본문을 요약하거나 문자열 일치로 연결하지
 * 않는다. 결정 기록은 규범이 아니며 검사 대상도 아니다 — 이 View는 규칙 상태를 바꾸지 못한다.
 */

import type { BlockGraph, SchemaFile, SchemaSet } from '../adapter/types.js';
import {
  type CommitInfo,
  type ContractKind,
  commitTime,
  DETECTORS,
  type DetectInput,
  type DetectorName,
  type DetectorSpec,
  detectChangeEvents,
  git,
  listCommits,
  withBaseWorktree,
} from '../changelog/detect.js';
import { linkDecisions } from '../changelog/link.js';
import { gitHead } from '../checks/run-check.js';
import { listDecisions } from '../decisions/store.js';
import { validateDecision } from '../decisions/validate.js';
import { listAllApprovals } from '../store/approvals.js';
import { StoreNotInitializedError } from '../store/errors.js';
import { ViewStoreError } from '../store/views.js';
import type {
  ChangeEvent,
  ChangeEventKind,
  ChangeEvidence,
  ChangelogView,
  CheckRun,
  CommitGroup,
  Rule,
  RuleId,
  RuleStatus,
  SourceRef,
} from '../types/index.js';
import { makeHeader, source } from './header.js';
import {
  anchorLink,
  codeSpan,
  escapeCell,
  escapeMd,
  heading,
  mdTable,
  shortCommit,
  sourceBar,
  statusIcon,
} from './markdown.js';
import { adapterContextOf, type ViewContext, type ViewGenerator } from './types.js';

/** 감지기 · 연결은 이 View의 재료라 여기서 함께 내보낸다 (dependencies.ts ↔ lockfile.ts와 같은 모양) */
export * from '../changelog/detect.js';
export * from '../changelog/link.js';

/** 추이에 쓰는 최근 검사 수 (view-changelog 3절 "최근 5회 추이") */
export const TREND_RUNS = 5;

const DEFAULT_CONTRACT_PATHS: Record<ContractKind, string> = {
  openapi: 'openapi.yaml',
  prisma: 'prisma/schema.prisma',
  asyncapi: 'asyncapi.yaml',
};

export interface ChangelogViewOptions {
  /** 감지기 교체 (테스트 — 실패 경로). 기본 {@link DETECTORS} */
  detectors?: Readonly<Record<DetectorName, DetectorSpec>>;
}

// ---------------------------------------------------------------------------
// 1. 기준 커밋
// ---------------------------------------------------------------------------

const SHA = /^[0-9a-f]{40}$/;

function commitExists(root: string, commit: string): boolean {
  return git(root, ['cat-file', '-e', `${commit}^{commit}`]) !== null;
}

/**
 * base — (1) 마지막 changelog View의 `header.commit` → (2) HEAD와 다른 가장 최근 `CheckRun.commit` → (3) 없음.
 * 레포에 없는 커밋(다른 클론 · 리베이스)은 건너뛴다.
 */
export async function resolveBase(ctx: ViewContext, head: string): Promise<string | undefined> {
  const candidates: string[] = [];
  try {
    const previous = await ctx.store.views.read('changelog');
    if (previous?.view.header.commit !== undefined) candidates.push(previous.view.header.commit);
  } catch (error) {
    if (!(error instanceof ViewStoreError)) throw error;
    // 반쪽 View(JSON만 · 머리말 불일치)는 기준으로 쓰지 않는다 — 다음 후보로
  }
  const runs = await ctx.store.checks.list();
  for (const run of [...runs].reverse()) {
    if (run.commit !== head) candidates.push(run.commit);
  }
  return candidates.find((c) => SHA.test(c) && commitExists(ctx.root, c));
}

// ---------------------------------------------------------------------------
// 2. 전후 파서 결과 — HEAD는 대상 루트, base는 임시 worktree
// ---------------------------------------------------------------------------

interface Snapshot {
  graph?: BlockGraph;
  schemas?: SchemaSet;
  graphError?: string;
  schemasError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function snapshot(ctx: ViewContext, root: string): Promise<Snapshot> {
  const adapterCtx = { ...adapterContextOf(ctx), root };
  const out: Snapshot = {};
  try {
    out.graph = await ctx.adapter.extractDependencies(adapterCtx);
  } catch (error) {
    out.graphError = errorMessage(error);
  }
  try {
    out.schemas = await ctx.adapter.readSchemas(adapterCtx);
  } catch (error) {
    out.schemasError = errorMessage(error);
  }
  return out;
}

function contractPathsOf(ctx: ViewContext): Record<ContractKind, string> {
  const configured = ctx.config.contracts ?? {};
  const normalize = (p: string) => p.replace(/^\.\//, '');
  return {
    openapi: normalize(configured.openapi ?? DEFAULT_CONTRACT_PATHS.openapi),
    prisma: normalize(configured.prisma ?? DEFAULT_CONTRACT_PATHS.prisma),
    asyncapi: normalize(configured.asyncapi ?? DEFAULT_CONTRACT_PATHS.asyncapi),
  };
}

function majorMinor(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
}

function schemaSources(schemas: SchemaSet | undefined): SourceRef[] {
  if (schemas === undefined) return [];
  const out: SourceRef[] = [];
  for (const file of [schemas.prisma, schemas.openapi, schemas.asyncapi] as SchemaFile<unknown>[]) {
    if (file.status !== 'parsed') continue;
    const version = file.tool.name === 'prisma' ? file.tool.version : majorMinor(file.tool.version);
    out.push(source.parser(file.tool.name, version, file.path));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 저장소 — 규칙 이력 · 결정 기록 · 추이
// ---------------------------------------------------------------------------

async function loadRules(ctx: ViewContext): Promise<Rule[]> {
  try {
    return await ctx.store.rules.list();
  } catch (error) {
    if (error instanceof StoreNotInitializedError) return [];
    throw error;
  }
}

/** 최근 {@link TREND_RUNS}회 검사의 비율 (오래된 것부터). `metrics`가 없는 검사는 건너뛴다 — 0이라고 쓰지 않는다 */
export function trendOf(runs: CheckRun[]): number[] {
  return runs
    .filter((run): run is CheckRun & { metrics: NonNullable<CheckRun['metrics']> } => run.metrics !== undefined)
    .slice(-TREND_RUNS)
    .map((run) => (run.metrics.totalEvents === 0 ? 0 : run.metrics.noReasonEvents / run.metrics.totalEvents));
}

// ---------------------------------------------------------------------------
// 4. generate
// ---------------------------------------------------------------------------

/** 커밋별 묶음 — 최신 커밋 먼저, 커밋 안에서는 이벤트 ID 순. 이벤트가 없는 커밋은 묶음을 만들지 않는다 */
export function groupByCommit(events: ChangeEvent[], commits: CommitInfo[], head: CommitInfo): CommitGroup[] {
  const at = new Map<string, string>(commits.map((c) => [c.commit, c.at]));
  at.set(head.commit, head.at);
  const order = new Map(commits.map((c, i) => [c.commit, i]));
  const byCommit = new Map<string, ChangeEvent[]>();
  for (const event of events) {
    const list = byCommit.get(event.commit) ?? [];
    list.push(event);
    byCommit.set(event.commit, list);
  }
  const rank = (commit: string) => (commit === head.commit ? Number.MAX_SAFE_INTEGER : (order.get(commit) ?? -1));
  return [...byCommit.entries()]
    .sort(([x], [y]) => rank(y) - rank(x))
    .map(([commit, list]) => ({
      commit,
      at: at.get(commit) ?? list[0]?.at ?? head.at,
      session: 'manual',
      events: [...list].sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

export async function generateChangelogView(
  ctx: ViewContext,
  options: ChangelogViewOptions = {},
): Promise<ChangelogView> {
  const now = ctx.now();
  const sources: SourceRef[] = [];

  // 1. 범위
  const head = ctx.commit ?? (await gitHead(ctx.root));
  const gitAvailable = SHA.test(head) && commitExists(ctx.root, head);
  const base = gitAvailable ? await resolveBase(ctx, head) : undefined;
  const headAt = (gitAvailable ? commitTime(ctx.root, head) : null) ?? now.toISOString();
  const commits = base === undefined ? [] : (listCommits(ctx.root, base, head) ?? []);
  if (gitAvailable) {
    sources.push(source.git(head, base === undefined ? 'HEAD' : `${shortCommit(base)}..${shortCommit(head)}`));
  }

  // 2. 전후 파서 결과 — base가 있을 때만. base == head면 전후가 같으니 worktree를 만들지 않는다
  let after: Snapshot = {};
  let before: Snapshot = {};
  let baseAt: string | undefined;
  if (base !== undefined) {
    baseAt = commitTime(ctx.root, base) ?? undefined;
    after = await snapshot(ctx, ctx.root);
    if (base === head) before = after;
    else {
      try {
        before = await withBaseWorktree(ctx.root, base, (baseRoot) => snapshot(ctx, baseRoot));
      } catch (error) {
        before = { graphError: errorMessage(error), schemasError: errorMessage(error) };
      }
    }
    if (after.graph !== undefined) sources.push(source.parser(after.graph.tool.name, after.graph.tool.version));
    sources.push(...schemaSources(after.schemas));
  }

  // 3. 저장소
  const rules = await loadRules(ctx);
  const [approvals, proposals, decisions, statusRecords, runs] = await Promise.all([
    listAllApprovals(ctx.store.paths),
    ctx.store.proposals.list(),
    listDecisions(ctx.store.paths),
    ctx.store.ruleStatus.list(),
    ctx.store.checks.list(),
  ]);
  sources.push(source.store('decisions/'), source.store('approvals/'));
  const trend = trendOf(runs);
  if (trend.length > 0) sources.push(source.execution('plumb check', undefined, 'checks/'));

  // 4. 감지
  const input: DetectInput = {
    root: ctx.root,
    head,
    headAt,
    commits,
    contractPaths: contractPathsOf(ctx),
    rulesHistory: { approvals, proposals, rules },
  };
  if (base !== undefined) input.base = base;
  if (baseAt !== undefined) input.since = baseAt;
  if (before.graph !== undefined) input.graphBefore = before.graph;
  if (after.graph !== undefined) input.graphAfter = after.graph;
  const graphError = after.graphError ?? before.graphError;
  if (graphError !== undefined) input.graphError = graphError;
  if (before.schemas !== undefined) input.schemasBefore = before.schemas;
  if (after.schemas !== undefined) input.schemasAfter = after.schemas;
  const schemasError = after.schemasError ?? before.schemasError;
  if (schemasError !== undefined) input.schemasError = schemasError;
  if (ctx.config.contracts?.models !== undefined) input.modelBlocks = ctx.config.contracts.models;
  const detected = await detectChangeEvents(input, options.detectors ?? DETECTORS);

  // 5. 결정 기록 연결
  const ruleStatus = new Map<RuleId, RuleStatus>(statusRecords.map((r) => [r.ruleId, r.detail.status]));
  const linked = linkDecisions({ events: detected.events, decisions, rules, ruleStatus });

  // 6. 묶음 · 지표
  const groups = groupByCommit(linked.events, commits, { commit: head, at: headAt });
  const total = linked.events.length;
  const metric: ChangelogView['metric'] =
    total === 0 ? 'no-events' : { noReason: linked.events.filter((e) => e.noReason !== null).length, total };

  const range: ChangelogView['range'] = { head, commits: base === undefined ? (gitAvailable ? 1 : 0) : commits.length };
  if (base !== undefined) range.base = base;

  const headerOpts = ctx.commit === undefined ? { now, sources } : { commit: ctx.commit, now, sources };
  return {
    header: makeHeader('changelog', headerOpts),
    range,
    metric,
    trend,
    groups,
    orphanDecisions: linked.orphanDecisions,
    incompleteRecords: linked.incompleteRecords,
    detectorErrors: detected.detectorErrors,
  };
}

// ---------------------------------------------------------------------------
// 5. render — JSON만 보고 그린다
// ---------------------------------------------------------------------------

/** 종류 → 아이콘 + 한국어 라벨 (view-changelog 2.1 와이어프레임의 6종. 도입/제거는 아이콘이 다르다) */
export const KIND_LABEL: Record<ChangeEventKind, string> = {
  'dependency-added': '⊕ 새 의존성 도입',
  'dependency-removed': '⊖ 의존성 제거',
  'block-boundary': '▣ 새 블록 · 경계 변경',
  'cross-block-dependency': '⇄ 블록 경계를 넘는 의존',
  'contract-changed': '≡ 계약 변경',
  'rule-changed': '⚖ 규칙 변경 · 완화 제안',
  'external-system': '⬡ 새 외부 시스템 연결',
};

export const NO_REASON_LABEL: Record<'no-record' | 'empty-reason', string> = {
  'no-record': '기록 없음',
  'empty-reason': '이유 비어 있음',
};

function percent(noReason: number, total: number): string {
  return `${Math.round((noReason / total) * 100)}%`;
}

function rangeLabel(view: ChangelogView): string {
  const head = codeSpan(shortCommit(view.range.head));
  if (view.range.base === undefined) return `기준 없음 · HEAD ${head}만`;
  return `기준 ${codeSpan(shortCommit(view.range.base))} ← ${head} (${view.range.commits} 커밋)`;
}

function manualCount(view: ChangelogView): number {
  return view.groups.flatMap((g) => g.events).filter((e) => e.session === 'manual' || e.session === null).length;
}

function summaryLine(view: ChangelogView): string {
  const parts = [rangeLabel(view)];
  if (view.metric === 'no-events') parts.push('사유 없는 설계 변경 이벤트: 이벤트 없음');
  else {
    const { noReason, total } = view.metric;
    parts.push(`사유 없는 설계 변경 이벤트 ${noReason} / ${total} (${percent(noReason, total)}) — 낮을수록 좋음`);
  }
  parts.push(
    view.trend.length === 0
      ? '추이 없음 (검사 지표 기록 없음)'
      : `추이 (최근 ${view.trend.length}회 검사) ${view.trend.map((r) => `${Math.round(r * 100)}%`).join(' → ')}`,
  );
  parts.push(`불완전 기록 ${view.incompleteRecords}`);
  if (view.metric !== 'no-events') parts.push(`수동(세션 없음) 커밋 이벤트 ${manualCount(view)}`);
  return parts.join(' · ');
}

function evidenceCell(evidence: ChangeEvidence[]): string {
  if (evidence.length === 0) return '(근거 없음)';
  return evidence
    .map((e) => {
      const link = e.anchor !== undefined ? anchorLink(e.anchor) : '';
      const text = link.length > 0 ? link : (e.excerpt ?? '');
      return text.length === 0 ? '' : text;
    })
    .filter((t) => t.length > 0)
    .join(' · ');
}

function decisionCell(event: ChangeEvent): string {
  const links = event.decisionIds.map((id) => `[${id}](#${id.toLowerCase()})`).join(', ');
  if (event.noReason === null) return links;
  const reason = NO_REASON_LABEL[event.noReason];
  return links.length === 0 ? `🔺 **사유 없음** (${reason})` : `${links} · 🔺 **사유 없음** (${reason})`;
}

/** 사람 커밋은 `'manual'`(현재 감지기) 또는 `null`(세션 정보 없음) — 둘 다 "수동" */
function sessionCell(session: ChangeEvent['session']): string {
  return session === 'manual' || session === null ? '수동' : codeSpan(session);
}

function blocksCell(event: ChangeEvent): string {
  if (event.blocks.length === 0) return event.unclassified === true ? '미분류' : '—';
  return event.blocks.map(codeSpan).join(', ');
}

function renderGroup(group: CommitGroup): string[] {
  return [
    heading(2, `${codeSpan(shortCommit(group.commit))} · ${group.at} · ${sessionCell(group.session)}`),
    mdTable(
      ['ID', '종류', '대상', '블록', '근거', '결정 기록', '세션'],
      group.events.map((e) => [
        codeSpan(e.id),
        KIND_LABEL[e.kind],
        escapeCell(e.title),
        blocksCell(e),
        evidenceCell(e.evidence),
        decisionCell(e),
        sessionCell(e.session),
      ]),
    ),
  ];
}

/** 절 본문 첫 줄. 비어 있으면 `(비어 있음)` — 요약하지 않는다, 자른다 */
function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return '(비어 있음)';
  return escapeMd(line.length > 160 ? `${line.slice(0, 157)}…` : line);
}

function ruleCell(rule: ChangeEvent['linkedRules'][number]): string {
  if (!rule.exists) return `${codeSpan(rule.ruleId)} (없는 규칙)`;
  return rule.status === null ? `${codeSpan(rule.ruleId)} ⬜` : `${codeSpan(rule.ruleId)} ${statusIcon(rule.status)}`;
}

/**
 * 연결된 결정 기록 — JSON에 있는 것만 그린다: 어느 이벤트에 붙었나 · 연결 규칙과 상태 점 · 이유가 비었나. 본문 네 절은 저장소
 * `decisions/<id>.md`가 정본이고 `ChangelogView`에 자리가 없다 (`decisions?: DecisionRecord[]`는 생성기 변경이라 M10 후보, #63). 요약해서 대신 쓰지 않는다
 */
function renderDecisions(view: ChangelogView): string[] {
  const out = [heading(2, '결정 기록')];
  const events = view.groups.flatMap((g) => g.events);
  const linkedIds = [...new Set(events.flatMap((e) => e.decisionIds))].sort();
  if (linkedIds.length === 0) {
    out.push('이벤트에 연결된 결정 기록 없음');
    return out;
  }
  for (const id of linkedIds) {
    const mine = events.filter((e) => e.decisionIds.includes(id));
    const rules = new Map<string, ChangeEvent['linkedRules'][number]>();
    for (const event of mine) for (const rule of event.linkedRules) rules.set(rule.ruleId, rule);
    const emptyReason = mine.some((e) => e.noReason === 'empty-reason');
    out.push(
      `<a id="${id.toLowerCase()}"></a>`,
      heading(3, id),
      [
        `저장소: decisions/${id}.md · 3등급(기록)`,
        `이벤트 ${mine.map((e) => codeSpan(e.id)).join(', ')}`,
        rules.size === 0 ? '연결 규칙 없음' : `연결 규칙 ${[...rules.values()].map(ruleCell).join(' · ')}`,
        emptyReason ? '이유: (비어 있음) 🔺' : '이유 있음',
      ].join(' · '),
    );
  }
  out.push(
    'ⓘ 결정 기록은 에이전트가 쓴 텍스트다. 검사 대상이 아니며 검사 결과를 바꾸지 않는다. 전문은 저장소 `decisions/`에서 읽는다.',
  );
  return out;
}

function renderOrphans(view: ChangelogView): string[] {
  const out = [heading(2, '고아 결정 기록')];
  if (view.orphanDecisions.length === 0) {
    out.push('없음');
    return out;
  }
  out.push(
    `이벤트에 연결되지 않은 결정 기록 ${view.orphanDecisions.length}개 — 지표에 들어가지 않는다`,
    mdTable(
      ['ID', '제목', '블록', '시각', '이유', '연결'],
      view.orphanDecisions.map((d) => [
        codeSpan(d.id),
        escapeCell(d.title),
        d.block === undefined ? '—' : codeSpan(d.block),
        d.date,
        validateDecision(d).noReason ? '(비어 있음) 🔺' : firstLine(d.reason),
        [
          ...d.links.rules.map((r) => `규칙 ${codeSpan(r)}`),
          ...d.links.commits.map((c) => `커밋 ${codeSpan(shortCommit(c))}`),
          ...(d.links.packages ?? []).map((p) => `패키지 ${codeSpan(p)}`),
          ...(d.links.services ?? []).map((s) => `서비스 ${codeSpan(s)}`),
        ].join(', ') || '—',
      ]),
    ),
  );
  return out;
}

function renderErrors(view: ChangelogView): string[] {
  if (view.detectorErrors.length === 0) return [];
  return [
    heading(2, '감지 실패'),
    '실패한 종류는 지표의 분모에서 빠진다',
    mdTable(
      ['종류', '오류'],
      view.detectorErrors.map((e) => [KIND_LABEL[e.kind], escapeCell(e.message.split('\n')[0] ?? e.message)]),
    ),
  ];
}

export function renderChangelogView(view: ChangelogView): string {
  const sections: string[] = [
    [heading(1, '기술 변경 로그'), sourceBar(view.header.sources), summaryLine(view)].join('\n\n'),
  ];
  if (view.groups.length === 0) sections.push(`이 범위에 설계 변경 이벤트 없음 (${rangeLabel(view)})`);
  for (const group of view.groups) sections.push(renderGroup(group).join('\n\n'));
  sections.push(renderDecisions(view).join('\n\n'));
  sections.push(renderOrphans(view).join('\n\n'));
  const errors = renderErrors(view);
  if (errors.length > 0) sections.push(errors.join('\n\n'));
  return `${sections.join('\n\n')}\n`;
}

/** `plumb views`(#60)가 순서대로 돌리는 생성기 중 세 번째 */
export const changelogView: ViewGenerator<ChangelogView> = {
  name: 'changelog',
  generate: (ctx) => generateChangelogView(ctx),
  render: renderChangelogView,
};
