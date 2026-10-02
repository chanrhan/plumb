/**
 * 외부 의존성 View 생성기 (이슈 #56, view-dependencies.md). "무엇에 기대고 있나" — 패키지 · 외부 서비스 · 의존 변화.
 *
 * 입력은 넷뿐이고 전부 파서·실행·저장소·git이다 (기획안 §6):
 * - `파서: pnpm-lock` — {@link findLockfile} · {@link parsePnpmLock}. 직접 의존 · 간접 수 · lockfile 줄
 * - `파서: dependency-cruiser` — `ctx.adapter.extractDependencies()`의 블록 그래프. `externals[pkg] = 블록[]`이 "import 블록",
 *   L0 노드가 외부 서비스, `infraEdges`가 클라이언트 패키지 · 쓰는 블록. 그래프가 없으면 `importAnalysis: 'missing'`이고
 *   `unused`는 `null` — 모른다고 쓴다, 0이라고 쓰지 않는다 (view-dependencies 5절)
 * - `저장소: rules.yaml`(`constraint.targets`) · `rule-status/` · `decisions/`(`links.packages`) — 제약 규칙과 결정 기록
 * - `git: package.json · pnpm-lock.yaml` — 최근 30일 커밋의 직접 의존 추가·제거·버전 변경. git이 없으면 `unavailable`
 *
 * 하지 않는 것: 패키지에서 서비스를 역추정하지 않는다 (서비스는 그래프 L0 노드만). 결정 기록 본문의 문자열 일치로 "사유 있음"을
 * 판정하지 않는다 (`links.packages` · `links.commits` 명시 연결만). 환경변수 값은 어디서도 읽지 않는다.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BlockGraph } from '../adapter/types.js';
import { listDecisions } from '../decisions/store.js';
import { StoreNotInitializedError } from '../store/errors.js';
import type {
  DecisionId,
  DependenciesView,
  DependencyEvent,
  Evidence,
  InfraKind,
  PackageEntry,
  Rule,
  RuleId,
  RuleStatus,
  ServiceEntry,
  SourceRef,
} from '../types/index.js';
import { makeHeader, source } from './header.js';
import {
  findLockfile,
  type LockfileLocation,
  LockfileParseError,
  type ParsedPnpmLock,
  PNPM_LOCKFILE,
  parsePnpmLock,
  transitiveCountOf,
  UnsupportedLockfileError,
} from './lockfile.js';
import { anchorLink, codeSpan, escapeCell, heading, mdTable, sourceBar, statusIcon } from './markdown.js';
import { adapterContextOf, type ViewContext, type ViewGenerator } from './types.js';

/** lockfile 파서는 이 View의 재료라 여기서 함께 내보낸다 */
export * from './lockfile.js';

const execFileAsync = promisify(execFile);

/** 이벤트 절 기본 기간 (view-dependencies 4절 "기본 30일"). `ctx`에 옵션이 없어 상수다 — `&since=`는 UI(#60)의 몫 */
export const DEFAULT_EVENTS_SINCE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const INFRA_KINDS: readonly InfraKind[] = ['db', 'cache', 'queue', 'external-api'];
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export interface DependenciesViewOptions {
  /** 이벤트 절 기간 (일). 기본 {@link DEFAULT_EVENTS_SINCE_DAYS} */
  sinceDays?: number;
}

// ---------------------------------------------------------------------------
// 블록 그래프 — 어댑터가 더한 `externals`를 덕 타이핑으로 읽는다 (코어는 어댑터 패키지를 import하지 않는다)
// ---------------------------------------------------------------------------

