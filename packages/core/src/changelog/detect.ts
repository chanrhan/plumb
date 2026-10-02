/**
 * 설계 변경 이벤트 감지기 (이슈 #58, view-changelog 1절 · 3절 · 4절, 기획안 §6.2 "무엇이 바뀌었는지는 도구가 diff에서 감지한다").
 *
 * 6종을 종류별 감지기 하나씩이 본다. 전부 git diff + 파서 전후 비교 + 보호 저장소이고, 에이전트의 자기 보고(커밋 메시지 · 세션 로그)는
 * 입력이 아니다.
 *
 * | 감지기 | 종류 | 입력 |
 * |---|---|---|
 * | `dependency` | `dependency-added` · `dependency-removed` | git: 범위 안 커밋마다 `package.json` · lockfile 전후 → `diffDirect`(외부 의존성 View #56과 같은 비교) |
 * | `block` | `block-boundary` | 파서: 블록 그래프 전후 — L1 블록 집합 · `paths` |
 * | `edge` | `cross-block-dependency` | 파서: 블록 그래프 전후 — L1 간선 집합 |
 * | `contract` | `contract-changed` | git: 계약 파일 `diff --name-only base..head` + 파서: 스키마 전후(operation · model · channel 단위, 없으면 파일 단위) |
 * | `rule` | `rule-changed` | 저장소: `approvals/*.jsonl` 승인 기록 + `proposals/`의 완화 · 삭제 · 경계 변경 제안 |
 * | `external` | `external-system` | 파서: 블록 그래프 전후 — L0 인프라 노드 집합 |
 *
 * 전후 그래프 · 스키마는 호출자(`views/changelog.ts`)가 base 커밋을 임시 worktree({@link withBaseWorktree})에 체크아웃해 어댑터를 다시
 * 돌려 얻는다. **base가 없으면(첫 실행, HEAD만) 전후 비교 감지기 다섯은 건너뛰고 `rule`만 돈다** (view-changelog 5절 "기준 커밋이 없다").
 * 감지기 하나가 던져도 나머지는 계속 — 실패는 `detectorErrors`에 종류별로 적는다 (5절 "파서 실패").
 *
 * 이벤트 ID는 `E-` + sha1(종류 · 대상 · 커밋)의 앞 8자리 — 재실행해도 같은 근거면 같은 ID (3절 "근거 해시로 멱등").
 * 저장소에서 감지한 `rule-changed`는 커밋이 없으므로 규칙 ID · 제안 ID만 해시한다.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ApiSchema, BlockGraph, DbSchema, EventSchema, SchemaFile, SchemaSet } from '../adapter/types.js';
import type { ApprovalRecord } from '../store/approvals.js';
import type {
  Anchor,
  BlockNode,
  ChangeEvent,
  ChangeEventId,
  ChangeEventKind,
  ChangeEvidence,
  InfraKind,
  Proposal,
  ProposalChangeKind,
  Rule,
  RuleId,
} from '../types/index.js';
import { parseHunks } from '../views/contract.js';
import { diffDirect, externalsOf } from '../views/dependencies.js';
import { findLockfile, type ParsedPnpmLock, PNPM_LOCKFILE, parsePnpmLock } from '../views/lockfile.js';

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 결정 기록 연결(`link.ts`)이 쓰는 식별자. 이벤트 JSON에는 남지 않는다 */
export interface MatchKeys {
  /** `links.packages`와 맞출 패키지 이름 */
  packages?: string[];
  /** `links.services`와 맞출 외부 시스템 ID · 표시 이름 */
  services?: string[];
  /** `links.rules`와 맞출 규칙 ID */
  rules?: RuleId[];
}

/** 감지기 출력. 결정 기록 연결 전이라 `decisionIds` · `noReason` · `linkedRules`가 없다 — `link.ts`가 채워 {@link ChangeEvent}가 된다 */
export type DetectedEvent = Omit<ChangeEvent, 'decisionIds' | 'noReason' | 'linkedRules'> & { keys: MatchKeys };

export interface CommitInfo {
  commit: string;
  /** 작성 시각 (ISO 8601, `%aI`) */
  at: string;
}

/** 저장소: 규칙 변경 이력 (`rule` 감지기의 입력). 읽기만 한다 */
export interface RulesHistory {
  approvals: ApprovalRecord[];
  proposals: Proposal[];
  rules: Rule[];
}

export type ContractKind = 'openapi' | 'prisma' | 'asyncapi';

