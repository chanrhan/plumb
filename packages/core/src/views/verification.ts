/**
 * 테스트/검증 상태 View 생성기 (이슈 #57, 기획안 §6.3 · §7.3 · §7.4 · §12 · §14, view-verification 2절 · 3절 · 5절).
 *
 * **`plumb check`를 다시 돌리지 않는다.** 저장소 기록만 읽는다 — 최신 `CheckRun`(`checks/`) · `rule-status/` · `rules.yaml` ·
 * 제안(`proposals/`, 잠정 규칙) · 승인 기록(`approvals/`) · 결정 기록(`decisions/`). 실행은 #47의 몫이고, 이 생성기는 그 기록을
 * `VerificationView` JSON(정본)으로 모은 뒤 `render()`가 §6.3 화면을 Markdown으로 그린다.
 *
 * - 상태 · 사유 · 아이콘 · 검사 종류 라벨 · 진술 요약 · 커밋 축약은 `checks/run-check.ts`(#47)의 것을 그대로 import한다.
 *   CLI 표(`cli/commands/check.ts`)와 같은 문구 · 같은 계산 — Markdown은 그 표의 문서 버전이다
 * - 블록별 집계는 `checks/summary.ts`의 `computeBlockSummaries` · `computeStatusCounts`, 필수 검사 세 행은 `checks/common.ts`의
 *   `computeCommonRows`(최신 `CheckRun`의 정적 결과로)
 * - 잠정 규칙(제안만 있고 `rules.yaml`에 없는 규칙)도 행으로 센다 — §6.3 "규칙 12 · 승인 9", 와이어프레임의 `⬜ … 미승인` 행.
 *   `rule list`(#32 `collectRows`)와 같은 합집합이다
 * - "검사 범위 밖"은 **생략할 수 없다**(§6.3 "15/15 통과가 의미를 가지려면 15가 무엇의 15인지 보여야 한다"). `CheckRun`에는 범위 밖이
 *   저장되지 않으므로 다시 계산한다. 블록 그래프가 없으니 "규칙 0개 블록"은 `config.blocks` 키 − 규칙 `block` 집합이고, "미분류 파일"은
 *   측정 불가 `{ unavailable: 'no-graph' }`다 (#63 — 전에는 0을 넣고 렌더가 머리말 출처로 가렸다)
 * - `staleResult`: 마지막 `CheckRun`의 러너가 실패했고(`runner.exitCode !== 0`) JUnit 결과가 없으면 — `rule-status/`는 이전 결과
 *   그대로이므로(run-check ⑤) 그 커밋을 `previousCommit`에 적고 행마다 "(이전 결과 …)"를 붙인다 (view-verification 5절)
 * - 유효성(§7.4)은 M7 위반 주입 전까지 기록이 없다 → `validity` 없음 → 🟡 행은 "유효성 미확인 (주입 기록 없음)"
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeCommonRows } from '../checks/common.js';
import { NON_RULE_BLOCK_IDS } from '../checks/out-of-scope.js';
import {
  anchorText,
  CHECK_KIND_LABEL,
  describeStatusDetail,
  NOT_RUN_DETAIL,
  ruleSummary,
  STATUS_ICON,
  shortCommit,
} from '../checks/run-check.js';
import { approvalStatesFrom, missingCheckFiles, resultsForRule } from '../checks/status.js';
import { COMMON_BLOCK_ID, computeBlockSummaries, computeStatusCounts, STATUS_SEVERITY } from '../checks/summary.js';
import { decisionsForRule } from '../decisions/store.js';
import type {
  Approval,
  CheckRun,
  CommonCheckRow,
  Grade,
  LastCheck,
  OutOfScope,
  Proposal,
  Rule,
  RuleId,
  RuleRow,
  RuleStatus,
  RuleStatusDetail,
  RuleStatusRecord,
  SourceRef,
  StatusCounts,
  VerificationBlock,
  VerificationView,
} from '../types/index.js';
import { makeHeader, source } from './header.js';
import { anchorLink, codeSpan, fence, heading, mdTable, sourceBar } from './markdown.js';
import type { ViewContext, ViewGenerator } from './types.js';

// ---------------------------------------------------------------------------
// 표시 문구 — `cli/commands/check.ts`와 같은 문자열. run-check로 올릴 후보 (PR 본문)
// ---------------------------------------------------------------------------

export const OUT_OF_SCOPE_HEADER = '━━ 검사 범위 밖 ━━';
export const COMMON_SECTION_HEADER = '블록 공통 (필수 검사, 기획안 §12)';
/** 블록 없는 규칙(`block` 비움) 묶음의 표시 이름. 필수 검사 절과 구분한다 */
export const COMMON_RULES_LABEL = '블록 공통 규칙 (block 없음)';
/** 아직 `plumb check`가 한 번도 돌지 않았다 (view-verification 5절) */
export const NO_CHECK_MESSAGE = '아직 검사 없음. `plumb check`를 돌리세요';
/** 유효성 열 — M7 전에는 모든 통과가 이것 (view-verification 5절 "주입 기록 없음") */
export const VALIDITY_UNKNOWN = '유효성 미확인 (주입 기록 없음)';
/** 러너 출력 꼬리 — "stderr 마지막 20줄" (view-verification 5절) */
export const STDERR_TAIL_LINES = 20;

