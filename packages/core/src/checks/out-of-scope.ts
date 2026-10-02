/**
 * "검사 범위 밖" 계산 (이슈 #46, 기획안 §6.3 · §7.5 · §12, view-verification 3.4). 생략할 수 없다 —
 * 15/15 통과가 의미를 가지려면 15가 무엇의 15인지 보여야 한다.
 *
 * - `blocksWithoutRules`: 파서: 블록 그래프의 L1 블록 − 저장소: 규칙 `block` 집합. 진입점 `app`(kind `entry`)과 공유 `lib`는
 *   규칙이 붙는 도메인 블록이 아니므로 제외한다 (이슈 #46 "app · lib는 제외"). 블록 공통 필수 검사는 "규칙"으로 세지 않는다
 * - `codeWithoutRules`: 규칙 `scope`가 없으면 블록 전체를 덮는 것으로 본다(view-verification 6절 3번 기본값) → 이 항목은
 *   "규칙 0개 블록"과 같아지므로 **빈 배열**. `scope` 세분화가 들어오면 여기서 계산한다
 * - `rulesWithoutCode`: 상태가 `unchecked/check-missing`인 규칙 (승인은 됐는데 검사 파일이 레포에 없다)
 * - `untestedFlows`: 트레이스가 없으므로 `{ unavailable: 'no-trace' }` — 0이라고 쓰지 않는다 (M8까지)
 * - `unclassifiedFiles`: 파서: 블록 그래프 `unclassified.length` (항상 표시)
 * - `quarantined`: 실행: 이번 검사의 격리 목록 그대로
 */

import type { BlockGraph } from '../adapter/types.js';
import type { BlockKind, OutOfScope, Quarantine, Rule, RuleStatusRecord } from '../types/index.js';

/** 규칙이 붙지 않는 L1 블록 종류. 도메인 블록이 아닌 것 */
export const NON_RULE_BLOCK_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  'entry',
  'app',
  'test',
  'unclassified',
]);

/** 종류와 무관하게 제외하는 블록 ID (이슈 #46 "`app` · `lib`는 제외"). 어댑터가 `lib`에 어떤 kind를 주든 세지 않는다 */
export const NON_RULE_BLOCK_IDS: ReadonlySet<string> = new Set(['app', 'lib']);

export interface ComputeOutOfScopeInput {
  rules: Rule[];
  graph: BlockGraph;
  /** `computeRuleStatuses`의 출력 */
  statuses: RuleStatusRecord[];
  quarantined: Quarantine[];
}

/** 규칙이 붙을 수 있는 L1 블록 ID (그래프 순서) */
export function ruleBearingBlocks(graph: BlockGraph): string[] {
  return graph.blocks
    .filter(
      (block) => block.level === 'L1' && !NON_RULE_BLOCK_KINDS.has(block.kind) && !NON_RULE_BLOCK_IDS.has(block.id),
    )
    .map((block) => block.id);
}

export function computeOutOfScope(input: ComputeOutOfScopeInput): OutOfScope {
  const ruleBlocks = new Set(input.rules.flatMap((rule) => (rule.block === undefined ? [] : [rule.block])));
  return {
    blocksWithoutRules: ruleBearingBlocks(input.graph).filter((id) => !ruleBlocks.has(id)),
    codeWithoutRules: [],
    rulesWithoutCode: input.statuses
      .filter((record) => record.detail.status === 'unchecked' && record.detail.reason === 'check-missing')
      .map((record) => ({ ruleId: record.ruleId, reason: 'check-missing' as const })),
    untestedFlows: { unavailable: 'no-trace' },
    unclassifiedFiles: input.graph.unclassified.length,
    quarantined: [...input.quarantined],
  };
}