export interface DetectInput {
  /** 대상 레포 루트 (절대) */
  root: string;
  /** 기준 커밋. 없으면 HEAD만 — 전후 비교 감지기는 건너뛴다 */
  base?: string;
  head: string;
  /** head 커밋 시각. 저장소 이벤트가 묶이는 커밋의 시각 */
  headAt: string;
  /** `base..head` (오래된 것부터). base 없으면 빈 배열 */
  commits: CommitInfo[];
  graphBefore?: BlockGraph;
  graphAfter?: BlockGraph;
  /** 어댑터 `extractDependencies()` 실패 메시지. 그래프 감지기 셋이 이 메시지로 실패한다 */
  graphError?: string;
  schemasBefore?: SchemaSet;
  schemasAfter?: SchemaSet;
  /** 어댑터 `readSchemas()` 실패 메시지. 계약 감지기는 파일 diff만으로 계속한다 */
  schemasError?: string;
  /** 계약 파일 경로 (루트 기준). `config.contracts` 또는 기본값 */
  contractPaths: Record<ContractKind, string>;
  /** 모델 → 소유 블록 (`config.contracts.models`) */
  modelBlocks?: Record<string, string>;
  rulesHistory: RulesHistory;
  /** 저장소 이벤트의 시각 하한 (배타). base 커밋 시각. 없으면 전부 */
  since?: string;
}

export type DetectorName = 'dependency' | 'block' | 'edge' | 'contract' | 'rule' | 'external';

export interface DetectorSpec {
  name: DetectorName;
  /** 이 감지기가 내는 종류. 실패하면 이 종류들이 `detectorErrors`에 적힌다 */
  kinds: ChangeEventKind[];
  /** 전후 비교 — base가 없으면 건너뛴다 */
  needsBase: boolean;
  run(input: DetectInput): Promise<DetectedEvent[]> | DetectedEvent[];
}

export interface DetectResult {
  /** 커밋 순(오래된 것부터) · 커밋 안에서는 ID 순 */
  events: DetectedEvent[];
  detectorErrors: Array<{ kind: ChangeEventKind; message: string }>;
  /** base가 없어 건너뛴 종류 */
  skipped: ChangeEventKind[];
}

const INFRA_KINDS: readonly InfraKind[] = ['db', 'cache', 'queue', 'external-api'];

// ---------------------------------------------------------------------------
// git — `architecture.ts`와 같은 spawnSync 호출. 실패는 null
// ---------------------------------------------------------------------------

/** `git <args>` (`cwd`). git 없음 · 레포 아님 · 비정상 종료는 `null` */
export function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

function gitOrThrow(cwd: string, args: string[], what: string): string {
  const out = git(cwd, args);
  if (out === null) throw new Error(`git ${what} 실패 (${args.slice(0, 2).join(' ')})`);
  return out;
}

/** 레포 최상위 기준 `root`의 접두어 (`examples/testbed/` 또는 ``) */
function gitPrefix(root: string): string {
  return gitOrThrow(root, ['rev-parse', '--show-prefix'], 'rev-parse').trim();
}

/** `base..head` 커밋 목록 (오래된 것부터). 레포가 아니면 `null` */
export function listCommits(root: string, base: string, head: string): CommitInfo[] | null {
  const out = git(root, ['log', '--reverse', '--format=%H%x09%aI', `${base}..${head}`]);
  if (out === null) return null;
  return parseCommitLines(out);
}

function parseCommitLines(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const line of out.split('\n')) {
    const [commit, at] = line.split('\t');
    if (commit !== undefined && commit.length > 0 && at !== undefined) commits.push({ commit, at });
  }
  return commits;
}

/** 커밋 하나의 작성 시각. 없으면 `null` */
export function commitTime(root: string, commit: string): string | null {
  const out = git(root, ['show', '-s', '--format=%aI', commit]);
  return out === null || out.trim().length === 0 ? null : out.trim();
}

/** `base..head` 안에서 `paths`를 마지막으로 건드린 커밋. 없으면 `null` */
function lastCommitTouching(input: DetectInput, paths: string[]): CommitInfo | null {
  const unique = [...new Set(paths.filter((p) => p.length > 0))];
  if (input.base === undefined || unique.length === 0) return null;
  const out = git(input.root, ['log', '-1', '--format=%H%x09%aI', `${input.base}..${input.head}`, '--', ...unique]);
  if (out === null) return null;
  return parseCommitLines(out)[0] ?? null;
}

/** 이벤트가 묶일 커밋 — 근거 파일을 마지막으로 건드린 커밋, 못 찾으면 head */
function attribute(input: DetectInput, paths: string[]): CommitInfo {
  return lastCommitTouching(input, paths) ?? { commit: input.head, at: input.headAt };
}

