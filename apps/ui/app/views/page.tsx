import {
  formatSource,
  shortCommit,
  type ViewListItem,
  type ViewName,
  type ViewResponse,
  ViewStoreError,
} from '@plumb/core';
import Link from 'next/link';
import { shortTime } from '@/components/rules/format';
import { RegenerateButton } from '@/components/views/RegenerateButton';
import { ViewBody } from '@/components/views/ViewBody';
import { ViewTabs } from '@/components/views/ViewTabs';
import { DEFAULT_VIEW, isViewName } from '@/lib/core';
import { listGeneratedViews, readViewResponse, VIEW_PLANNED_IN } from '@/lib/views';

export const dynamic = 'force-dynamic';

type Query = { view?: string | string[]; block?: string | string[] };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * View 보기 (`/views`, work-views 전체). 서버 컴포넌트 — `store.views.read()`를 직접 읽는다 (README 3.1). 목 데이터 없음.
 *
 * 탭 6개(`?view=`, 기본 `architecture`) · 블록 필터 칩(`?block=`, M10까지 비활성 — 본문에 블록 태그 메타가 아직 없다) ·
 * 생성 출처 표시줄(머리말 `sources[]` → README 2.1 접두어) · 열람 횟수 · `[재생성]` · 본문(클라이언트 `ViewBody`: Markdown · Mermaid ·
 * `file:line` 점프) · 하단 생성 커밋 · 시각 + HEAD와 다르면 `⚠ HEAD와 다름`. 비어 있을 때 문구는 5절.
 */
export default async function ViewsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const requested = first(query.view) ?? DEFAULT_VIEW;
  const block = first(query.block);
  const active = isViewName(requested) ? requested : null;

  let generatedList: ViewListItem[] = [];
  let storeError: string | null = null;
  try {
    generatedList = await listGeneratedViews();
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error);
  }
  const generated = new Set<ViewName>(generatedList.map((item) => item.name));

  const tabs = <ViewTabs active={active} generated={generated} block={block} />;
  const chips = <BlockFilter block={block} view={active ?? DEFAULT_VIEW} />;

  if (storeError !== null) {
    return (
      <section className="view-screen">
        {tabs}
        <p role="alert">보호 저장소를 읽지 못함: {storeError}</p>
      </section>
    );
  }

  if (active === null) {
    return (
      <section className="view-screen">
        {tabs}
        <p>그런 View 없음: {requested}</p>
      </section>
    );
  }

  let response: ViewResponse | null;
  try {
    response = await readViewResponse(active);
  } catch (error) {
    if (error instanceof ViewStoreError) {
      return (
        <section className="view-screen">
          {tabs}
          {chips}
          <p role="alert">
            <code>{active}</code> View 파일이 반쪽이다: {error.message}
          </p>
          <RegenerateButton names={[active]} label="다시 생성" />
        </section>
      );
    }
    throw error;
  }

  if (response === null) {
    return (
      <section className="view-screen">
        {tabs}
        {chips}
        <EmptyView name={active} anyGenerated={generated.size > 0} />
        <footer className="view-foot">
          <span>마지막 생성: —</span>
        </footer>
      </section>
    );
  }

  const { header, markdown, stale, codeOpens } = response;

  return (
    <section className="view-screen">
      {tabs}
      <div className="view-head">
        {chips}
        <p className="view-sourcebar">
          생성 출처: {header.sources.length === 0 ? '없음' : header.sources.map((ref) => formatSource(ref)).join(' · ')}
          {' · '}열람 {codeOpens}회
        </p>
        <RegenerateButton names={[active]} />
      </div>

      <ViewBody view={active} markdown={markdown} />

      <footer className="view-foot">
        <span>
          마지막 생성: {header.commit === undefined ? '생성 커밋 기록 없음' : shortCommit(header.commit)} ·{' '}
          {shortTime(header.generatedAt)}
        </span>
        {stale === undefined ? null : (
          <span role="status" className="view-stale">
            ⚠ HEAD({shortCommit(stale.head)})와 다름 — <code>plumb views</code>로 갱신
          </span>
        )}
      </footer>
    </section>
  );
}

/**
 * 블록 필터 칩 (3절 "블록 필터"). 본문 Markdown에 항목별 블록 태그 메타가 아직 없어 **필터 적용은 M10** — 칩은 비활성으로 두고
 * 쿼리만 유지 · 해제한다. 필터가 없으면 칩 없음.
 */
function BlockFilter({ block, view }: { block: string | undefined; view: ViewName }) {
  if (block === undefined || block.length === 0) return null;
  return (
    <p className="view-filter">
      필터:{' '}
      <span className="chip" aria-disabled="true" title="본문 필터 적용은 M10 (항목별 블록 태그 메타 미도입)">
        {block}{' '}
        <Link href={`/views?view=${view}`} aria-label={`필터 ${block} 해제`}>
          ×
        </Link>
      </span>{' '}
      <small>(본문 적용은 M10)</small>
    </p>
  );
}

/** 5절 "비어 있을 때" */
function EmptyView({ name, anyGenerated }: { name: ViewName; anyGenerated: boolean }) {
  const planned = VIEW_PLANNED_IN[name];
  if (planned !== undefined) {
    return (
      <p className="view-empty">
        <code>{name}</code> View 아직 없음 — {planned} 에서 구현
      </p>
    );
  }
  if (!anyGenerated) {
    return (
      <>
        <p className="view-empty">
          아직 생성된 View 없음. <code>plumb views</code> 를 실행하면 파서 출력에서 만들어집니다
        </p>
        <RegenerateButton label="plumb views 실행" />
      </>
    );
  }
  return (
    <>
      <p className="view-empty">
        <code>{name}</code> View 아직 없음. <code>plumb views</code>로 만드세요
      </p>
      <RegenerateButton names={[name]} label={`plumb views ${name}`} />
    </>
  );
}
