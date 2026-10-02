/**
 * `/rules` 화면과 규칙 API가 공유하는 읽기 모델 (이슈 #34, work-approve 3절). 값은 전부 코어 저장소에서 온다 — 목 데이터 없음.
 *
 * - 목록 한 행 = `rules.yaml`의 규칙 또는 아직 반영되지 않은 제안(`applied: provisional | pending`)의 `after`.
 *   M3의 추가 제안은 승인 전까지 `rules.yaml`에 없으므로(기획안 §10) 제안만 있는 규칙도 목록에 보인다.
 * - 승인 상태 = 미처리 제안이 있으면 `provisional`, 없으면 승인 기록의 마지막 항목(approve → approved · reject → rejected),
 *   기록도 없으면 `provisional`(손으로 적은 규칙 — 승인 행위가 없었다).
 * - 상태(🟢 등)는 마지막 `plumb check`가 쓴 `rule-status/<id>.json`(`store.ruleStatus`)에서 읽는다 (#47). 기록이 없으면 ⬜ `not-run`.
 *   검사 파일별 결과는 `checks/`의 최신 실행(`store.checks.latest()`)에서. 승인은 상태를 바꾸지 않는다 (§7.3).
 */

import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type Approval,
  type ApprovalState,
  type CheckDetail,
  type CheckRun,
  type DependencyStatus,
  hashProposal,
  loadConfig,
  type ParsedPlumbConfig,
  type Proposal,
  RULE_ID_PATTERN,
  type Rule,
  type RuleDetailResponse,
  type RuleDiffLine,
  type RuleId,
  type RuleKind,
  type RuleListFilter,
  type RuleListItem,
  type RuleListResponse,
  type RuleStatus,
  type RuleStatusDetail,
  type RuleStatusRecord,
  type Store,
} from '@plumb/core';
import { getStore, getTarget } from './store';

// ---------------------------------------------------------------------------
// 설정 (고위험 블록 · 대기열 상한)
// ---------------------------------------------------------------------------

let cachedConfig: { target: string; config: Promise<ParsedPlumbConfig> } | undefined;

/** `plumb.config.json` (기본값 채운 뒤). `blocks.<id>.risk`와 `reviewQueue`를 본다 */
export function getConfig(): Promise<ParsedPlumbConfig> {
  const target = getTarget();
  if (cachedConfig === undefined || cachedConfig.target !== target) {
    const config = loadConfig({ target }).then((loaded) => loaded.config);
    cachedConfig = { target, config };
    config.catch(() => {
      if (cachedConfig?.config === config) cachedConfig = undefined;
    });
  }
  return cachedConfig.config;
}

/** `⚡`: 규칙 `risk: high` 또는 그 블록이 설정에서 고위험 선언 (work-approve 3.1) */
export function isHighRiskRule(rule: Rule, config: Pick<ParsedPlumbConfig, 'blocks'>): boolean {
  return rule.risk === 'high' || (rule.block !== undefined && config.blocks?.[rule.block]?.risk === 'high');
}

