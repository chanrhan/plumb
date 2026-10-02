import type { ViewName } from '@plumb/core';

/**
 * `/views` 탭 목록. 라벨과 순서는 `docs/screens/README.md` 1절의 고정 목록이다 (데이터가 아니라 화면 구조).
 * `name` 은 코어의 `ViewName` 과 같은 값이어야 하므로 코어 타입으로 묶는다 — 빌드가 코어와 연결되는지 확인하는 용도도 겸한다.
 */
export const VIEW_TABS: ReadonlyArray<{ readonly name: ViewName; readonly label: string }> = [
  { name: 'architecture', label: '아키텍처' },
  { name: 'flow', label: '흐름도' },
  { name: 'changelog', label: '변경 로그' },
  { name: 'verification', label: '검증' },
  { name: 'dependencies', label: '의존성' },
  { name: 'contract', label: '계약' },
];

/** 기본 탭 (work-views 3절 "값이 없으면 `architecture`") */
export const DEFAULT_VIEW: ViewName = 'architecture';

export function isViewName(value: string): value is ViewName {
  return VIEW_TABS.some((tab) => tab.name === value);
}
