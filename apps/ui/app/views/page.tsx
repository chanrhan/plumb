import Link from 'next/link';
import { DEFAULT_VIEW, isViewName, VIEW_TABS } from '@/lib/core';

/**
 * View 보기 (`/views`). 탭 6개의 이름과 `?view=` 활성 표시만 있다 (work-views 3절 "M1 #9 (라우트만)").
 * 본문은 M8 에서 `GET /api/views/:name` 으로 채운다.
 */
export default async function ViewsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const requested = view ?? DEFAULT_VIEW;
  const active = isViewName(requested) ? requested : null;

  return (
    <>
      <ul className="tabs">
        {VIEW_TABS.map((tab) => (
          <li key={tab.name}>
            <Link href={`/views?view=${tab.name}`} aria-current={tab.name === active ? 'page' : undefined}>
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
      {active === null ? <p>그런 View 없음: {requested}</p> : <p>M8 에서 구현</p>}
    </>
  );
}
