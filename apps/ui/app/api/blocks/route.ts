import { type ApiError, type BlocksResponse, ValidationError, ViewStoreError } from '@plumb/core';
import { NextResponse } from 'next/server';
import { readBlocksResponse } from '@/lib/blocks';
import { fromStoreError } from '@/lib/rules-api';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/blocks` — 블록 트리 (README 2절 · 3.3, compare C-05 · C-06 · C-07). 응답은 `types/api.ts`의 {@link BlocksResponse} 그대로:
 * 블록마다 `rules`(규칙 수) · `worstStatus`(최악 상태 점, 규칙 없으면 `null`), 맨 아래 `unclassified`, 그래프 없으면 `empty: 'no-graph'`.
 * 쿠키 검사는 `middleware.ts`가 먼저 한다 — 여기 도달했으면 세션이 있다. 아키텍처 View JSON이 반쪽이면 500 (반쪽을 그리지 않는다).
 */
export async function GET(): Promise<NextResponse<BlocksResponse | ApiError>> {
  try {
    return NextResponse.json(await readBlocksResponse());
  } catch (error) {
    if (error instanceof ViewStoreError || error instanceof ValidationError) {
      return NextResponse.json<ApiError>(
        { status: 500, code: 'store-write-failed', message: error.message },
        { status: 500 },
      );
    }
    return fromStoreError(error);
  }
}