// ---------------------------------------------------------------------------
// 이벤트 ID · 보조
// ---------------------------------------------------------------------------

/** `E-` + sha1(종류 · 대상 · 커밋) 앞 8자리. `evidenceHash`는 전체 해시 */
export function eventId(kind: ChangeEventKind, target: string, commit?: string): { id: ChangeEventId; hash: string } {
  const hash = createHash('sha1')
    .update(`${kind}\n${target}\n${commit ?? ''}`)
    .digest('hex');
  return { id: `E-${hash.slice(0, 8)}`, hash };
}

interface EventSeed {
  kind: ChangeEventKind;
  target: string;
  title: string;
  blocks: string[];
  unclassified?: boolean;
  commit: CommitInfo;
  /** 저장소 이벤트처럼 커밋을 해시에 넣지 않을 때 */
  hashWithoutCommit?: boolean;
  at?: string;
  evidence: ChangeEvidence[];
  keys?: MatchKeys;
  violation?: boolean;
}

function makeEvent(seed: EventSeed): DetectedEvent {
  const { id, hash } = eventId(seed.kind, seed.target, seed.hashWithoutCommit ? undefined : seed.commit.commit);
  const event: DetectedEvent = {
    id,
    kind: seed.kind,
    title: seed.title,
    blocks: [...new Set(seed.blocks)].sort(),
    commit: seed.commit.commit,
    session: 'manual',
    at: seed.at ?? seed.commit.at,
    evidence: seed.evidence,
    evidenceHash: hash,
    keys: seed.keys ?? {},
  };
  if (seed.unclassified === true) event.unclassified = true;
  if (seed.violation !== undefined) event.violation = seed.violation;
  return event;
}

function evidence(source: ChangeEvidence['source'], fields: Omit<ChangeEvidence, 'source'>): ChangeEvidence {
  const out: ChangeEvidence = { source };
  if (fields.anchor !== undefined) out.anchor = fields.anchor;
  if (fields.before !== undefined) out.before = fields.before;
  if (fields.after !== undefined) out.after = fields.after;
  if (fields.excerpt !== undefined) out.excerpt = fields.excerpt;
  return out;
}

