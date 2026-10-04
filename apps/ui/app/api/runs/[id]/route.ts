import type { ApiError, RunDetailResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import {
  isRunId,
  isUnreadableRunFile,
  RETRY_AFTER_MS,
  type RunStateUnreadableBody,
  readRunState,
  unreadableBody,
} from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * `GET /api/runs/:id` — 진행 상황 = `runs/<id>.json` 그대로 (README 3.3, work-run 3.3). 출력 꼬리도 `capturedOutput`에 포함돼 있다.
 * 404 `run-not-found`(ID 꼴이 아니거나 파일 없음) · 503 `run-state-unreadable`(쓰는 도중 읽음: 찢긴 JSON · 모양 미완성 → 재시도). 쿠키 검사는 미들웨어
 */
export async function GET(
  _request: Request,
  { params }: Context,
): Promise<NextResponse<RunDetailResponse | ApiError | RunStateUnreadableBody>> {
  const { id } = await params;
  if (!isRunId(id)) return notFound(id);
  try {
    const state = await readRunState(id);
    if (state === undefined) return notFound(id);
    return NextResponse.json(state);
  } catch (error) {
    // 쓰는 도중 읽혀 찢긴 JSON · 모양 미완성 — 다음 폴링에서 다시
    if (isUnreadableRunFile(error)) {
      return NextResponse.json(unreadableBody(error), {
        status: 503,
        headers: { 'Retry-After': String(Math.ceil(RETRY_AFTER_MS / 1000)) },
      });
    }
    throw error;
  }
}

function notFound(id: string): NextResponse<ApiError> {
  return NextResponse.json<ApiError>(
    { status: 404, code: 'run-not-found', message: `실행 없음: ${id}` },
    { status: 404 },
  );
}
