/**
 * 설계 변경 이벤트 ↔ 결정 기록 연결 (이슈 #58, view-changelog 3절 "이벤트 ↔ 결정 기록 연결" · 6절 2번, docs/types/README view-changelog 2번).
 *
 * 매칭 순서 — 명시 연결이 먼저, 없으면 같은 블록 + 시각 범위:
 * 1. `links.events`에 이벤트 ID (이전 실행에서 도구가 채운 것)
 * 2. `links.commits`에 이벤트 커밋 (7자리 이상 접두어)
 * 3. `links.packages` ↔ 의존성 이벤트의 패키지 · `links.services` ↔ 외부 시스템 이벤트의 ID/이름 · `links.rules` ↔ 규칙 이벤트의 규칙
 * 4. 결정의 `block`이 이벤트 `blocks`에 있고 결정 시각이 이벤트 시각 ±24h ({@link DECISION_LINK_WINDOW_MS})
 *
 * 결정 기록 본문의 문자열 일치로는 연결하지 않는다 (README view-dependencies 2번 "본문 일치만으로 사유 있음 판정은 오탐").
 *
 * `noReason` — 연결된 기록이 없으면 `no-record`, 전부 `이유`가 비어 있으면 `empty-reason`(`validateDecision` 재사용), 하나라도 이유가 있으면
 * `null`. 기각 · 감수가 빈 것은 "사유 없음"이 아니라 "기록 불완전"으로 따로 센다 (6절 3번). 어느 이벤트에도 연결되지 않은 기록은 고아 —
 * 지표에 들어가지 않는다 (5절 "결정 기록은 있는데 이벤트가 없다").
 */

import { validateDecision } from '../decisions/validate.js';
import type { ChangeEvent, DecisionId, DecisionRecord, Rule, RuleId, RuleStatus } from '../types/index.js';
import type { DetectedEvent } from './detect.js';

/** 블록 + 시각 매칭의 기본 창 — 결정 시각과 이벤트 커밋 시각의 차이 ±24h */
export const DECISION_LINK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LinkInput {
  events: DetectedEvent[];
  decisions: DecisionRecord[];
  /** 결정 기록이 가리키는 규칙이 실제로 있는가 (`linkedRules[].exists`) */
  rules: Rule[];
  /** 규칙 상태 (`linkedRules[].status`). 기록이 없으면 `null` */
  ruleStatus: ReadonlyMap<RuleId, RuleStatus>;
  windowMs?: number;
}

export interface LinkResult {
  events: ChangeEvent[];
  orphanDecisions: DecisionRecord[];
  /** 네 절 중 하나라도 빈 기록 수 (전체 기록 기준) */
  incompleteRecords: number;
}

function commitMatches(linked: string, commit: string): boolean {
  return linked.length >= 7 && commit.startsWith(linked);
}

/** 1~3번 — 명시 연결 */
export function matchesExplicitly(decision: DecisionRecord, event: DetectedEvent): boolean {
  if (decision.links.events.includes(event.id)) return true;
  if (decision.links.commits.some((c) => commitMatches(c, event.commit))) return true;
  const keys = event.keys;
  if ((keys.packages ?? []).some((pkg) => (decision.links.packages ?? []).includes(pkg))) return true;
  if ((keys.services ?? []).some((svc) => (decision.links.services ?? []).includes(svc))) return true;
  if ((keys.rules ?? []).some((rule) => decision.links.rules.includes(rule))) return true;
  return false;
}

/** 4번 — 같은 블록 + 시각 창. 시각을 못 읽으면 매칭하지 않는다 */
export function matchesByBlockAndTime(
  decision: DecisionRecord,
  event: DetectedEvent,
  windowMs = DECISION_LINK_WINDOW_MS,
): boolean {
  if (decision.block === undefined || !event.blocks.includes(decision.block)) return false;
  const decidedAt = Date.parse(decision.date);
  const eventAt = Date.parse(event.at);
  if (!Number.isFinite(decidedAt) || !Number.isFinite(eventAt)) return false;
  return Math.abs(decidedAt - eventAt) <= windowMs;
}

function noReasonOf(linked: DecisionRecord[]): ChangeEvent['noReason'] {
  if (linked.length === 0) return 'no-record';
  return linked.every((d) => validateDecision(d).noReason) ? 'empty-reason' : null;
}

function linkedRulesOf(linked: DecisionRecord[], input: LinkInput): ChangeEvent['linkedRules'] {
  const ids = [...new Set(linked.flatMap((d) => d.links.rules))].sort();
  return ids.map((ruleId) => ({
    ruleId,
    status: input.ruleStatus.get(ruleId) ?? null,
    exists: input.rules.some((rule) => rule.id === ruleId),
  }));
}

/** 이벤트마다 결정 기록을 붙이고 `noReason`을 판정한다. 결과 이벤트에는 `keys`가 없다 */
export function linkDecisions(input: LinkInput): LinkResult {
  const windowMs = input.windowMs ?? DECISION_LINK_WINDOW_MS;
  const used = new Set<DecisionId>();
  const events: ChangeEvent[] = input.events.map((detected) => {
    const { keys: _keys, ...rest } = detected;
    const linked = input.decisions.filter(
      (d) => matchesExplicitly(d, detected) || matchesByBlockAndTime(d, detected, windowMs),
    );
    for (const d of linked) used.add(d.id);
    return {
      ...rest,
      decisionIds: linked.map((d) => d.id).sort(),
      noReason: noReasonOf(linked),
      linkedRules: linkedRulesOf(linked, input),
    };
  });
  return {
    events,
    orphanDecisions: input.decisions.filter((d) => !used.has(d.id)),
    incompleteRecords: input.decisions.filter((d) => validateDecision(d).incomplete.length > 0).length,
  };
}
