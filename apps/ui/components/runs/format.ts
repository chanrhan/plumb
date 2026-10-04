import type { RunOutcome, RunStatus, Stage } from '@plumb/core';

/** 상태 다섯 가지 (work-run 3.2 "상태"). CLI `plumb runs list`와 같은 라벨 */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: '진행중',
  completed: '완료',
  failed: '실패',
  'budget-exceeded': '예산초과',
  aborted: '중단',
};

export const STAGES: readonly Stage[] = [1, 2, 3, 4, 5, 6];

/** ①~⑥ (기획안 §8.3) */
export const STAGE_MARK: Record<Stage, string> = { 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤', 6: '⑥' };

export const STAGE_LABEL: Record<Stage, string> = {
  1: '승인',
  2: '테스트 작성',
  3: '구현',
  4: '전체 검사',
  5: '위반 주입',
  6: 'View 갱신',
};

/** 이의 제기 상태 (work-run 4절: 판정은 M10, 여기서는 "검토 대기열에 올라감"만) */
export const DISPUTE_STATUS_LABEL = {
  reviewing: '재검토 중',
  resolved: '재검토 끝',
  queued: '검토 대기열에 올라감',
} as const;

/** 실패 사유 한 줄 (work-run 2절 "종료된 실행의 마지막 줄") */
export const FAIL_REASON_LABEL: Record<Extract<RunOutcome, { status: 'failed' }>['reason'], string> = {
  stopBlockLimit: '종료 차단 연속 상한 (stopBlockLimit)',
  maxTurns: '반복 상한 (maxTurns)',
  'stage-2-not-all-failed': '구현 전인데 통과하는 테스트 (stage-2-not-all-failed)',
  'runner-error': '러너 실패 (runner-error)',
  'spawn-error': '프로세스 시작 실패 (spawn-error)',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** `14:03`. 읽을 수 없는 값은 그대로 */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 목록의 시작 열: 오늘이면 시각만, 아니면 날짜 (work-run 3.2). `now`가 없으면(서버 · 테스트) 날짜 + 시각 */
export function startedLabel(iso: string, now: number | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (now === null) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(iso)}`;
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? clock(iso) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `12:34` 또는 `1:02:03` */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** `(28분)` — 종료 줄의 소요 시간. 1분 미만은 초 */
export function durationLabel(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (Number.isNaN(ms)) return '';
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${minutes}분` : `${Math.max(0, Math.round(ms / 1000))}초`;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