const STATUS_ORDER: readonly RuleStatus[] = ['pass-verified', 'pass-unverified', 'recheck', 'fail', 'unchecked'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** 상태 집계를 `🟢 5 🟡 2 …`로. `all`이면 0도 보인다 (상단 요약), 아니면 0은 뺀다 (블록 줄) */
function countsText(counts: StatusCounts, all = false): string {
  return STATUS_ORDER.filter((status) => all || counts[status] > 0)
    .map((status) => `${STATUS_ICON[status]} ${counts[status]}`)
    .join(' ');
}

/** `2026-10-02T09:00:01.000Z` → `2026-10-02 09:00 UTC` */
function timeText(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

/** `a1b2c3d · 2026-10-02 09:00 UTC` */
function commitTime(check: LastCheck): string {
  return `${shortCommit(check.commit)} · ${timeText(check.finishedAt)}`;
}

function commonIcon(row: CommonCheckRow): string {
  switch (row.result.status) {
    case 'pass':
      return STATUS_ICON['pass-verified'];
    case 'fail':
      return STATUS_ICON.fail;
    case 'events':
      return row.result.count === row.result.withDecision ? STATUS_ICON['pass-verified'] : STATUS_ICON.fail;
    case 'unchecked':
      return STATUS_ICON.unchecked;
  }
}

/** 필수 검사 행의 사유 열 */
function describeCommonRow(row: CommonCheckRow): string {
  switch (row.result.status) {
    case 'pass':
      return '—';
    case 'fail': {
      const first = row.result.violations[0];
      return `위반 ${row.result.violations.length}건 · ${first.from.file}:${first.from.line} → ${first.to || '?'}`;
    }
    case 'events':
      return `이벤트 ${row.result.count} · 사유 기록 ${row.result.withDecision}`;
    case 'unchecked':
      return row.index === 3 ? '검사 없음 (M8 — git 공개 진입점 diff)' : '검사 없음 (정적 결과 없음)';
  }
}

function commonCounts(rows: CommonCheckRow[]): string {
  const counts = computeStatusCounts(
    rows.map((row) => {
      const icon = commonIcon(row);
      const status: RuleStatus =
        icon === STATUS_ICON.fail ? 'fail' : icon === STATUS_ICON['pass-verified'] ? 'pass-verified' : 'unchecked';
      return { detail: { status } as RuleStatusDetail };
    }),
  );
  return countsText(counts);
}

/** `store.status` 한 줄 — CLI `statusLine`과 같은 문구 (색 없음) */
function storeStatusText(status: VerificationView['store']['status']): string {
  switch (status) {
    case 'ok':
      return '보호 저장소 정상';
    case 'tampered':
      return '⚠ 변조 증거: rules.yaml이 마지막 승인 이후 바뀜';
    case 'unverified':
      return '⚠ 미확인 저장소: 승인 기록 없이 rules.yaml에 내용이 있음';
  }
}

// ---------------------------------------------------------------------------
// 읽기 보조
// ---------------------------------------------------------------------------

/** 열린 제안 — `cli/commands/shared.ts` `isOpenProposal`과 같은 판정 (CLI는 import하지 않는다) */
function isOpenProposal(proposal: Proposal): boolean {
  return proposal.applied === 'provisional' || proposal.applied === 'pending';
}

/** 마지막 `CheckRun`에 JUnit 결과가 없었나 — `counts.junit`이 0이고 결과가 전부 정적이면 (`CheckRun`에 `junitMissing`을 저장하는 것은 저장 형식 결정이라 #63에서 보류) */
export function junitMissingOf(run: CheckRun): boolean {
  return run.counts.junit === 0 && run.results.every((result) => result.check.kind === 'static');
}

/** 러너가 죽어 JUnit이 없으면 `rule-status/`는 이전 결과 그대로다 (run-check ⑤) → 이전 결과를 보이는 중 */
export function isStaleRun(run: CheckRun): boolean {
  return run.runner.exitCode !== 0 && junitMissingOf(run);
}

function lastCheckOf(run: CheckRun): LastCheck {
  return { runId: run.runId, commit: run.commit, finishedAt: run.finishedAt };
}

/** 이전 기록 중 가장 최근 `checkedAt`의 커밋. 기록이 하나도 없으면 `null` */
function latestCommitOf(records: Iterable<RuleStatusRecord>): string | null {
  let latest: RuleStatusRecord | null = null;
  for (const record of records) {
    if (latest === null || record.checkedAt.localeCompare(latest.checkedAt) > 0) latest = record;
  }
  return latest === null ? null : latest.commit;
}

/** 검사 종류 → 등급 (기획안 §7.2 · rules.ts `GradeOfCheckKind`). 여럿이면 가장 약한 쪽. 검사가 없으면 없음 */
function gradeOf(rule: Rule): Grade | undefined {
  if (rule.checks.length === 0) return undefined;
  return rule.checks.every((check) => check.kind === 'static') ? 1 : 2;
}

/** 규칙별 마지막 `approve` 줄 */
function latestApprovalOf(history: Approval[]): Approval | undefined {
  let latest: Approval | undefined;
  for (const record of history) {
    if (record.action !== 'approve') continue;
    if (latest === undefined || record.at.localeCompare(latest.at) >= 0) latest = record;
  }
  return latest;
}

interface RowInput {
  rule: Rule;
  /** `rules.yaml`에 있는가. 없으면 열린 제안만 있는 잠정 규칙 */
  inRules: boolean;
  record: RuleStatusRecord | undefined;
  openProposal: Proposal | undefined;
  history: Approval[];
  decision: RuleRow['decision'];
  latestRun: CheckRun | null;
  fileExists: (relPath: string) => boolean;
}

function buildRow(input: RowInput): RuleRow {
  const { rule, record } = input;
  const detail: RuleStatusDetail = input.inRules
    ? (record?.detail ?? NOT_RUN_DETAIL)
    : { status: 'unchecked', reason: 'unapproved' };
  const approval = latestApprovalOf(input.history);
  const grade = gradeOf(rule);

  // ⚠ 체류: 잠정 규칙은 제안 시각부터, 잠정 상태(🟡 🟠) 행은 그 상태가 된 시각부터 (view-verification 3.3 "⚠ 체류 일수")
  const pendingSince = !input.inRules
    ? input.openProposal?.proposedAt
    : record !== undefined && (detail.status === 'pass-unverified' || detail.status === 'recheck')
      ? record.since
      : undefined;

  const durations =
    input.latestRun === null
      ? []
      : resultsForRule(rule, input.latestRun.results).flatMap((result) =>
          result.durationSec === undefined ? [] : [result.durationSec],
        );
  const lastResult =
    record === undefined
      ? undefined
      : {
          commit: record.commit,
          finishedAt: record.checkedAt,
          ...(durations.length === 0 ? {} : { durationSec: durations.reduce((sum, sec) => sum + sec, 0) }),
        };

  const missing =
    detail.status === 'unchecked' && detail.reason === 'check-missing' ? missingCheckFiles(rule, input.fileExists) : [];

  return {
    ruleId: rule.id,
    ...(rule.block === undefined ? {} : { block: rule.block }),
    kind: rule.kind,
    summary: ruleSummary(rule),
    statement: rule.statement,
    checks: rule.checks.map((check) => ({ ...check })),
    ...(grade === undefined ? {} : { grade }),
    detail,
    ...(approval === undefined ? {} : { approvedAt: approval.at, approvedBy: approval.by }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(pendingSince === undefined ? {} : { pendingSince }),
    ...(lastResult === undefined ? {} : { lastResult }),
    history: record === undefined ? [] : [...record.history],
    ...(missing.length === 0 ? {} : { checkFilesMissing: missing }),
  };
}

/** 집계 함수(`computeBlockSummaries` · `computeStatusCounts`)에 넘길 최소 기록. 행마다 하나 — 기록 없는 규칙도 ⬜로 센다 */
function aggregateRecord(row: RuleRow, generatedAt: string): RuleStatusRecord {
  return {
    ruleId: row.ruleId,
    detail: row.detail,
    since: row.pendingSince ?? row.lastResult?.finishedAt ?? generatedAt,
    commit: row.lastResult?.commit ?? '',
    checkedAt: row.lastResult?.finishedAt ?? generatedAt,
    history: row.history,
  };
}

/** 블록 안 행 순서: 최악 상태 우선, 같으면 규칙 ID */
function byWorstFirst(a: RuleRow, b: RuleRow): number {
  const diff = STATUS_SEVERITY[b.detail.status] - STATUS_SEVERITY[a.detail.status];
  return diff !== 0 ? diff : a.ruleId.localeCompare(b.ruleId);
}

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

export async function generateVerificationView(ctx: ViewContext): Promise<VerificationView> {
  const { store, config } = ctx;
  const now = ctx.now();
  const generatedAt = now.toISOString();
  const serviceRoot = resolve(ctx.root, config.service);
  const fileExists = (relPath: string) => existsSync(resolve(serviceRoot, relPath));

  // 저장소 — 상태 · 미확인(잠정 제안) · 검토 대기열 (CLI `statusLine` · UI 상단 바와 같은 계산)
  const status = await store.status();
  const latestRun = await store.checks.latest();
  const rules = await store.rules.list();
  const proposals = await store.proposals.list();
  const records = new Map((await store.ruleStatus.list()).map((record) => [record.ruleId, record]));

  // 규칙 합집합: rules.yaml + 열린 제안만 있는 규칙 (잠정) — `rule list`와 같다
  const ruleIds = new Set<RuleId>([...rules.map((rule) => rule.id), ...proposals.map((p) => p.ruleId)]);
  const histories = new Map<RuleId, Approval[]>();
  for (const id of ruleIds) histories.set(id, await store.approvals.history(id));
  const approvalStates = approvalStatesFrom([...histories.values()].flat());

  const rows: RuleRow[] = [];
  const shownRules: Rule[] = [];
  for (const id of [...ruleIds].sort()) {
    const rule = rules.find((r) => r.id === id);
    const open = proposals.filter((p) => p.ruleId === id && isOpenProposal(p));
    const latestOpen = open.at(-1);
    const shown = rule ?? latestOpen?.after ?? latestOpen?.before;
    if (shown === undefined) continue; // 처리 끝난 제안(기각 · 삭제)만 있는 규칙은 행이 아니다
    const decision = shown.decision ?? (await decisionsForRule(store.paths, id))[0]?.id;
    rows.push(
      buildRow({
        rule: shown,
        inRules: rule !== undefined,
        record: records.get(id),
        openProposal: latestOpen,
        history: histories.get(id) ?? [],
        decision,
        latestRun,
        fileExists,
      }),
    );
    shownRules.push(shown);
  }

  const statuses = rows.map((row) => aggregateRecord(row, generatedAt));
  const byRow = new Map(rows.map((row) => [row.ruleId, row]));
  const lastCheck = latestRun === null ? undefined : lastCheckOf(latestRun);

  const blocks: VerificationBlock[] = computeBlockSummaries({ rules: shownRules, statuses, approvalStates }).map(
    (block) => ({
      ...block,
      ...(lastCheck === undefined ? {} : { lastCheck }),
      items: shownRules
        .filter((rule) => (rule.block ?? COMMON_BLOCK_ID) === block.id)
        .map((rule) => byRow.get(rule.id) as RuleRow)
        .sort(byWorstFirst),
    }),
  );

  // 잠정 규칙 중 가장 오래 체류한 것 (store.status()의 longestPendingDays와 같은 집합 — `applied: 'provisional'`)
  const oldest = proposals
    .filter((p) => p.applied === 'provisional' && !Number.isNaN(Date.parse(p.proposedAt)))
    .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt))[0];

  // 검사 범위 밖 — CheckRun에 저장되지 않으므로 다시 계산. 블록 그래프가 없으니 블록 목록은 설정 키
  const ruleBlocks = new Set(rows.flatMap((row) => (row.block === undefined ? [] : [row.block])));
  const outOfScope: OutOfScope = {
    blocksWithoutRules: Object.keys(config.blocks ?? {}).filter(
      (id) => !NON_RULE_BLOCK_IDS.has(id) && !ruleBlocks.has(id),
    ),
    codeWithoutRules: [],
    rulesWithoutCode: rows
      .filter((row) => row.detail.status === 'unchecked' && row.detail.reason === 'check-missing')
      .map((row) => ({ ruleId: row.ruleId, reason: 'check-missing' as const })),
    untestedFlows: { unavailable: 'no-trace' },
    // 이 생성기는 블록 그래프를 읽지 않는다 — 미분류 파일 수는 측정 불가 (0이 아니다)
    unclassifiedFiles: { unavailable: 'no-graph' },
    quarantined: latestRun === null ? [] : latestRun.quarantined.map((item) => ({ ...item })),
  };

  const sources: SourceRef[] = [
    ...(latestRun === null ? [] : [source.execution('plumb check', undefined, `checks/${latestRun.runId}.json`)]),
    source.store('rule-status/'),
    source.store('rules.yaml'),
    source.store('proposals/'),
    source.store('decisions/'),
  ];

  const staleResult: VerificationView['staleResult'] =
    latestRun !== null && isStaleRun(latestRun)
      ? {
          exitCode: latestRun.runner.exitCode,
          stderrTail: [...(latestRun.runner.stderrTail ?? [])],
          previousCommit: latestCommitOf(records.values()),
        }
      : undefined;
  return {
    header: makeHeader('verification', { now, sources, ...(ctx.commit === undefined ? {} : { commit: ctx.commit }) }),
    store: { status: status.status },
    ...(lastCheck === undefined ? {} : { lastCheck }),
    ...(staleResult === undefined ? {} : { staleResult }),
    summary: {
      unconfirmed: status.unconfirmed + status.reviewQueue,
      ...(status.longestPendingDays === null ? {} : { longestPendingDays: status.longestPendingDays }),
      ...(oldest === undefined ? {} : { longestPendingRule: oldest.ruleId }),
      rules: rows.length,
      approved: rows.filter((row) => approvalStates.get(row.ruleId) === 'approved').length,
      byStatus: computeStatusCounts(statuses),
      checks: latestRun === null ? { junit: 0, static: 0 } : { ...latestRun.counts },
      quarantined: latestRun === null ? 0 : latestRun.quarantined.length,
    },
    blocks,
    common: computeCommonRows(latestRun === null ? [] : latestRun.results),
    outOfScope,
    ...(latestRun === null ? {} : { junitMissing: junitMissingOf(latestRun) }),
  };
}

// ---------------------------------------------------------------------------
// 렌더 — §6.3 화면을 Markdown으로. JSON만 본다
// ---------------------------------------------------------------------------

function pendingDays(since: string, generatedAt: string): number | null {
  const from = Date.parse(since);
  const to = Date.parse(generatedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/** 상단 첫 줄: `⚠ 미확인 항목 n건 · 최장 d일 (규칙)  |  보호 저장소 정상 · 마지막 검사 <커밋> · <시각>` */
function headline(view: VerificationView): string {
  const { summary } = view;
  const left = [`${summary.unconfirmed > 0 ? '⚠ ' : ''}미확인 항목 ${summary.unconfirmed}건`];
  if (summary.longestPendingDays !== undefined) {
    left.push(
      `최장 ${summary.longestPendingDays}일${summary.longestPendingRule === undefined ? '' : ` (${summary.longestPendingRule})`}`,
    );
  }
  const right = [storeStatusText(view.store.status)];
  right.push(view.lastCheck === undefined ? '마지막 검사 없음' : `마지막 검사 ${commitTime(view.lastCheck)}`);
  return `${left.join(' · ')}  |  ${right.join(' · ')}`;
}

/** 둘째 줄: 규칙 · 승인 · 상태 집계(0 포함) · 검사 수 · 격리 · 검증된 통과 비율 (§14 🟢/(🟢+🟡)) */
function summaryLine(view: VerificationView): string {
  const { summary } = view;
  const verified = summary.byStatus['pass-verified'];
  const passed = verified + summary.byStatus['pass-unverified'];
  const ratio = passed === 0 ? '—' : `${verified}/${passed} (${Math.round((verified / passed) * 100)}%)`;
  return [
    `규칙 ${summary.rules}`,
    `승인 ${summary.approved}`,
    countsText(summary.byStatus, true),
    `검사 ${summary.checks.junit + summary.checks.static} (JUnit ${summary.checks.junit} · 정적 ${summary.checks.static})`,
    `격리 ${summary.quarantined}`,
    `검증된 통과 비율 🟢/(🟢+🟡) ${ratio}`,
  ].join(' · ');
}

/** 규칙 행의 사유/유효성 셀 — 여러 줄은 `<br>` (mdTable이 바꾼다) */
function reasonCell(row: RuleRow, view: VerificationView): string {
  const lines: string[] = [];
  const stale = view.staleResult !== undefined && row.lastResult !== undefined;
  const first = [describeStatusDetail(row.detail)];
  if (row.lastResult === undefined && row.detail.status === 'unchecked' && row.detail.reason === 'not-run') {
    first.push('(기록 없음)');
  } else if (stale && row.lastResult !== undefined) {
    first.push(`(이전 결과 ${shortCommit(row.lastResult.commit)})`);
  }
  if (row.pendingSince !== undefined) {
    const days = pendingDays(row.pendingSince, view.header.generatedAt);
    if (days !== null) first.push(`· ⚠ ${days}일 체류`);
  }
  lines.push(first.join(' '));

  if (row.detail.status === 'fail') {
    for (const failure of row.detail.failures) {
      lines.push(failure.message.split(/\r?\n/)[0] ?? '');
      if (failure.counterexample !== undefined || failure.seed !== undefined) {
        lines.push(
          `fast-check 반례: ${failure.counterexample ?? '—'}${failure.seed === undefined ? '' : ` · 시드 ${failure.seed}`}`,
        );
      }
    }
  } else if (row.validity !== undefined) {
    // §7.4 `주입: … → 검사 실패 ✔ 유효` / `→ 검사 통과 ✘ 무효`. 기록이 없으면(M7 전) describeStatusDetail의
    // "유효성 미확인 (주입 기록 없음)"이 이미 첫 줄에 있다 (view-verification 5절)
    const outcome = row.validity.valid ? '검사 실패 ✔ 유효' : '검사 통과 ✘ 무효';
    lines.push(`주입 ${shortCommit(row.validity.commit)}: ${row.validity.description} → ${outcome}`);
  }

  const meta: string[] = [];
  if (row.approvedAt !== undefined) {
    meta.push(`승인 ${row.approvedAt.slice(0, 10)}${row.approvedBy === undefined ? '' : ` (${row.approvedBy})`}`);
  }
  if (row.decision !== undefined) meta.push(`결정 ${row.decision}`);
  if (meta.length > 0) lines.push(meta.join(' · '));
  return lines.join('\n');
}

/** 위치 셀: 🔴는 실패 `file:line` 앵커 링크, 검사 파일 없음은 그 경로(링크 없음 — 없는 파일), 나머지는 비움 */
function whereCell(row: RuleRow): string {
  if (row.detail.status === 'fail') {
    return row.detail.failures
      .map((failure) => {
        const text = anchorText(failure.anchor);
        return failure.anchor.file === undefined ? text : anchorLink(failure.anchor);
      })
      .filter((text) => text !== '')
      .join('\n');
  }
  if (row.checkFilesMissing !== undefined && row.checkFilesMissing.length > 0) {
    return row.checkFilesMissing.map((file) => `${file} (파일 없음)`).join('\n');
  }
  return '';
}

function ruleTable(rows: RuleRow[], view: VerificationView): string {
  return mdTable(
    ['상태', '규칙', '검사 종류', '사유 / 유효성', '위치'],
    rows.map((row) => [
      STATUS_ICON[row.detail.status],
      `${row.summary} (${codeSpan(row.ruleId)})`,
      row.checks[0] === undefined ? '검사 없음' : CHECK_KIND_LABEL[row.checks[0].kind],
      reasonCell(row, view),
      whereCell(row),
    ]),
  );
}

function blockSection(block: VerificationBlock, view: VerificationView): string[] {
  const label = block.id === COMMON_BLOCK_ID ? COMMON_RULES_LABEL : block.id;
  const head = `${label} — 규칙 ${block.rules} · 승인 ${block.approved}${block.rules > 0 ? ` · ${countsText(block.byStatus)}` : ''}`;
  const right = block.lastCheck ?? view.lastCheck;
  return [
    heading(2, right === undefined ? head : `${head}  ·  ${commitTime(right)}`),
    '',
    ruleTable(block.items, view),
    '',
  ];
}

function commonSection(view: VerificationView): string[] {
  const head = `${COMMON_SECTION_HEADER} — ${commonCounts(view.common)}`;
  return [
    heading(2, view.lastCheck === undefined ? head : `${head}  ·  ${commitTime(view.lastCheck)}`),
    '',
    mdTable(
      ['상태', '검사', '검사 종류', '사유', '위치'],
      view.common.map((row) => [
        commonIcon(row),
        `(${row.index}) ${row.title}`,
        CHECK_KIND_LABEL.static,
        describeCommonRow(row),
        row.anchor === undefined ? '' : anchorLink(row.anchor),
      ]),
    ),
    '',
  ];
}

/** 여섯 항목 전부 — 값이 없어도 항목은 쓴다. 측정 불가는 그렇게 쓴다 (0이라고 쓰지 않는다) */
function outOfScopeSection(view: VerificationView): string[] {
  const out = view.outOfScope;
  const blocks =
    'unavailable' in out.blocksWithoutRules
      ? '측정 불가 (블록 그래프 없음)'
      : out.blocksWithoutRules.length === 0
        ? '없음'
        : out.blocksWithoutRules.join(', ');
  const code =
    out.codeWithoutRules.length === 0
      ? '없음 (규칙 scope 미도입 — 규칙은 블록 전체를 덮는다)'
      : out.codeWithoutRules.map((item) => `${item.path} (파일 ${item.files})`).join(' · ');
  const rulesWithoutCode =
    out.rulesWithoutCode.length === 0
      ? '없음'
      : out.rulesWithoutCode
          .map((item) => `${item.ruleId} (${item.reason === 'check-missing' ? '검사 파일 없음' : 'scope 글롭 매칭 0'})`)
          .join(' · ');
  const flows =
    'unavailable' in out.untestedFlows
      ? out.untestedFlows.unavailable === 'no-trace'
        ? '측정 불가 (트레이스 없음)'
        : '측정 불가 (정적 그래프 없음)'
      : `${out.untestedFlows.count}개 / 진입점 ${out.untestedFlows.total} (${out.untestedFlows.mode})`;
  const unclassified =
    typeof out.unclassifiedFiles === 'number' ? `${out.unclassifiedFiles}개` : '측정 불가 (블록 그래프 없음)';
  const quarantined =
    view.lastCheck === undefined
      ? '검사 없음'
      : out.quarantined.length === 0
        ? '0'
        : `${out.quarantined.length} — ${out.quarantined
            .map((item) => `${item.ref} (${item.runs}회 중 ${item.passes}회 통과)`)
            .join(' · ')}`;
  const head = OUT_OF_SCOPE_HEADER;
  return [
    heading(2, view.lastCheck === undefined ? head : `${head}  ·  ${commitTime(view.lastCheck)}`),
    '',
    `- 규칙 0개 블록: ${blocks}`,
    `- 요구사항에 없는 코드: ${code}`,
    `- 코드에 없는 요구사항: ${rulesWithoutCode}`,
    `- 테스트가 안 지나간 흐름: ${flows}`,
    `- 미분류 파일: ${unclassified}`,
    `- 불안정으로 격리된 검사: ${quarantined}`,
    '',
  ];
}

export function renderVerificationView(view: VerificationView): string {
  const lines: string[] = [sourceBar(view.header.sources), '', headline(view), summaryLine(view), ''];

  // 경보 — 검사 실패(이전 결과) · JUnit 없음 · 검사 기록 없음 (view-verification 5절)
  if (view.staleResult !== undefined) {
    const previous =
      view.staleResult.previousCommit === null
        ? '이전 결과 없음'
        : `이전 결과(${shortCommit(view.staleResult.previousCommit)})를 보인다`;
    lines.push(
      `> ⚠ 검사 실패 (exit ${view.staleResult.exitCode}) — JUnit 결과 없음. rule-status는 그대로 두고 ${previous}`,
    );
    const tail = view.staleResult.stderrTail.slice(-STDERR_TAIL_LINES);
    if (tail.length > 0) lines.push('', fence('text', tail.join('\n')));
    lines.push('');
  } else if (view.junitMissing === true) {
    lines.push('> JUnit 결과 없음 — 리포터 설정 확인 (`vitest --reporter=junit`). 정적 검사만 반영', '');
  }
  if (view.lastCheck === undefined) lines.push(`> ${NO_CHECK_MESSAGE}`, '');

  // 블록별
  if (view.blocks.length === 0) {
    lines.push('규칙 없음 — `plumb rule propose --file <json>` → `plumb approve <id>`로 규칙을 만든다', '');
  } else {
    for (const block of view.blocks) lines.push(...blockSection(block, view));
  }

  // 블록 공통 — 필수 검사 (1)(2)(3)
  lines.push(...commonSection(view));

  // 검사 범위 밖 — 생략 불가
  lines.push(...outOfScopeSection(view));

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** 테스트/검증 상태 View 생성기. `plumb views`(#60)가 {@link ViewContext}를 만들어 부른다 */
export const verificationView: ViewGenerator<VerificationView> = {
  name: 'verification',
  generate: generateVerificationView,
  render: renderVerificationView,
};
