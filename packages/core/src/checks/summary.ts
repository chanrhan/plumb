/**
 * 상태 집계 (view-verification 3.1 · 3.2, views.ts `StatusCounts` · `VerificationBlock`).
 * `plumb check`의 표(#47)와 M8 검증 View가 같은 계산을 쓴다.
 */

import type {
  ApprovalState,
  Rule,
  RuleId,
  RuleStatus,
  RuleStatusRecord,
  RuleStatusSeverity,
  StatusCounts,
  VerificationBlock,
} from '../types/index.js';

/** 블록 없는 규칙(`block` 비움)이 모이는 집계 ID — "블록 공통" (view-verification 3.2) */
export const COMMON_BLOCK_ID = 'common';

/** 최악 상태 우선 순위 (rules.ts `RuleStatusSeverity`) */
export const STATUS_SEVERITY: RuleStatusSeverity = {
  fail: 4,
  recheck: 3,
  'pass-unverified': 2,
  'pass-verified': 1,
  unchecked: 0,
};

export function emptyStatusCounts(): StatusCounts {
  return { 'pass-verified': 0, 'pass-unverified': 0, recheck: 0, fail: 0, unchecked: 0 };
}

export function computeStatusCounts(statuses: Iterable<Pick<RuleStatusRecord, 'detail'>>): StatusCounts {
  const counts = emptyStatusCounts();
  for (const record of statuses) counts[record.detail.status] += 1;
  return counts;
}

/** 여럿 중 최악 상태. 비어 있으면 `null` (블록 트리의 상태 점) */
export function worstStatus(statuses: Iterable<RuleStatus>): RuleStatus | null {
  let worst: RuleStatus | null = null;
  for (const status of statuses) {
    if (worst === null || STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/** `VerificationBlock`의 집계 부분. `items`(RuleRow) · `lastCheck`는 호출자가 붙인다 */
export type BlockSummary = Pick<VerificationBlock, 'id' | 'rules' | 'approved' | 'byStatus'>;

export interface ComputeBlockSummariesInput {
  rules: Rule[];
  statuses: RuleStatusRecord[];
  approvalStates: ReadonlyMap<RuleId, ApprovalState>;
}

/**
 * 블록별 집계. 순서는 최악 상태 우선(🔴 > 🟠 > 🟡 > 🟢 > ⬜), 같으면 블록 ID 순. 블록 없는 규칙은 {@link COMMON_BLOCK_ID}.
 * 상태 기록이 없는 규칙은 상태 집계에서 빠진다 (규칙 수에는 들어간다).
 */
export function computeBlockSummaries(input: ComputeBlockSummariesInput): BlockSummary[] {
  const byRule = new Map(input.statuses.map((record) => [record.ruleId, record]));
  const blocks = new Map<string, BlockSummary>();
  for (const rule of input.rules) {
    const id = rule.block ?? COMMON_BLOCK_ID;
    const summary = blocks.get(id) ?? { id, rules: 0, approved: 0, byStatus: emptyStatusCounts() };
    summary.rules += 1;
    if (input.approvalStates.get(rule.id) === 'approved') summary.approved += 1;
    const record = byRule.get(rule.id);
    if (record !== undefined) summary.byStatus[record.detail.status] += 1;
    blocks.set(id, summary);
  }
  return [...blocks.values()].sort((a, b) => {
    const diff = severityOfCounts(b.byStatus) - severityOfCounts(a.byStatus);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

function severityOfCounts(counts: StatusCounts): number {
  const present = (Object.keys(counts) as RuleStatus[]).filter((status) => counts[status] > 0);
  const worst = worstStatus(present);
  return worst === null ? -1 : STATUS_SEVERITY[worst];
}
