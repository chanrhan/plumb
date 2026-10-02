import type { CodeOpenReason, ViewName } from '@plumb/core';

/**
 * 클라이언트 컴포넌트가 쓰는 상수 (이슈 #60). `@plumb/core`의 값(`CODE_OPEN_REASON_LABEL` 등)과 같지만, 코어 모듈은 node 전용
 * import(`child_process` · `fs`)를 끌고 오므로 클라이언트 번들에 넣지 않는다 — 타입만 가져온다.
 */

/** 이유 세 가지 (work-views 2절 대화창 · README 2.2). 순서 = 대화창 라디오 순서 */
export const REASON_OPTIONS: ReadonlyArray<{ value: CodeOpenReason; label: string; hint: string }> = [
  { value: 'view-error', label: 'View 오류', hint: '이 View가 틀렸거나 빠졌다' },
  { value: 'missing-info', label: '정보 부족', hint: 'View에 없는 것을 알아야 한다' },
  { value: 'debugging-env', label: '디버깅·환경', hint: 'View와 무관한 작업' },
];

/** `plumb://open?file=…&line=…` (코어 `views/markdown.ts`의 `PLUMB_OPEN_SCHEME`). UI가 가로채 이유 대화창으로 바꾼다 */
export const PLUMB_OPEN_PREFIX = 'plumb://open?';

export interface OpenTarget {
  file: string;
  line?: number;
  /** 대화창 머리 · 기록의 `item` 기본값 */
  label: string;
}

/** 코어 `parseAnchorUrl`과 같은 규칙. 다른 스킴 · `file` 없음 · 잘못된 줄이면 `null` */
export function parseOpenHref(href: string | undefined): OpenTarget | null {
  if (href === undefined || !href.startsWith(PLUMB_OPEN_PREFIX)) return null;
  const params = new URLSearchParams(href.slice(PLUMB_OPEN_PREFIX.length));
  const file = params.get('file');
  if (file === null || file.length === 0) return null;
  const line = params.get('line');
  if (line !== null && !/^\d+$/.test(line)) return null;
  const target: OpenTarget = { file, label: line === null ? file : `${file}:${line}` };
  if (line !== null) target.line = Number(line);
  return target;
}

export type { ViewName };
