import { type ApiError, ValidationError, type ViewResponse, ViewStoreError } from '@plumb/core';
import { NextResponse } from 'next/server';
import { isViewName, readViewResponse, VIEW_NAMES } from '@/lib/views';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ name: string }> };

/** 404 본문. `code`는 `view-not-found`, 두 경우를 `reason`으로 가른다 (탭 비활성 vs 생성기 미구현 안내) — `ApiError` 404 변형 그대로 (#63) */
export type ViewNotFoundBody = Extract<ApiError, { status: 404 }>;

/**
 * `GET /api/views/:name` — View 하나: 머리말 · Markdown(Mermaid 포함) · 정본 JSON · `stale`(HEAD와 다름) · 열람 수 (README 3.3, work-views 3절).
 * 404 `unknown-view`(여섯 이름이 아님) · 404 `not-generated`(`views/<name>.json` 없음 → 탭 비활성). JSON은 있는데 Markdown이 없으면 500 —
 * 반쪽을 그리지 않는다 (`plumb views`로 다시 생성). 쿠키 검사는 미들웨어가 먼저 한다.
 */
export async function GET(
  _request: Request,
  { params }: Context,
): Promise<NextResponse<ViewResponse | ViewNotFoundBody | ApiError>> {
  const { name } = await params;
  if (!isViewName(name)) {
    return NextResponse.json<ViewNotFoundBody>(
      {
        status: 404,
        code: 'view-not-found',
        reason: 'unknown-view',
        message: `그런 View 없음: ${name} (${VIEW_NAMES.join(' · ')} 중 하나)`,
      },
      { status: 404 },
    );
  }
  try {
    const response = await readViewResponse(name);
    if (response === null) {
      return NextResponse.json<ViewNotFoundBody>(
        {
          status: 404,
          code: 'view-not-found',
          reason: 'not-generated',
          message: `${name} View 아직 없음. plumb views로 만드세요`,
        },
        { status: 404 },
      );
    }
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof ViewStoreError || error instanceof ValidationError) {
      return NextResponse.json<ApiError>(
        { status: 500, code: 'store-write-failed', message: error.message },
        { status: 500 },
      );
    }
    throw error;
  }
}
