import type { ApprovalState, RuleKind, RuleStatus } from '@plumb/core';

/** 목록의 종류 축약 (work-approve 3.1 "arch · tech · biz") */
export const KIND_SHORT: Record<RuleKind, string> = {
  architecture: 'arch',
  technical: 'tech',
  business: 'biz',
};

export const KIND_LABEL: Record<RuleKind, string> = {
  architecture: 'architecture',
  technical: 'technical',
  business: 'business',
};

/** 승인 상태 (잠정 · 승인 · 기각) */
export const APPROVAL_LABEL: Record<ApprovalState, string> = {
  provisional: '잠정',
  approved: '승인',
  rejected: '기각',
};

/** 상태 아이콘 다섯 가지 (기획안 §7.3). M3에서는 전부 ⬜ */
export const STATUS_ICON: Record<RuleStatus, string> = {
  'pass-verified': '🟢',
  'pass-unverified': '🟡',
  recheck: '🟠',
  fail: '🔴',
  unchecked: '⬜',
};

export const STATUS_LABEL: Record<RuleStatus, string> = {
  'pass-verified': '통과 · 유효',
  'pass-unverified': '통과',
  recheck: '재검사',
  fail: '실패',
  unchecked: '검사 없음',
};

/** 변경 종류 (기획안 §9.1). M3는 추가뿐 */
export const CHANGE_KIND_LABEL = {
  add: '추가',
  strengthen: '강화',
  relax: '완화',
  delete: '삭제',
  boundary: '블록 경계 변경',
} as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** `10-02 14:01` (work-approve 2절 "이력: 제안 10-02 14:01"). 읽을 수 없는 값은 그대로 */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
