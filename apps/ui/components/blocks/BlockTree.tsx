import type { BlocksResponse } from '@plumb/core';
import Link from 'next/link';
import { STATUS_ICON, STATUS_LABEL } from '@/components/rules/format';

/** 규칙이 없거나 상태 기록이 없는 블록의 점 (`worstStatus: null`) */
export const NO_STATUS_ICON = '⬜';
export const NO_STATUS_LABEL = '규칙 없음 · 검사 없음';

/** 사이드바에 보이는 블록 한 줄의 글자 — 상태 점 · 이름 · 규칙 수 (`payment 🟢 1`) */
export function blockLineText(block: BlocksResponse['blocks'][number]): string {
  const dot = block.worstStatus === null ? NO_STATUS_ICON : STATUS_ICON[block.worstStatus];
  return `${block.id} ${dot} ${block.rules ?? 0}`;
}

/** 블록을 누르면 `/rules`가 그 블록으로 걸러진다 (필터는 이미 URL 쿼리 `?block=`을 받는다 — work-approve 6절 5번) */
export function blockHref(id: string): string {
  return `/rules?block=${encodeURIComponent(id)}`;
}

/**
 * 블록 트리 (README 2절 공통 레이아웃, compare C-05 · C-06 · C-07). 블록마다 상태 점(그 블록 규칙들의 최악 상태) · 이름 · 규칙 수,
 * 맨 아래 미분류 파일 수(항상 보인다, 0이어도). 아키텍처 View JSON이 아직 없으면 "블록 아직 없음" — 미분류를 0이라고 쓰지 않는다.
 * L0/L1 토글은 M10-11.
 */
export function BlockTree({ data }: { data: BlocksResponse }) {
  if (data.empty === 'no-graph') {
    return (
      <>
        <p>블록 아직 없음</p>
        <p>
          <small>블록 그래프 없음 — plumb views로 아키텍처 View를 만들면 채워진다</small>
        </p>
      </>
    );
  }
  return (
    <>
      {data.blocks.length === 0 ? <p>선언된 블록 없음 — plumb.config.json blocks</p> : null}
      <ul className="block-tree">
        {data.blocks.map((block) => {
          const label = block.worstStatus === null ? NO_STATUS_LABEL : STATUS_LABEL[block.worstStatus];
          const rules = block.rules ?? 0;
          return (
            <li key={block.id}>
              <Link href={blockHref(block.id)} title={`${block.id} · ${label} · 규칙 ${rules}`}>
                <span role="img" aria-label={label}>
                  {block.worstStatus === null ? NO_STATUS_ICON : STATUS_ICON[block.worstStatus]}
                </span>{' '}
                {block.id} <small>{rules}</small>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="block-tree-unclassified" title="어느 블록 글롭에도 안 맞는 파일 수">
        미분류 {data.unclassified}
        {data.unclassified > 0 ? ' ▲' : ''}
      </p>
    </>
  );
}
