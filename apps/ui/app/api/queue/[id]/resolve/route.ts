import type { ApiError, ResolveReviewItemResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import { parseResolveBody, resolveReviewQueueItem } from '@/lib/queue';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function apiError(error: ApiError): NextResponse<ApiError> {
  return NextResponse.json(error, { status: error.status });
}

/**
 * `POST /api/queue/:id/resolve` — `[처리]` (#120). 본문 `{ by?, note? }`(비어 있어도 된다). `resolvedAt`을 쓰고 **200** `{ item }`.
 * 404 `review-item-not-found` · 409 `review-item-resolved`(이미 처리됨 → 화면은 다시 읽는다) · 400 `invalid-body`.
 * 토큰 쿠키 검사는 미들웨어 — `/api/rules/:id/approve`와 같은 보호. 에이전트는 쿠키가 없어 처리할 수 없다 (기획안 §15.1)
 */
export async function POST(
  request: Request,
  { params }: Context,
): Promise<NextResponse<ResolveReviewItemResponse | ApiError>> {
  const { id } = await params;
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문이 JSON이 아니다' });
  }
  const body = parseResolveBody(raw);
  if ('status' in body) return apiError(body);

  const outcome = await resolveReviewQueueItem(id, body);
  if (outcome.kind === 'error') return apiError(outcome.error);
  return NextResponse.json<ResolveReviewItemResponse>(outcome.response);
}
