import type { ApiError, RegenerateViewsResponse, ViewName } from '@plumb/core';
import { NextResponse } from 'next/server';
import {
  isViewName,
  RegenerateInProgressError,
  type RegenerateOutcome,
  RegenerateSpawnError,
  regenerateViews,
  VIEW_NAMES,
} from '@/lib/views';

export const dynamic = 'force-dynamic';

/** 200 본문. 공유 타입 `RegenerateViewsResponse`(`started: true` · `names`)에 **끝난 결과**를 더했다 — 동기적으로 기다리므로 (타입 보완 후보) */
export type RegenerateRouteResponse = RegenerateViewsResponse & Omit<RegenerateOutcome, 'names'>;

function apiError(error: ApiError): NextResponse<ApiError> {
  return NextResponse.json(error, { status: error.status });
}

/**
 * `POST /api/views/regenerate` — 본문 `{ names?: ViewName[] }`(비우면 전부). `plumb views <names> --json`을 자식 프로세스로 띄우고
 * **끝날 때까지 기다린다**(5분, `lib/views.ts`). 진행 중이면 409 `regenerate-in-progress` · 알 수 없는 이름 404 · 프로세스 실패 500 `spawn-failed`.
 * 생성기 하나가 실패한 것은 오류가 아니라 `views[]` 행에 보인다 (화면이 표로 그린다).
 */
export async function POST(request: Request): Promise<NextResponse<RegenerateRouteResponse | ApiError>> {
  let names: ViewName[] = [];
  const text = await request.text();
  if (text.trim().length > 0) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError({ status: 400, code: 'invalid-body', message: '요청 본문이 JSON이 아니다' });
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return apiError({ status: 400, code: 'invalid-body', message: '요청 본문은 객체여야 한다' });
    }
    const candidate = (raw as { names?: unknown }).names;
    if (candidate !== undefined) {
      if (!Array.isArray(candidate) || !candidate.every((n) => typeof n === 'string')) {
        return apiError({ status: 400, code: 'invalid-body', message: 'names는 문자열 배열이어야 한다' });
      }
      const unknown = (candidate as string[]).find((n) => !isViewName(n));
      if (unknown !== undefined) {
        return apiError({
          status: 404,
          code: 'view-not-found',
          message: `그런 View 없음: ${unknown} (${VIEW_NAMES.join(' · ')} 중 하나)`,
        });
      }
      names = candidate as ViewName[];
    }
  }

  try {
    const outcome = await regenerateViews(names);
    const { names: _names, ...rest } = outcome;
    return NextResponse.json<RegenerateRouteResponse>({ started: true, names, ...rest });
  } catch (error) {
    if (error instanceof RegenerateInProgressError) {
      return apiError({ status: 409, code: 'regenerate-in-progress', message: error.message });
    }
    if (error instanceof RegenerateSpawnError) {
      return apiError({
        status: 500,
        code: 'spawn-failed',
        message: [error.message, ...error.stderrTail].join('\n'),
      });
    }
    throw error;
  }
}