type ExternalsMap = Record<string, string[]>;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** `BlockGraph.externals: { [pkg]: fromBlocks[] }` (#45, #63에서 공통 형식에 올림). 어댑터가 안 주면 `null` — "분석 없음" */
export function externalsOf(graph: BlockGraph | null): ExternalsMap | null {
  const raw: unknown = graph?.externals;
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: ExternalsMap = {};
  for (const [pkg, blocks] of Object.entries(raw as Record<string, unknown>)) {
    if (isStringArray(blocks)) out[pkg] = [...blocks].sort();
  }
  return out;
}

async function extractGraph(ctx: ViewContext): Promise<BlockGraph | null> {
  try {
    return await ctx.adapter.extractDependencies(adapterContextOf(ctx));
  } catch {
    // 추출 실패(도구 없음 · 미구현)는 "분석 없음"이다. 이전 결과를 대신 쓰지 않는다
    return null;
  }
}

// ---------------------------------------------------------------------------
// 저장소 — 규칙 · 상태 · 결정 기록
// ---------------------------------------------------------------------------

interface RuleIndex {
  rules: Rule[];
  status: Map<RuleId, RuleStatus>;
}

async function loadRules(ctx: ViewContext): Promise<RuleIndex> {
  let rules: Rule[];
  try {
    rules = await ctx.store.rules.list();
  } catch (error) {
    if (error instanceof StoreNotInitializedError) rules = [];
    else throw error;
  }
  const status = new Map<RuleId, RuleStatus>();
  for (const record of await ctx.store.ruleStatus.list()) status.set(record.ruleId, record.detail.status);
  return { rules, status };
}

function ruleRefs(index: RuleIndex, matches: (rule: Rule) => boolean): Array<{ ruleId: RuleId; status: RuleStatus }> {
  return index.rules
    .filter((rule) => (rule.constraint?.targets ?? []).length > 0 && matches(rule))
    .map((rule) => ({ ruleId: rule.id, status: index.status.get(rule.id) ?? 'unchecked' }));
}

function rulesForPackage(index: RuleIndex, name: string) {
  return ruleRefs(index, (rule) =>
    (rule.constraint?.targets ?? []).some((t) => t.kind === 'package' && t.name === name),
  );
}

function rulesForService(index: RuleIndex, kind: InfraKind, names: string[]) {
  return ruleRefs(index, (rule) =>
    (rule.constraint?.targets ?? []).some(
      (t) => t.kind === 'service' && t.type === kind && (t.name === undefined || names.includes(t.name)),
    ),
  );
}

// ---------------------------------------------------------------------------
// 패키지
// ---------------------------------------------------------------------------

function toLockfileAnchor(lockPath: string, line: number): PackageEntry['lockfile'] {
  return line > 0 ? { file: lockPath, line } : { file: lockPath };
}

function packageEntries(
  lock: ParsedPnpmLock,
  lockPath: string,
  externals: ExternalsMap | null,
  rules: RuleIndex,
): PackageEntry[] {
  const entries: PackageEntry[] = [];
  for (const [name, direct] of Object.entries(lock.direct)) {
    const importedBy = externals?.[name] ?? [];
    const entry: PackageEntry = {
      name,
      version: direct.version,
      specifier: direct.specifier,
      direct: true,
      scope: direct.scope,
      importedBy,
      importSites: [],
      lockfile: toLockfileAnchor(lockPath, direct.line),
      unused: externals === null ? null : direct.scope === 'prod' && importedBy.length === 0,
      transitive: transitiveCountOf(direct.snapshotKey, lock.packages),
      rules: rulesForPackage(rules, name),
    };
    entries.push(entry);
  }
  for (const key of lock.transitive) {
    const snapshot = lock.packages[key];
    if (snapshot === undefined) continue;
    entries.push({
      name: snapshot.name,
      version: snapshot.version,
      direct: false,
      scope: 'prod',
      importedBy: externals?.[snapshot.name] ?? [],
      importSites: [],
      lockfile: toLockfileAnchor(lockPath, snapshot.line),
      unused: false,
      rules: rulesForPackage(rules, snapshot.name),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 외부 서비스 — 그래프 L0 노드만 (추정 금지)
// ---------------------------------------------------------------------------

function isInfraKind(kind: string): kind is InfraKind {
  return (INFRA_KINDS as readonly string[]).includes(kind);
}

/** compose의 `services.<name>:` 줄. 그래프 L0 노드에 근거가 없을 때만 보조로 쓴다 */
export function composeServiceLine(text: string, name: string): number | undefined {
  const lines = text.split(/\r?\n/);
  let inServices = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services\s*:/.test(line);
      continue;
    }
    if (
      inServices &&
      indent === 2 &&
      new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(line)
    )
      return i + 1;
  }
  return undefined;
}

function serviceEntries(
  graph: BlockGraph | null,
  compose: { path: string; text: string } | null,
  rules: RuleIndex,
): { services: ServiceEntry[]; undetectedInfra: InfraKind[] } {
  if (graph === null) return { services: [], undetectedInfra: [...INFRA_KINDS] };
  const services: ServiceEntry[] = [];
  for (const node of graph.blocks) {
    if (node.level !== 'L0' || !isInfraKind(node.kind)) continue;
    const edges = graph.infraEdges.filter((edge) => edge.to === node.id);
    const clientPackages = [
      ...new Set(edges.flatMap((edge) => (edge.via.kind === 'package' ? [edge.via.name] : []))),
    ].sort();
    const usedBy = [...new Set(edges.flatMap((edge) => (edge.blocks.length > 0 ? edge.blocks : [edge.from])))].sort();
    let evidence: Evidence[] = node.evidence ?? [];
    if (evidence.length === 0 && compose !== null) {
      const line = composeServiceLine(compose.text, node.id);
      if (line !== undefined)
        evidence = [{ anchor: { file: compose.path, line }, excerpt: `${node.id}:`, source: 'parser' }];
    }
    const entry: ServiceEntry = {
      kind: node.kind,
      evidence,
      clientPackages,
      usedBy,
      rules: rulesForService(rules, node.kind, [node.id, ...(node.label !== undefined ? [node.label] : [])]),
    };
    if (node.label !== undefined) entry.name = node.label;
    services.push(entry);
  }
  const detected = new Set(services.map((s) => s.kind));
  const undetectedInfra = INFRA_KINDS.filter((kind) => !detected.has(kind));
  return { services, undetectedInfra };
}

// ---------------------------------------------------------------------------
// git — 의존 변경 이벤트
// ---------------------------------------------------------------------------

/** `git -C cwd <args>`. 실패(git 없음 · 레포 아님 · 경로 없음)는 `null` */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

type DepMap = Record<string, string>;

/** `package.json` 본문 → `dependencies` + `devDependencies` (이름 → specifier). 깨진 JSON은 빈 맵 */
function directSpecifiers(text: string | null): DepMap {
  if (text === null) return {};
  try {
    const json = JSON.parse(text) as { dependencies?: unknown; devDependencies?: unknown };
    const out: DepMap = {};
    for (const field of [json.dependencies, json.devDependencies]) {
      if (field === undefined || field === null || typeof field !== 'object') continue;
      for (const [name, spec] of Object.entries(field as Record<string, unknown>)) {
        if (typeof spec === 'string') out[name] = spec;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function tryParseLock(text: string | null, importerKey: string): ParsedPnpmLock | null {
  if (text === null) return null;
  try {
    return parsePnpmLock(text, importerKey);
  } catch {
    return null;
  }
}

interface GitLayout {
  /** 레포 최상위 (절대) */
  top: string;
  /** `ctx.root/package.json`의 레포 기준 경로 */
  packageJson: string;
  /** lockfile의 레포 기준 경로. lockfile이 없으면 없음 */
  lockfile?: string;
  importerKey: string;
}

async function gitLayout(root: string, lockfile: LockfileLocation): Promise<GitLayout | null> {
  const topRaw = await git(root, ['rev-parse', '--show-toplevel']);
  if (topRaw === null) return null;
  const top = topRaw.trim();
  const prefixRaw = (await git(root, ['rev-parse', '--show-prefix'])) ?? '';
  const prefix = prefixRaw.trim();
  const layout: GitLayout = {
    top,
    packageJson: `${prefix}package.json`,
    importerKey: lockfile.status === 'found' ? lockfile.importerKey : '.',
  };
  if (lockfile.status === 'found') {
    const rel = relative(top, lockfile.path).split('\\').join('/');
    if (!rel.startsWith('..')) layout.lockfile = rel;
  }
  return layout;
}

/** 두 시점의 직접 의존을 비교해 변경 목록을 만든다. 버전은 lockfile 해석값을 우선하고 없으면 specifier */
export function diffDirect(
  before: { specifiers: DepMap; lock: ParsedPnpmLock | null },
  after: { specifiers: DepMap; lock: ParsedPnpmLock | null },
): DependencyEvent['changes'] {
  const versionOf = (name: string, side: { specifiers: DepMap; lock: ParsedPnpmLock | null }) =>
    side.lock?.direct[name]?.version ?? side.specifiers[name];
  const names = new Set([
    ...Object.keys(before.specifiers),
    ...Object.keys(after.specifiers),
    ...Object.keys(before.lock?.direct ?? {}),
    ...Object.keys(after.lock?.direct ?? {}),
  ]);
  const changes: DependencyEvent['changes'] = [];
  for (const name of [...names].sort()) {
    const from = versionOf(name, before);
    const to = versionOf(name, after);
    if (from === undefined && to === undefined) continue;
    if (from === undefined) changes.push({ name, kind: 'added', to: to as string, direct: true });
    else if (to === undefined) changes.push({ name, kind: 'removed', from, direct: true });
    else if (from !== to) changes.push({ name, kind: 'changed', from, to, direct: true });
  }
  return changes;
}

/** 간접 의존 집합의 대칭 차 크기. lockfile이 한쪽이라도 없으면 0 (모른다 — 세지 않는다) */
export function transitiveDelta(before: ParsedPnpmLock | null, after: ParsedPnpmLock | null): number {
  if (before === null || after === null) return 0;
  const a = new Set(before.transitive);
  const b = new Set(after.transitive);
  let delta = 0;
  for (const key of a) if (!b.has(key)) delta++;
  for (const key of b) if (!a.has(key)) delta++;
  return delta;
}

function decisionFor(
  decisions: Array<{ id: DecisionId; links: { commits: string[]; packages?: string[] } }>,
  commit: string,
  names: string[],
): DecisionId | 'no-record' {
  const hit = decisions.find(
    (d) =>
      (d.links.packages ?? []).some((pkg) => names.includes(pkg)) ||
      d.links.commits.some((c) => c.length >= 7 && commit.startsWith(c)),
  );
  return hit?.id ?? 'no-record';
}

async function collectEvents(
  ctx: ViewContext,
  lockfile: LockfileLocation,
  since: Date,
): Promise<{ events: DependenciesView['events']; head?: string; layout: GitLayout | null }> {
  const layout = await gitLayout(ctx.root, lockfile);
  if (layout === null) return { events: { unavailable: 'no-git' }, layout: null };

  const head = (await git(ctx.root, ['rev-parse', 'HEAD']))?.trim();
  const paths = [layout.packageJson, ...(layout.lockfile !== undefined ? [layout.lockfile] : [])];
  const logRaw = await git(layout.top, [
    'log',
    `--since=${since.toISOString()}`,
    '--format=%H%x09%aI%x09%s',
    '--',
    ...paths,
  ]);
  if (logRaw === null) return { events: { unavailable: 'no-git' }, layout };

  const decisions = await listDecisions(ctx.store.paths);
  const items: DependencyEvent[] = [];
  for (const line of logRaw.split('\n')) {
    if (line.trim().length === 0) continue;
    const [commit, at] = line.split('\t');
    if (commit === undefined || at === undefined) continue;
    const show = (rev: string, path: string) => git(layout.top, ['show', `${rev}:${path}`]);
    const [pkgAfter, pkgBefore] = await Promise.all([
      show(commit, layout.packageJson),
      show(`${commit}^`, layout.packageJson),
    ]);
    const [lockAfter, lockBefore] =
      layout.lockfile === undefined
        ? [null, null]
        : await Promise.all([show(commit, layout.lockfile), show(`${commit}^`, layout.lockfile)]);
    const before = { specifiers: directSpecifiers(pkgBefore), lock: tryParseLock(lockBefore, layout.importerKey) };
    const after = { specifiers: directSpecifiers(pkgAfter), lock: tryParseLock(lockAfter, layout.importerKey) };
    const changes = diffDirect(before, after);
    const transitiveChanges = transitiveDelta(before.lock, after.lock);
    // 이 importer와 무관한 lockfile 변경(다른 워크스페이스 패키지)은 이벤트가 아니다
    if (changes.length === 0 && transitiveChanges === 0) continue;
    items.push({
      commit,
      at,
      changes,
      transitiveChanges,
      decision: decisionFor(
        decisions,
        commit,
        changes.map((c) => c.name),
      ),
    });
  }
  const result: { events: DependenciesView['events']; head?: string; layout: GitLayout | null } = {
    events: { since: since.toISOString(), items },
    layout,
  };
  if (head !== undefined && head.length > 0) result.head = head;
  return result;
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function readCompose(root: string): Promise<{ path: string; text: string } | null> {
  for (const name of COMPOSE_FILES) {
    try {
      return { path: name, text: await readFile(resolve(root, name), 'utf8') };
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/** `ctx.root` 기준 상대 경로 (posix). 모노레포 lockfile은 `../../pnpm-lock.yaml`처럼 위를 가리킨다 */
function displayPath(root: string, abs: string): string {
  const rel = relative(root, abs).split('\\').join('/');
  return rel.length === 0 ? PNPM_LOCKFILE : rel;
}

export async function generateDependenciesView(
  ctx: ViewContext,
  options: DependenciesViewOptions = {},
): Promise<DependenciesView> {
  const now = ctx.now();
  const sinceDays = options.sinceDays ?? DEFAULT_EVENTS_SINCE_DAYS;
  const since = new Date(now.getTime() - sinceDays * DAY_MS);
  const sources: SourceRef[] = [];

  // 1. lockfile
  const location = await findLockfile(ctx.root);
  let lockfile: DependenciesView['lockfile'];
  let lock: ParsedPnpmLock | null = null;
  let lockPath = PNPM_LOCKFILE;
  if (location.status === 'missing') {
    lockfile = { missing: true };
  } else if (location.status === 'unsupported') {
    lockPath = displayPath(ctx.root, location.path);
    lockfile = { path: lockPath, unsupported: location.format };
    sources.push(source.parser(location.format === 'npm' ? 'package-lock' : 'yarn.lock', undefined, lockPath));
  } else {
    lockPath = displayPath(ctx.root, location.path);
    try {
      lock = parsePnpmLock(await readFile(location.path, 'utf8'), location.importerKey, location.path);
      lockfile = { path: lockPath, format: 'pnpm', version: lock.version };
      sources.push(
        source.parser(
          'pnpm-lock',
          lock.version,
          location.importerKey === '.' ? lockPath : `${lockPath} importers['${location.importerKey}']`,
        ),
      );
    } catch (error) {
      if (error instanceof UnsupportedLockfileError) lockfile = { path: lockPath, unsupported: error.format };
      else if (error instanceof LockfileParseError) lockfile = { path: lockPath, unsupported: error.message };
      else throw error;
    }
  }

  // 2. 블록 그래프 (import 분석 · L0)
  const graph = await extractGraph(ctx);
  const externals = externalsOf(graph);
  const importAnalysis: DependenciesView['importAnalysis'] = externals === null ? 'missing' : 'available';
  if (graph !== null) sources.push(source.parser(graph.tool.name, graph.tool.version));
  const compose = await readCompose(ctx.root);
  if (compose !== null) sources.push(source.parser('docker-compose', undefined, compose.path));

  // 3. 저장소
  const rules = await loadRules(ctx);
  if (rules.rules.length > 0) sources.push(source.store('rules.yaml'));
  sources.push(source.store('decisions/'));

  // 4. 패키지 · 서비스
  const packages = lock === null ? [] : packageEntries(lock, lockPath, externals, rules);
  const { services, undetectedInfra } = serviceEntries(graph, compose, rules);

  // 5. git 이벤트
  const { events, head } = await collectEvents(ctx, location, since);
  const gitCommit = ctx.commit ?? head;
  if (!('unavailable' in events) && gitCommit !== undefined) {
    sources.push(source.git(gitCommit, `package.json ${lockPath} --since=${sinceDays}d`));
  }

  // 6. 요약
  const direct = packages.filter((p) => p.direct);
  const items = 'unavailable' in events ? [] : events.items;
  const summary: DependenciesView['summary'] = {
    direct: {
      total: direct.length,
      prod: direct.filter((p) => p.scope === 'prod').length,
      dev: direct.filter((p) => p.scope === 'dev').length,
    },
    transitive: lock?.transitive.length ?? 0,
    unusedDirect: importAnalysis === 'available' ? direct.filter((p) => p.unused === true).length : null,
    services: services.length,
    recentEvents: items.length,
    recentNoReason: items.filter((e) => e.decision === 'no-record').length,
  };

  const headerOpts = ctx.commit === undefined ? { now, sources } : { commit: ctx.commit, now, sources };
  return {
    header: makeHeader('dependencies', headerOpts),
    lockfile,
    importAnalysis,
    packages,
    services,
    undetectedInfra,
    events,
    summary,
  };
}

// ---------------------------------------------------------------------------
// render — JSON만 보고 그린다
// ---------------------------------------------------------------------------

const INFRA_LABEL: Record<InfraKind, string> = {
  db: 'DB',
  cache: '캐시',
  queue: '큐',
  'external-api': '외부 API',
};

function rulesCell(rules: Array<{ ruleId: RuleId; status: RuleStatus }>): string {
  if (rules.length === 0) return '—';
  return rules.map((r) => `${codeSpan(r.ruleId)} ${statusIcon(r.status)}`).join(', ');
}

function blocksCell(view: DependenciesView, entry: PackageEntry): string {
  if (view.importAnalysis === 'missing') return '분석 없음';
  return entry.importedBy.length === 0 ? '(import 없음)' : entry.importedBy.map(codeSpan).join(', ');
}

function unusedCell(entry: PackageEntry): string {
  if (entry.unused === null) return '▲ ?';
  return entry.unused ? '▲ 사용 안 함' : '';
}

function summaryLine(view: DependenciesView): string {
  const s = view.summary;
  const parts = [
    `직접 ${s.direct.total} (prod ${s.direct.prod} · dev ${s.direct.dev})`,
    `간접 ${s.transitive}`,
    s.unusedDirect === null ? 'import 없는 직접 ▲ ? (분석 없음)' : `import 없는 직접 ${s.unusedDirect} ▲`,
    `서비스 ${s.services}`,
  ];
  for (const kind of view.undetectedInfra) parts.push(`${INFRA_LABEL[kind]} 없음`);
  if ('unavailable' in view.events) parts.push('이벤트: git 이력 없음');
  else parts.push(`최근 ${sinceDaysOf(view)}일 이벤트 ${s.recentEvents} (사유 없음 ${s.recentNoReason})`);
  return parts.join(' · ');
}

/** `events.since`와 `generatedAt`의 차이 (일). 반올림 */
export function sinceDaysOf(view: DependenciesView): number {
  if ('unavailable' in view.events) return DEFAULT_EVENTS_SINCE_DAYS;
  const ms = new Date(view.header.generatedAt).getTime() - new Date(view.events.since).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / DAY_MS)) : DEFAULT_EVENTS_SINCE_DAYS;
}

function lockfileNotice(view: DependenciesView): string | null {
  if ('missing' in view.lockfile)
    return `lockfile 없음 (${codeSpan(PNPM_LOCKFILE)}). package.json만으로 버전을 추정하지 않는다`;
  if ('unsupported' in view.lockfile)
    return `지원하지 않는 lockfile: ${view.lockfile.unsupported} (${codeSpan(view.lockfile.path)})`;
  return null;
}

function renderPackages(view: DependenciesView): string[] {
  const out = [heading(2, '직접 의존')];
  const notice = lockfileNotice(view);
  if (notice !== null) {
    out.push(notice);
    return out;
  }
  const direct = view.packages.filter((p) => p.direct);
  out.push(
    mdTable(
      ['패키지', '버전', '범위', 'import 블록', '사용 안 함', '규칙'],
      direct.map((p) => [
        anchorLink(p.lockfile, p.name),
        p.version,
        p.scope,
        blocksCell(view, p),
        unusedCell(p),
        rulesCell(p.rules),
      ]),
    ),
  );
  out.push(`간접 의존 ${view.summary.transitive}개`);
  return out;
}

function evidenceCell(evidence: Evidence[]): string {
  if (evidence.length === 0) return '(근거 없음)';
  return evidence.map((e) => anchorLink(e.anchor)).join(' · ');
}

function renderServices(view: DependenciesView): string[] {
  const out = [heading(2, '외부 서비스')];
  if (view.services.length > 0) {
    out.push(
      mdTable(
        ['종류', '이름', '근거', '클라이언트 패키지', '쓰는 블록', '규칙'],
        view.services.map((s) => [
          INFRA_LABEL[s.kind],
          s.name ?? '(이름 없음)',
          evidenceCell(s.evidence),
          s.clientPackages.length === 0 ? '—' : s.clientPackages.map(codeSpan).join(', '),
          s.usedBy.length === 0 ? '—' : s.usedBy.map(codeSpan).join(', '),
          rulesCell(s.rules),
        ]),
      ),
    );
  } else {
    out.push('감지된 설정 없음. 패키지에서 서비스를 역추정하지 않는다');
  }
  if (view.undetectedInfra.length > 0) {
    out.push(`감지 안 됨: ${view.undetectedInfra.map((k) => INFRA_LABEL[k]).join(' · ')} — 감지된 설정 없음`);
  }
  return out;
}

function changeLabel(change: DependencyEvent['changes'][number]): string {
  const direct = change.direct ? ' (직접)' : '';
  if (change.kind === 'added') return `+ ${change.name} ${change.to ?? ''}${direct}`.replace(/\s+\(/, ' (');
  if (change.kind === 'removed') return `− ${change.name} ${change.from ?? ''}${direct}`.replace(/\s+\(/, ' (');
  return `${change.name} ${change.from ?? '?'} → ${change.to ?? '?'}${direct}`;
}

function changesCell(event: DependencyEvent): string {
  const parts = event.changes.map(changeLabel);
  if (event.transitiveChanges > 0) parts.push(`간접 ${event.transitiveChanges}`);
  return escapeCell(parts.join(' · '));
}

function renderEvents(view: DependenciesView): string[] {
  const out = [heading(2, `최근 변경 (${sinceDaysOf(view)}일)`)];
  if ('unavailable' in view.events) {
    out.push('git 이력 없음');
    return out;
  }
  if (view.events.items.length === 0) {
    out.push('기간 안의 의존 변경 없음');
    return out;
  }
  out.push(
    mdTable(
      ['커밋', '시각', '변경', '결정 기록'],
      view.events.items.map((e) => [
        codeSpan(e.commit.slice(0, 7)),
        e.at,
        changesCell(e),
        e.decision === 'no-record' ? '**사유 없음** ⚠' : codeSpan(e.decision),
      ]),
    ),
  );
  return out;
}

export function renderDependenciesView(view: DependenciesView): string {
  const sections = [
    [heading(1, '외부 의존성'), sourceBar(view.header.sources), summaryLine(view)].join('\n\n'),
    renderPackages(view).join('\n\n'),
    renderServices(view).join('\n\n'),
    renderEvents(view).join('\n\n'),
  ];
  return `${sections.join('\n\n')}\n`;
}

/** `plumb views`(#60)가 순서대로 돌리는 생성기 중 다섯 번째 */
export const dependenciesView: ViewGenerator<DependenciesView> = {
  name: 'dependencies',
  generate: (ctx) => generateDependenciesView(ctx),
  render: renderDependenciesView,
};
