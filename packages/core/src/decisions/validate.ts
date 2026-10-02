/**
 * 결정 기록 완전성 (view-changelog 6절 3번 기본값, docs/types/README view-changelog 3번).
 *
 * - "사유 없음(empty-reason)" 판정은 `이유`만 본다 — §14 지표 정의가 "사유 없는" 이므로
 * - 기각 · 감수 · 결정이 비면 "사유 없음"이 아니라 "기록 불완전". 불완전 수는 따로 센다 (`ChangelogView.incompleteRecords`)
 * - 결정 기록은 규범이 아니며 검사 대상도 아니다 (§7.2 3등급). 이 판정은 규칙 상태를 바꾸지 못한다
 */

import type { DecisionRecord } from '../types/index.js';
import { DECISION_SECTIONS, type DecisionSection, SECTION_FIELDS } from './format.js';

export interface DecisionValidation {
  /** 비어 있는 절. 네 절 순서대로. 하나라도 있으면 "기록 불완전" */
  incomplete: DecisionSection[];
  /** `이유`가 비어 있다 → 연결된 이벤트는 "사유 없음(empty-reason)" */
  noReason: boolean;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

export function validateDecision(record: DecisionRecord): DecisionValidation {
  const incomplete = DECISION_SECTIONS.filter((section) => isBlank(record[SECTION_FIELDS[section]]));
  return { incomplete, noReason: isBlank(record.reason) };
}
