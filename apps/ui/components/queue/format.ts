import type { ReviewQueueItem } from '@plumb/core';

/**
 * 검토 대기열 여섯 종류의 라벨 (기획안 §9.2 · 이슈 #120). 클라이언트 번들에는 코어의 값을 넣지 않으므로 화면 쪽 복사본 —
 * `REVIEW_QUEUE_KINDS`(코어)와 키가 같아야 한다 (타입이 보장한다)
 */
export const QUEUE_KIND_LABEL: Record<ReviewQueueItem['kind'], string> = {
  dispute: '이의 제기',
  interpretation: '해석 불일치',
  'undetermined-injection': '미확정 주입',
  'run-failed': '실행 실패',
  'budget-exceeded': '예산 초과',
  'design-change': '설계 변경',
};

/** 와이어프레임의 `⚠` — 열린 항목 표시 */
export const OPEN_MARK = '⚠';

const pad = (n: number) => String(n).padStart(2, '0');

/** `10-02 14:10` (work-approve 2절 "이력: 제안 10-02 14:01"과 같은 꼴). 읽을 수 없는 값은 그대로 */
export function queueTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 머리줄: "열린 n건 · 처리됨 n건" */
export function queueHeadline(items: ReviewQueueItem[]): string {
  const open = items.filter((item) => item.resolvedAt === undefined).length;
  return `${OPEN_MARK} 열린 ${open}건 · 처리됨 ${items.length - open}건`;
}