/** 글롭 `src/domains/payment/**`의 글롭 문자 앞 디렉토리 → `src/domains/payment` */
export function dirOfGlob(glob: string): string {
  const dir = glob.split(/[*?[{(]/, 1)[0] ?? '';
  return dir.replace(/\/+$/, '');
}

function l1Nodes(graph: BlockGraph): Map<string, BlockNode> {
  return new Map(graph.blocks.filter((b) => b.level === 'L1').map((b) => [b.id, b]));
}

function infraNodes(graph: BlockGraph): Map<string, BlockNode> {
  return new Map(
    graph.blocks
      .filter((b) => b.level === 'L0' && (INFRA_KINDS as readonly string[]).includes(b.kind))
      .map((b) => [b.id, b]),
  );
}

function requireGraphs(input: DetectInput): { before: BlockGraph; after: BlockGraph } {
  if (input.graphBefore === undefined || input.graphAfter === undefined) {
    throw new Error(input.graphError ?? '블록 그래프 전후 비교 불가 — 어댑터 extractDependencies 결과 없음');
  }
  return { before: input.graphBefore, after: input.graphAfter };
}

/** 텍스트에서 `needle`이 처음 나오는 줄 (1부터). 없으면 `undefined` */
function lineOf(text: string | null, needle: string): number | undefined {
  if (text === null) return undefined;
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? undefined : index + 1;
}

function anchor(file: string, line?: number): Anchor {
  return line === undefined ? { file } : { file, line };
}

// ---------------------------------------------------------------------------
// (1) 의존성 도입 · 제거 — git: package.json · lockfile 전후 (외부 의존성 View #56의 diffDirect 재사용)
// ---------------------------------------------------------------------------

type DepMap = Record<string, string>;

/** `package.json` 본문 → `dependencies` + `devDependencies`. 깨진 JSON은 빈 맵 (dependencies.ts `directSpecifiers`와 같다 — export 후보) */
export function directSpecifiers(text: string | null): DepMap {
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

async function detectDependencies(input: DetectInput): Promise<DetectedEvent[]> {
  if (input.base === undefined) return [];
  const prefix = gitPrefix(input.root);
  const top = gitOrThrow(input.root, ['rev-parse', '--show-toplevel'], 'rev-parse').trim();
  const lockfile = await findLockfile(input.root);
  const importerKey = lockfile.status === 'found' ? lockfile.importerKey : '.';
  // 루트 기준(`git log --`용)과 최상위 기준(`git show rev:path`용) 경로
  const lockRel = lockfile.status === 'found' ? relative(input.root, lockfile.path).split('\\').join('/') : undefined;
  const lockTop = lockfile.status === 'found' ? relative(top, lockfile.path).split('\\').join('/') : undefined;
  const lockDisplay = lockRel === undefined || lockRel.length === 0 ? PNPM_LOCKFILE : lockRel;

  const pathspecs = ['package.json', ...(lockRel !== undefined ? [lockRel] : [])];
  const log = gitOrThrow(
    input.root,
    ['log', '--reverse', '--format=%H%x09%aI', `${input.base}..${input.head}`, '--', ...pathspecs],
    'log',
  );
  const externals = externalsOf(input.graphAfter ?? null);
  const events: DetectedEvent[] = [];
  for (const commit of parseCommitLines(log)) {
    const show = (rev: string, path: string) => git(input.root, ['show', `${rev}:${path}`]);
    const pkgAfter = show(commit.commit, `${prefix}package.json`);
    const pkgBefore = show(`${commit.commit}^`, `${prefix}package.json`);
    const lockAfter = lockTop === undefined ? null : show(commit.commit, lockTop);
    const lockBefore = lockTop === undefined ? null : show(`${commit.commit}^`, lockTop);
    const before = { specifiers: directSpecifiers(pkgBefore), lock: tryParseLock(lockBefore, importerKey) };
    const after = { specifiers: directSpecifiers(pkgAfter), lock: tryParseLock(lockAfter, importerKey) };
    for (const change of diffDirect(before, after)) {
      if (change.kind === 'changed') continue; // 버전 변경은 설계 변경 이벤트가 아니다 (의존성 View의 이벤트 절이 보여준다)
      const added = change.kind === 'added';
      const version = added ? change.to : change.from;
      const side = added ? after : before;
      const pkgText = added ? pkgAfter : pkgBefore;
      const rows: ChangeEvidence[] = [
        evidence('git', {
          anchor: anchor('package.json', lineOf(pkgText, `"${change.name}"`)),
          excerpt: `${added ? '+' : '−'} "${change.name}": "${side.specifiers[change.name] ?? version ?? ''}"`,
          ...(added ? { after: version } : { before: version }),
        }),
      ];
      const lockEntry = side.lock?.direct[change.name];
      if (lockEntry !== undefined) {
        rows.push(
          evidence('parser', {
            anchor: anchor(lockDisplay, lockEntry.line > 0 ? lockEntry.line : undefined),
            excerpt: `${change.name}@${lockEntry.version}`,
          }),
        );
      }
      events.push(
        makeEvent({
          kind: added ? 'dependency-added' : 'dependency-removed',
          target: change.name,
          title: version === undefined ? change.name : `${change.name}@${version}`,
          blocks: externals?.[change.name] ?? [],
          commit,
          evidence: rows,
          keys: { packages: [change.name] },
        }),
      );
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// (2) 새 블록 · 블록 경계 변경 — 파서: 블록 그래프 전후
// ---------------------------------------------------------------------------

function blockPaths(node: BlockNode): string[] {
  return node.paths.map(dirOfGlob).filter((p) => p.length > 0);
}

function detectBlocks(input: DetectInput): DetectedEvent[] {
  if (input.base === undefined) return [];
  const { before, after } = requireGraphs(input);
  const b = l1Nodes(before);
  const a = l1Nodes(after);
  const events: DetectedEvent[] = [];
  for (const [id, node] of a) {
    const prev = b.get(id);
    const file = node.public[0] ?? blockPaths(node)[0] ?? '';
    if (prev === undefined) {
      events.push(
        makeEvent({
          kind: 'block-boundary',
          target: `added:${id}`,
          title: `새 블록 ${id}`,
          blocks: [id],
          commit: attribute(input, [...blockPaths(node), 'plumb.config.json']),
          evidence: [
            evidence('parser', { anchor: anchor(file), after: node.paths.join(', '), excerpt: `블록 집합 +${id}` }),
          ],
        }),
      );
      continue;
    }
    const pathsBefore = [...prev.paths].sort().join(', ');
    const pathsAfter = [...node.paths].sort().join(', ');
    if (pathsBefore !== pathsAfter) {
      events.push(
        makeEvent({
          kind: 'block-boundary',
          target: `changed:${id}`,
          title: `경계 변경 ${id}`,
          blocks: [id],
          commit: attribute(input, [...blockPaths(prev), ...blockPaths(node), 'plumb.config.json']),
          evidence: [
            evidence('parser', {
              anchor: anchor(file),
              before: pathsBefore,
              after: pathsAfter,
              excerpt: `경계 글롭 변경 ${id}`,
            }),
          ],
        }),
      );
    }
  }
  for (const [id, node] of b) {
    if (a.has(id)) continue;
    events.push(
      makeEvent({
        kind: 'block-boundary',
        target: `removed:${id}`,
        title: `블록 제거 ${id}`,
        blocks: [id],
        commit: attribute(input, [...blockPaths(node), 'plumb.config.json']),
        evidence: [evidence('parser', { before: node.paths.join(', '), excerpt: `블록 집합 −${id}` })],
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// (3) 블록 경계를 넘는 새 의존 관계 — 파서: L1 간선 전후
// ---------------------------------------------------------------------------

function detectEdges(input: DetectInput): DetectedEvent[] {
  if (input.base === undefined) return [];
  const { before, after } = requireGraphs(input);
  const l1 = l1Nodes(after);
  const seen = new Set(before.edges.map((e) => `${e.from}→${e.to}`));
  const events: DetectedEvent[] = [];
  for (const edge of after.edges) {
    const key = `${edge.from}→${edge.to}`;
    if (seen.has(key) || !l1.has(edge.from) || !l1.has(edge.to)) continue;
    const rows: ChangeEvidence[] = edge.imports.slice(0, 3).map((site) =>
      evidence('parser', {
        anchor: anchor(site.file, site.line),
        excerpt: `import ${site.specifier}`,
        after: site.specifier,
      }),
    );
    rows.push(evidence('parser', { before: '0', after: String(edge.count), excerpt: `${key} 간선 신규` }));
    events.push(
      makeEvent({
        kind: 'cross-block-dependency',
        target: key,
        title: `${edge.from} → ${edge.to}`,
        blocks: [edge.from],
        commit: attribute(
          input,
          edge.imports.map((s) => s.file),
        ),
        evidence: rows,
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// (4) 계약 변경 — git: 계약 파일 diff + 파서: 스키마 전후
// ---------------------------------------------------------------------------

function parsedData<T>(file: SchemaFile<T> | undefined): T | undefined {
  return file !== undefined && file.status === 'parsed' ? file.data : undefined;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );
}

interface SemanticChange {
  target: string;
  title: string;
  anchor?: Anchor;
  before?: string;
  after?: string;
  blocks: string[];
}

/** 집합 전후 비교 — 추가 · 제거 · (키 같고 본문 다름) 변경 */
function diffByKey<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  label: (key: string, item: T) => string,
  body: (item: T) => string,
  anchorOf: (item: T) => Anchor | undefined,
  blocksOf: (item: T) => string[],
): SemanticChange[] {
  const out: SemanticChange[] = [];
  for (const [key, item] of after) {
    const prev = before.get(key);
    if (prev === undefined) {
      out.push({
        target: `added:${key}`,
        title: `${label(key, item)} 추가`,
        anchor: anchorOf(item),
        blocks: blocksOf(item),
      });
    } else if (body(prev) !== body(item)) {
      out.push({
        target: `changed:${key}`,
        title: `${label(key, item)} 변경`,
        anchor: anchorOf(item),
        before: body(prev),
        after: body(item),
        blocks: blocksOf(item),
      });
    }
  }
  for (const [key, item] of before) {
    if (!after.has(key))
      out.push({
        target: `removed:${key}`,
        title: `${label(key, item)} 제거`,
        anchor: anchorOf(item),
        blocks: blocksOf(item),
      });
  }
  return out;
}

function fieldSummary(fields: Array<{ name: string; type: string; isRequired: boolean; isList: boolean }>): string {
  return fields.map((f) => `${f.name}:${f.type}${f.isList ? '[]' : ''}${f.isRequired ? '' : '?'}`).join(', ');
}

function responseSummary(op: { request?: unknown; responses: Array<{ code: string; schema?: unknown }> }): string {
  return canonical({ request: op.request ?? null, responses: op.responses });
}

function semanticDiff(
  kind: ContractKind,
  before: SchemaSet,
  after: SchemaSet,
  modelBlocks: Record<string, string>,
): SemanticChange[] | undefined {
  if (kind === 'openapi') {
    const b = parsedData<ApiSchema>(before.openapi);
    const a = parsedData<ApiSchema>(after.openapi);
    if (b === undefined || a === undefined) return undefined;
    const byKey = (s: ApiSchema) => new Map(s.operations.map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]));
    return diffByKey(
      byKey(b),
      byKey(a),
      (key) => key,
      responseSummary,
      (op) => op.anchor,
      (op) => (op.block.fromTags !== undefined ? [op.block.fromTags] : []),
    );
  }
  if (kind === 'prisma') {
    const b = parsedData<DbSchema>(before.prisma);
    const a = parsedData<DbSchema>(after.prisma);
    if (b === undefined || a === undefined) return undefined;
    const byKey = (s: DbSchema) => new Map(s.models.map((m) => [m.name, m]));
    return diffByKey(
      byKey(b),
      byKey(a),
      (key) => `모델 ${key}`,
      (m) => fieldSummary(m.fields),
      (m) => m.anchor,
      (m) =>
        modelBlocks[m.name] !== undefined ? [modelBlocks[m.name] as string] : m.block !== undefined ? [m.block] : [],
    );
  }
  const b = parsedData<EventSchema>(before.asyncapi);
  const a = parsedData<EventSchema>(after.asyncapi);
  if (b === undefined || a === undefined) return undefined;
  const byKey = (s: EventSchema) => new Map(s.channels.map((c) => [c.name, c]));
  return diffByKey(
    byKey(b),
    byKey(a),
    (key) => `채널 ${key}`,
    (c) => canonical(c.messages),
    () => undefined,
    () => [],
  );
}

function detectContracts(input: DetectInput): DetectedEvent[] {
  if (input.base === undefined) return [];
  const files = Object.values(input.contractPaths);
  const changed = gitOrThrow(
    input.root,
    ['diff', '--name-only', '--relative', `${input.base}..${input.head}`, '--', ...files],
    'diff --name-only',
  )
    .split('\n')
    .filter((line) => line.length > 0);
  const events: DetectedEvent[] = [];
  for (const file of changed) {
    const kind = (Object.keys(input.contractPaths) as ContractKind[]).find((k) => input.contractPaths[k] === file);
    if (kind === undefined) continue;
    const commit = attribute(input, [file]);
    const hunks = parseHunks(file, git(input.root, ['diff', '--relative', input.base, input.head, '--', file]) ?? '');
    const hunkRows = hunks
      .slice(0, 3)
      .map((h) =>
        evidence('git', { anchor: h.anchor, excerpt: `+${h.added} −${h.removed}${h.excerpt ? ` ${h.excerpt}` : ''}` }),
      );
    const changes =
      input.schemasBefore !== undefined && input.schemasAfter !== undefined
        ? semanticDiff(kind, input.schemasBefore, input.schemasAfter, input.modelBlocks ?? {})
        : undefined;
    if (changes === undefined || changes.length === 0) {
      // 스키마 전후를 못 읽었거나(파싱 실패 · 어댑터 없음) 단위 변경이 없는 텍스트 변경 → 파일 단위
      events.push(
        makeEvent({
          kind: 'contract-changed',
          target: `file:${file}`,
          title: `${file} 변경`,
          blocks: [],
          commit,
          evidence:
            hunkRows.length > 0 ? hunkRows : [evidence('git', { anchor: anchor(file), excerpt: `${file} 변경` })],
        }),
      );
      continue;
    }
    for (const change of changes) {
      events.push(
        makeEvent({
          kind: 'contract-changed',
          target: `${file}:${change.target}`,
          title: change.title,
          blocks: change.blocks,
          commit,
          evidence: [
            evidence('parser', {
              ...(change.anchor !== undefined ? { anchor: change.anchor } : { anchor: anchor(file) }),
              before: change.before,
              after: change.after,
              excerpt: change.title,
            }),
            ...hunkRows,
          ],
        }),
      );
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// (5) 규칙 변경 · 완화 제안 — 저장소: approvals/*.jsonl · proposals/ (유일하게 git이 아니다)
// ---------------------------------------------------------------------------

const CHANGE_KIND_LABEL: Record<ProposalChangeKind, string> = {
  add: '규칙 추가',
  strengthen: '규칙 강화',
  relax: '규칙 완화',
  delete: '규칙 삭제',
  boundary: '경계 변경',
};

/** 기획안 §9.1 — 완화 · 삭제 · 경계 변경은 제안 단계부터 이벤트다 */
const RELAXING_KINDS: ReadonlySet<ProposalChangeKind> = new Set(['relax', 'delete', 'boundary']);

function ruleBlock(history: RulesHistory, ruleId: RuleId, proposal?: Proposal): string[] {
  const block =
    proposal?.after?.block ?? proposal?.before?.block ?? history.rules.find((rule) => rule.id === ruleId)?.block;
  return block === undefined ? [] : [block];
}

function inRange(at: string, since: string | undefined): boolean {
  return since === undefined || at > since;
}

function detectRules(input: DetectInput): DetectedEvent[] {
  const history = input.rulesHistory;
  const head: CommitInfo = { commit: input.head, at: input.headAt };
  const events: DetectedEvent[] = [];
  for (const approval of history.approvals) {
    if (approval.action !== 'approve' || !inRange(approval.at, input.since)) continue;
    const proposal = history.proposals.find((p) => p.ruleId === approval.ruleId && p.id === approval.proposalId);
    const label = proposal === undefined ? '규칙 변경' : CHANGE_KIND_LABEL[proposal.changeKind];
    events.push(
      makeEvent({
        kind: 'rule-changed',
        target: `${approval.ruleId}:${approval.proposalId}:approve`,
        title: `${label} ${approval.ruleId}`,
        blocks: ruleBlock(history, approval.ruleId, proposal),
        commit: head,
        hashWithoutCommit: true,
        at: approval.at,
        evidence: [
          evidence('store', {
            excerpt: `approvals/${approval.ruleId}.jsonl · approve · ${approval.by}`,
            before: proposal?.before?.statement,
            after: proposal?.after?.statement,
          }),
        ],
        keys: { rules: [approval.ruleId] },
      }),
    );
  }
  for (const proposal of history.proposals) {
    if (!RELAXING_KINDS.has(proposal.changeKind) || !inRange(proposal.proposedAt, input.since)) continue;
    if (proposal.applied !== 'provisional' && proposal.applied !== 'pending') continue;
    events.push(
      makeEvent({
        kind: 'rule-changed',
        target: `${proposal.ruleId}:${proposal.id}:proposed`,
        title: `${CHANGE_KIND_LABEL[proposal.changeKind]} 제안 ${proposal.ruleId}`,
        blocks: ruleBlock(history, proposal.ruleId, proposal),
        commit: head,
        hashWithoutCommit: true,
        at: proposal.proposedAt,
        evidence: [
          evidence('store', {
            excerpt: `proposals/${proposal.ruleId}/${proposal.id}.json · ${proposal.changeKind} · ${proposal.proposedBy}${proposal.requiresPriorApproval ? ' · 사전 승인 필요 ⚡' : ''}`,
            before: proposal.before?.statement,
            after: proposal.after?.statement,
          }),
        ],
        keys: { rules: [proposal.ruleId] },
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// (6) 새 외부 시스템 연결 — 파서: L0 인프라 노드 전후
// ---------------------------------------------------------------------------

function detectExternalSystems(input: DetectInput): DetectedEvent[] {
  if (input.base === undefined) return [];
  const { before, after } = requireGraphs(input);
  const b = infraNodes(before);
  const a = infraNodes(after);
  const events: DetectedEvent[] = [];
  const setLabel = (nodes: Map<string, BlockNode>) => `{${[...nodes.keys()].sort().join(', ')}}`;
  for (const [id, node] of a) {
    if (b.has(id)) continue;
    const edges = after.infraEdges.filter((edge) => edge.to === id);
    const blocks = edges.flatMap((edge) => (edge.blocks.length > 0 ? edge.blocks : []));
    const rows: ChangeEvidence[] = (node.evidence ?? []).map((e) =>
      evidence(e.source, { anchor: e.anchor, excerpt: e.excerpt }),
    );
    for (const pkg of [...new Set(edges.flatMap((e) => (e.via.kind === 'package' ? [e.via.name] : [])))].sort()) {
      rows.push(evidence('parser', { excerpt: `클라이언트 패키지 ${pkg}`, after: pkg }));
    }
    rows.push(evidence('parser', { before: setLabel(b), after: setLabel(a), excerpt: `외부 시스템 집합 +${id}` }));
    events.push(
      makeEvent({
        kind: 'external-system',
        target: id,
        title: node.label ?? id,
        blocks,
        commit: attribute(
          input,
          (node.evidence ?? []).flatMap((e) => (e.anchor.file !== undefined ? [e.anchor.file] : [])),
        ),
        evidence: rows,
        keys: { services: node.label === undefined ? [id] : [id, node.label] },
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// 감지기 묶음 · 실행
// ---------------------------------------------------------------------------

/** 감지기 여섯. 테스트는 하나를 바꿔 끼워 실패 경로를 본다 (`detectChangeEvents(input, { ...DETECTORS, contract })`) */
export const DETECTORS: Readonly<Record<DetectorName, DetectorSpec>> = {
  dependency: {
    name: 'dependency',
    kinds: ['dependency-added', 'dependency-removed'],
    needsBase: true,
    run: detectDependencies,
  },
  block: { name: 'block', kinds: ['block-boundary'], needsBase: true, run: detectBlocks },
  edge: { name: 'edge', kinds: ['cross-block-dependency'], needsBase: true, run: detectEdges },
  contract: { name: 'contract', kinds: ['contract-changed'], needsBase: true, run: detectContracts },
  rule: { name: 'rule', kinds: ['rule-changed'], needsBase: false, run: detectRules },
  external: { name: 'external', kinds: ['external-system'], needsBase: true, run: detectExternalSystems },
};

/** 커밋 순(오래된 것부터, `commits` 순서 · 모르는 커밋은 뒤) → 커밋 안에서는 ID 순 */
function sortEvents(events: DetectedEvent[], commits: CommitInfo[]): DetectedEvent[] {
  const order = new Map(commits.map((c, i) => [c.commit, i]));
  const rank = (commit: string) => order.get(commit) ?? Number.MAX_SAFE_INTEGER;
  return [...events].sort((x, y) => rank(x.commit) - rank(y.commit) || x.id.localeCompare(y.id));
}

/**
 * 6종 감지기를 순서대로 돌린다. 하나가 던져도 나머지는 계속하고, 그 감지기의 종류를 `detectorErrors`에 적는다.
 * base가 없으면 `needsBase` 감지기는 건너뛰고 `skipped`에 종류를 적는다.
 */
export async function detectChangeEvents(
  input: DetectInput,
  detectors: Readonly<Record<DetectorName, DetectorSpec>> = DETECTORS,
): Promise<DetectResult> {
  const events: DetectedEvent[] = [];
  const detectorErrors: DetectResult['detectorErrors'] = [];
  const skipped: ChangeEventKind[] = [];
  for (const spec of Object.values(detectors)) {
    if (spec.needsBase && input.base === undefined) {
      skipped.push(...spec.kinds);
      continue;
    }
    try {
      events.push(...(await spec.run(input)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const kind of spec.kinds) detectorErrors.push({ kind, message });
    }
  }
  // 같은 ID가 둘이면(같은 근거를 두 커밋에 귀속) 먼저 것만
  const unique = new Map<ChangeEventId, DetectedEvent>();
  for (const event of events) if (!unique.has(event.id)) unique.set(event.id, event);
  return { events: sortEvents([...unique.values()], input.commits), detectorErrors, skipped };
}

// ---------------------------------------------------------------------------
// base 커밋 임시 worktree — 어댑터를 "이전" 소스에서 다시 돌리기 위해
// ---------------------------------------------------------------------------

/**
 * `git worktree add --detach <tmp> <base>`로 base를 체크아웃하고 `fn(baseRoot)`를 돌린 뒤 `finally`에서 `worktree remove --force`.
 * `baseRoot`는 worktree 안의 대상 루트(모노레포면 `<tmp>/examples/testbed`). 어댑터가 `node_modules/.bin/depcruise` 같은 도구를
 * 찾도록 원본의 `node_modules`를 심볼릭 링크로 걸어 주고(복사하지 않는다), 지우기 전에 링크부터 푼다.
 */
export async function withBaseWorktree<T>(
  root: string,
  base: string,
  fn: (baseRoot: string) => Promise<T>,
): Promise<T> {
  const top = gitOrThrow(root, ['rev-parse', '--show-toplevel'], 'rev-parse').trim();
  const prefix = gitPrefix(root);
  const tmp = await mkdtemp(join(tmpdir(), 'plumb-changelog-base-'));
  const worktree = join(tmp, 'wt');
  const added = spawnSync('git', ['-C', top, 'worktree', 'add', '--detach', worktree, base], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (added.error !== undefined || added.status !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `git worktree add 실패 (${base.slice(0, 7)}): ${(added.stderr ?? '').trim() || added.error?.message}`,
    );
  }
  const links: string[] = [];
  try {
    for (const dir of new Set([top, join(top, prefix)])) {
      const src = join(dir, 'node_modules');
      const dst = join(worktree, relative(top, dir), 'node_modules');
      if (existsSync(src) && !existsSync(dst)) {
        await symlink(src, dst, 'dir');
        links.push(dst);
      }
    }
    return await fn(join(worktree, prefix));
  } finally {
    for (const link of links) await unlink(link).catch(() => undefined);
    spawnSync('git', ['-C', top, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
    await rm(tmp, { recursive: true, force: true });
  }
}
