/**
 * 블록 트리 사이드바 `GET /api/blocks` (README 2절 공통 레이아웃, compare C-05 · C-06 · C-07, 이슈 #121).
 *
 * - 블록 목록 = `plumb.config.json` `blocks`(선언 순서) + 규칙에만 있는 블록(ID 순). 블록 없는 규칙(`common`)은 블록이 아니다
 * - `paths` · `public` · `files`는 아키텍처 View JSON의 블록 노드(파서)에서, 없으면 config에서. 그래프가 없으면 `files`는 0이지만
 *   응답 전체가 `empty: 'no-graph'`라 화면은 "블록 아직 없음"을 그린다
 * - `worstStatus`는 그 블록 규칙들의 상태 중 최악(저장소). 규칙이 없거나 상태 기록이 하나도 없으면 `null`(화면은 ⬜)
 * - `unclassified`는 아키텍처 View JSON `unclassified.length`(파서). 그래프가 없으면 0이라고 쓰지 않고 `empty: 'no-graph'`
 */

import type {
  ArchitectureView,
  BlockNode,
  BlocksResponse,
  PlumbConfig,
  Rule,
  RuleStatus,
  RuleStatusRecord,
  StatusCounts,
} from '../types/index.js';
import { COMMON_BLOCK_ID, computeBlockSummaries } from './summary.js';

/**
 * 블록 상태 점의 우선순위 — 🔴 fail > 🟠 recheck > 🟡 pass-unverified > ⬜ unchecked > 🟢 pass-verified (이슈 #121).
 * 집계 정렬용 `STATUS_SEVERITY`(🟢 > ⬜)와 ⬜ · 🟢의 자리가 다르다: 검사 안 된 규칙이 하나라도 있는 블록은 "유효"로 보이면 안 된다.
 */
export const BLOCK_DOT_ORDER: readonly RuleStatus[] = [
  'fail',
  'recheck',
  'pass-unverified',
  'unchecked',
  'pass-verified',
];

/** 상태 집계에서 블록 상태 점 하나. 전부 0이면 `null` */
export function worstBlockStatus(counts: StatusCounts): RuleStatus | null {
  for (const status of BLOCK_DOT_ORDER) if (counts[status] > 0) return status;
  return null;
}

export interface ComputeBlocksInput {
  /** `plumb.config.json` — `blocks`만 본다 */
  config: Pick<PlumbConfig, 'blocks'>;
  rules: Rule[];
  statuses: RuleStatusRecord[];
  /** 저장소 `views/architecture.json`. 아직 없으면 `null` → `empty: 'no-graph'` */
  graph: Pick<ArchitectureView, 'blocks' | 'unclassified'> | null;
}

const DEFAULT_PUBLIC = ['index.ts'];

/**
 * 사이드바 응답. 순서는 config 선언 순, 그 뒤에 규칙에만 있는 블록을 ID 순으로.
 * 상태 점은 {@link computeBlockSummaries}의 `byStatus`에 {@link worstBlockStatus}를 적용한 것 — `plumb check` 표 · 검증 View와 같은 집계다.
 */
export function computeBlocksResponse(input: ComputeBlocksInput): BlocksResponse {
  const graphBlocks = new Map((input.graph?.blocks ?? []).map((block) => [block.id, block]));
  const summaries = new Map(
    computeBlockSummaries({ rules: input.rules, statuses: input.statuses, approvalStates: new Map() }).map(
      (summary) => [summary.id, summary],
    ),
  );

  const ids: string[] = Object.keys(input.config.blocks ?? {});
  const declared = new Set(ids);
  const ruleOnly = new Set<string>();
  for (const rule of input.rules) {
    if (rule.block !== undefined && rule.block !== COMMON_BLOCK_ID && !declared.has(rule.block))
      ruleOnly.add(rule.block);
  }
  ids.push(...[...ruleOnly].sort((a, b) => a.localeCompare(b)));

  const blocks: BlocksResponse['blocks'] = ids.map((id) => {
    const fromConfig = input.config.blocks?.[id];
    const fromGraph = graphBlocks.get(id);
    const summary = summaries.get(id);
    const node: BlockNode = {
      id,
      level: fromGraph?.level ?? 'L1',
      kind: fromGraph?.kind ?? 'domain',
      paths: [...(fromGraph?.paths ?? fromConfig?.include ?? [])],
      public: [...(fromGraph?.public ?? fromConfig?.public ?? DEFAULT_PUBLIC)],
      files: fromGraph?.files ?? 0,
      declared: fromConfig !== undefined,
      rules: summary?.rules ?? 0,
    };
    if (fromGraph?.label !== undefined) node.label = fromGraph.label;
    if (fromGraph?.shared !== undefined) node.shared = fromGraph.shared;
    const risk = fromConfig?.risk ?? fromGraph?.risk;
    if (risk !== undefined) node.risk = risk;
    return { ...node, worstStatus: summary === undefined ? null : worstBlockStatus(summary.byStatus) };
  });

  if (input.graph === null) return { blocks, unclassified: 0, empty: 'no-graph' };
  return { blocks, unclassified: input.graph.unclassified.length };
}
