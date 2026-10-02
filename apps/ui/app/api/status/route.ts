import { type StatusResponse, toStatusResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/status` — 상단 바 (`docs/screens/README.md` 2절 표, 3.3). 응답은 `types/api.ts`의 {@link StatusResponse} 그대로.
 * 쿠키 검사는 `middleware.ts`가 먼저 한다 — 여기 도달했으면 세션이 있다.
 */
export async function GET(): Promise<NextResponse<StatusResponse>> {
  const store = await getStore();
  return NextResponse.json(toStatusResponse(await store.status()));
}
