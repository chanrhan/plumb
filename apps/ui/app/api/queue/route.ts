import type { ReviewQueueResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import { readReviewQueue } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/queue` — 검토 대기열 전부 + 열린 수 (#120, 기획안 §9.2). 저장소: `review-queue/*.json`. 열린 것만 · 처리됨 보기는 화면이 거른다.
 * 쿠키 검사는 미들웨어가 먼저 한다 (없으면 401)
 */
export async function GET(): Promise<NextResponse<ReviewQueueResponse>> {
  return NextResponse.json(await readReviewQueue());
}
