import type { ViewName } from '@plumb/core';
import Link from 'next/link';
import { VIEW_TABS } from '@/lib/core';

export interface ViewTabsProps {
  active: ViewName | null;
  /** 저장소에 `views/<name>.json`이 있는 View. 없는 탭은 비활성 (work-views 3절 "탭 6개의 활성 여부") */
  generated: ReadonlySet<ViewName>;
  /** 현재 블록 필터. 탭을 바꿔도 유지된다 (4절 "탭 전환") */
  block?: string;
}

function hrefOf(name: ViewName, block: string | undefined): string {
  const params = new URLSearchParams({ view: name });
  if (block !== undefined && block.length > 0) params.set('block', block);
  return `/views?${params.toString()}`;
}

/**
 * 탭 6개 (README 1절 고정 목록 · 순서). 라벨과 순서는 데이터가 아니라 화면 구조다. 비활성 탭도 눌리지만 "아직 없음" 본문으로 간다.
 * 탭 줄 끝의 M10 자리(추적성 매트릭스 · 검토 대기열 · 규칙·계약 편집)는 비활성 항목만 둔다 (3절 마지막 행).
 */
export function ViewTabs({ active, generated, block }: ViewTabsProps) {
  return (
    <ul className="tabs view-tabs">
      {VIEW_TABS.map((tab) => {
        const ready = generated.has(tab.name);
        return (
          <li key={tab.name}>
            <Link
              href={hrefOf(tab.name, block)}
              aria-current={tab.name === active ? 'page' : undefined}
              aria-disabled={ready ? undefined : true}
              title={ready ? undefined : `${tab.name} View 아직 없음`}
              className={ready ? undefined : 'tab-missing'}
            >
              {tab.label}
            </Link>
          </li>
        );
      })}
      <li className="tab-spacer" aria-hidden="true" />
      <li className="tab-later" title="M10 (기획안 §6.4)">
        <span aria-disabled="true">추적성 매트릭스 · 검토 대기열 · 규칙·계약 편집 (M10)</span>
      </li>
    </ul>
  );
}