export function isRuleId(value: string): value is RuleId {
  return RULE_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 규칙 하나의 승인 축 (규칙 · 미처리 제안 · 승인 기록)
// ---------------------------------------------------------------------------

export interface RuleEntry {
  id: RuleId;
  /** `rules.yaml`의 현재 승인 버전. 제안만 있으면 없음 */
  rule?: Rule;
  /** 미처리 제안 (`provisional` 또는 `pending`). 여럿이면 가장 최근 것 */
  pending?: Proposal;
  approvals: Approval[];
  approval: ApprovalState;
  /** 목록 · 상세가 그리는 규칙 본문 — 현재 버전이 없으면 제안의 `after` */
  shown: Rule | null;
}

function isPending(proposal: Proposal): boolean {
  return proposal.applied === 'provisional' || proposal.applied === 'pending';
}

function approvalStateOf(pending: Proposal | undefined, approvals: Approval[]): ApprovalState {
  if (pending !== undefined) return 'provisional';
  const last = approvals.at(-1);
  if (last?.action === 'approve') return 'approved';
  if (last?.action === 'reject') return 'rejected';
  return 'provisional';
}

async function entryFor(store: Store, id: RuleId, rule: Rule | undefined, proposals: Proposal[]): Promise<RuleEntry> {
  const pending = proposals.filter(isPending).at(-1);
  const approvals = await store.approvals.history(id);
  const shown = rule ?? pending?.after ?? proposals.at(-1)?.after ?? proposals.at(-1)?.before ?? null;
  return { id, rule, pending, approvals, approval: approvalStateOf(pending, approvals), shown };
}

/** 규칙 하나. `rules.yaml`에도 제안에도 없으면 `undefined` (API 404) */
export async function readRuleEntry(store: Store, id: RuleId): Promise<RuleEntry | undefined> {
  const rule = await store.rules.get(id);
  const proposals = await store.proposals.list(id);
  if (rule === undefined && proposals.length === 0) return undefined;
  return entryFor(store, id, rule, proposals);
}

/** 모든 규칙 (`rules.yaml` ∪ 제안이 있는 규칙). ID 순 */
export async function readRuleEntries(store: Store): Promise<RuleEntry[]> {
  const rules = await store.rules.list();
  const proposals = await store.proposals.list();
  const byId = new Map<RuleId, Proposal[]>();
  for (const proposal of proposals) {
    byId.set(proposal.ruleId, [...(byId.get(proposal.ruleId) ?? []), proposal]);
  }
  const ids = new Set<RuleId>([...rules.map((rule) => rule.id), ...byId.keys()]);
  const entries: RuleEntry[] = [];
  for (const id of [...ids].sort()) {
    entries.push(
      await entryFor(
        store,
        id,
        rules.find((rule) => rule.id === id),
        byId.get(id) ?? [],
      ),
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// GET /api/rules (work-approve 3.1)
// ---------------------------------------------------------------------------

/** 상태 기록 → 목록 · 상세의 `status` · `statusAt`. 기록이 없으면 ⬜ ("검사 없음") */
function statusAtOf(record: RuleStatusRecord | undefined): { commit: string; checkedAt: string } | undefined {
  return record === undefined ? undefined : { commit: record.commit, checkedAt: record.checkedAt };
}

function listItem(
  entry: RuleEntry,
  config: ParsedPlumbConfig,
  record: RuleStatusRecord | undefined,
): RuleListItem | null {
  const rule = entry.shown;
  if (rule === null) return null;
  const statusAt = statusAtOf(record);
  return {
    id: entry.id,
    ...(rule.block === undefined ? {} : { block: rule.block }),
    blockKnown: rule.block !== undefined && config.blocks?.[rule.block] !== undefined,
    kind: rule.kind,
    statement: rule.statement,
    // 저장소: 마지막 plumb check 결과 기록. 없으면 ⬜ not-run
    status: record?.detail.status ?? 'unchecked',
    ...(statusAt === undefined ? {} : { statusAt }),
    approval: entry.approval,
    highRisk: isHighRiskRule(rule, config),
    ...(entry.pending === undefined ? {} : { pendingProposal: entry.pending.id }),
  };
}

/** `GET /api/rules` 본문. `lastCheck`(머리줄 "마지막 검사")는 저장소 `checks/`의 최신 실행 — 한 번도 안 돌렸으면 없음 */
export async function readRuleList(): Promise<RuleListResponse> {
  const store = await getStore();
  const config = await getConfig();
  const entries = await readRuleEntries(store);
  const status = await store.status();
  const records = new Map((await store.ruleStatus.list()).map((record) => [record.ruleId, record]));
  const maxUnconfirmed = config.reviewQueue.maxUnconfirmed;
  const maxDays = config.reviewQueue.maxDays;
  const longest = status.longestPendingDays;
  return {
    rules: entries
      .map((entry) => listItem(entry, config, records.get(entry.id)))
      .filter((item): item is RuleListItem => item !== null),
    ...(status.lastCheck === null ? {} : { lastCheck: status.lastCheck }),
    unconfirmed: status.unconfirmed,
    ...(longest === null ? {} : { longestPendingDays: longest }),
    queueLimit: {
      exceeded: status.unconfirmed > maxUnconfirmed || (longest !== null && longest > maxDays),
      maxUnconfirmed,
      maxDays,
    },
  };
}

const RULE_KINDS: readonly RuleKind[] = ['architecture', 'technical', 'business'];
const APPROVAL_STATES: readonly ApprovalState[] = ['provisional', 'approved', 'rejected'];
const RULE_STATUSES: readonly RuleStatus[] = ['pass-verified', 'pass-unverified', 'recheck', 'fail', 'unchecked'];

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** URL 쿼리 → 필터. 모르는 값은 버린다. `state`는 `approval`의 별칭 */
export function parseRuleListFilter(query: Record<string, string | string[] | undefined>): RuleListFilter {
  const one = (key: string): string | undefined => {
    const value = query[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first.length === 0 ? undefined : first;
  };
  const block = one('block');
  const kind = pick(one('kind'), RULE_KINDS);
  const approval = pick(one('approval') ?? one('state'), APPROVAL_STATES);
  const status = pick(one('status'), RULE_STATUSES);
  return {
    ...(block === undefined ? {} : { block }),
    ...(kind === undefined ? {} : { kind }),
    ...(approval === undefined ? {} : { approval }),
    ...(status === undefined ? {} : { status }),
  };
}

export function hasFilter(filter: RuleListFilter): boolean {
  return Object.keys(filter).length > 0;
}

/**
 * 목록 거르기 (work-approve 4절: 응답을 받은 쪽에서 거른다). 기본은 전체(6절 5번)이되 기각된 규칙은 숨긴다 —
 * `approval=rejected`로 본다 (3.1 "승인 상태" 비고, 4절 "기각")
 */
export function applyRuleListFilter(rules: RuleListItem[], filter: RuleListFilter): RuleListItem[] {
  return rules.filter((item) => {
    if (filter.block !== undefined && item.block !== filter.block) return false;
    if (filter.kind !== undefined && item.kind !== filter.kind) return false;
    if (filter.status !== undefined && item.status !== filter.status) return false;
    if (filter.approval !== undefined) return item.approval === filter.approval;
    return item.approval !== 'rejected';
  });
}

// ---------------------------------------------------------------------------
// GET /api/rules/:id (work-approve 3.2)
// ---------------------------------------------------------------------------

/** diff에 보이는 필드 순서 — `rules.yaml` 키 순서 (기획안 §5.2 예시) */
const DIFF_FIELDS: ReadonlyArray<keyof Rule> = [
  'id',
  'block',
  'kind',
  'statement',
  'summary',
  'source',
  'risk',
  'depends_on',
  'checks',
  'decision',
  'scope',
  'constraint',
];

function fieldText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return JSON.stringify(value);
}

/** 현재 버전과 제안 버전의 필드별 비교. 신규 추가면 전부 `+`, 삭제면 전부 `-` */
export function diffRules(before: Rule | undefined, after: Rule | null): RuleDiffLine[] {
  const lines: RuleDiffLine[] = [];
  for (const field of DIFF_FIELDS) {
    const prev = fieldText(before?.[field]);
    const next = fieldText(after?.[field]);
    if (prev === undefined && next === undefined) continue;
    if (prev === next && prev !== undefined) {
      lines.push({ op: ' ', field, text: `${field}: ${prev}` });
      continue;
    }
    if (prev !== undefined) lines.push({ op: '-', field, text: `${field}: ${prev}` });
    if (next !== undefined) lines.push({ op: '+', field, text: `${field}: ${next}` });
  }
  return lines;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 파서: 대상 레포에 검사 파일이 있는가. `static`은 dependency-cruiser 규칙 이름이라 파일이 아니다 → 있다고 본다.
 * 실행: 마지막 `plumb check`(`checks/` 최신 실행)에 이 검사의 결과가 있으면 `lastResult`
 */
async function checkDetails(rule: Rule, target: string, latest: CheckRun | null): Promise<CheckDetail[]> {
  return Promise.all(
    rule.checks.map(async (check) => {
      const result = latest?.results.find((r) => r.check.ref === check.ref);
      return {
        check,
        exists:
          check.kind === 'static'
            ? true
            : await fileExists(isAbsolute(check.ref) ? check.ref : join(target, check.ref)),
        ...(result === undefined || latest === null
          ? {}
          : {
              lastResult: {
                outcome: result.outcome,
                commit: latest.commit,
                finishedAt: latest.finishedAt,
                ...(result.failure === undefined ? {} : { anchor: result.failure.anchor }),
              },
            }),
      };
    }),
  );
}

/** 상태 기록이 없을 때 ⬜의 이유 (view-verification 3.3 우선순위: 검사 없음 → 검사 파일 없음 → 미승인 → 아직 안 돌림) */
function uncheckedDetail(rule: Rule | null, checks: CheckDetail[], approval: ApprovalState): RuleStatusDetail {
  if (rule === null || rule.checks.length === 0) return { status: 'unchecked', reason: 'no-checks' };
  if (checks.some((check) => !check.exists)) return { status: 'unchecked', reason: 'check-missing' };
  if (approval !== 'approved') return { status: 'unchecked', reason: 'unapproved' };
  return { status: 'unchecked', reason: 'not-run' };
}

/** 결정 기록 파일의 자리. 네 항목 파싱은 #35 — 지금은 ID와 파일 유무(경로)만 */
export interface DecisionFile {
  id: NonNullable<Rule['decision']>;
  path: string;
  exists: boolean;
}

/**
 * `GET /api/rules/:id` 본문. `proposalHash`(409 판정용) · `decisionFile` · `history` · `since`는 #63에서 `RuleDetailResponse`에 들어갔다.
 */
export async function readRuleDetail(id: RuleId): Promise<RuleDetailResponse | undefined> {
  const store = await getStore();
  const config = await getConfig();
  const entry = await readRuleEntry(store, id);
  if (entry === undefined) return undefined;

  const target = getTarget();
  const shown = entry.shown;
  const record = await store.ruleStatus.get(id);
  const latest = await store.checks.latest();
  const checks = shown === null ? [] : await checkDetails(shown, target, latest);
  const dependsOn = shown?.depends_on ?? [];
  const depends: DependencyStatus[] = await Promise.all(
    dependsOn.map(async (ruleId) => ({
      ruleId,
      status: (await store.ruleStatus.get(ruleId))?.detail.status ?? ('unchecked' as const),
      exists: (await readRuleEntry(store, ruleId)) !== undefined,
    })),
  );
  const statusAt = statusAtOf(record);
  const decisionId = shown?.decision;
  const decisionFile: DecisionFile | undefined =
    decisionId === undefined
      ? undefined
      : {
          id: decisionId,
          path: store.paths.decision(decisionId),
          exists: await fileExists(store.paths.decision(decisionId)),
        };

  return {
    ...(entry.rule === undefined ? {} : { rule: entry.rule }),
    approval: entry.approval,
    ...(entry.pending === undefined ? {} : { proposal: entry.pending, proposalHash: hashProposal(entry.pending) }),
    diff: entry.pending === undefined ? [] : diffRules(entry.pending.before ?? entry.rule, entry.pending.after),
    approvals: entry.approvals,
    // 파일이 없으면 `missing`. 있어도 네 항목 파싱(#35) 전이라 `DecisionRecord`는 만들지 않는다
    ...(decisionFile !== undefined && !decisionFile.exists ? { decision: { missing: decisionFile.id } } : {}),
    ...(decisionFile === undefined ? {} : { decisionFile }),
    depends,
    checks,
    // 저장소: 마지막 plumb check의 상태 기록. 없으면 ⬜의 이유를 규칙 · 파일 · 승인에서 유도한다
    status: record?.detail ?? uncheckedDetail(shown, checks, entry.approval),
    ...(statusAt === undefined ? {} : { statusAt }),
    ...(record === undefined ? {} : { history: record.history, since: record.since }),
    highRisk: shown !== null && isHighRiskRule(shown, config),
  };
}
