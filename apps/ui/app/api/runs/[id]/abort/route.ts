import type { AbortRunResponse, ApiError } from '@plumb/core';
import { NextResponse } from 'next/server';
import { abortRun, isRunId } from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function apiError(error: ApiError): NextResponse<ApiError> {
  return NextResponse.json(error, { status: error.status });
}

/**
 * `POST /api/runs/:id/abort` — 본문 `{ confirm: true }`(확인 대화창을 거쳤음). UI 서버가 `runs/<id>.json`의 `pid`로 SIGTERM을 보내고
 * **202** `AbortRunResponse`. 실제 종료(`status: aborted`)는 `plumb run`이 파일에 쓰고 화면이 폴링으로 본다 (README 3.4, work-run 4절 "중단").
 * 404 `run-not-found` · 409 `run-finished`(이미 끝난 실행) · 400 `invalid-body`(confirm 없음). 쿠키 검사는 미들웨어
 */
export async function POST(request: Request, { params }: Context): Promise<NextResponse<AbortRunResponse | ApiError>> {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문이 JSON이 아니다' });
  }
  if (typeof raw !== 'object' || raw === null || (raw as { confirm?: unknown }).confirm !== true) {
    return apiError({ status: 400, code: 'invalid-body', message: '중단은 { confirm: true } 로만 요청한다' });
  }
  if (!isRunId(id)) return apiError({ status: 404, code: 'run-not-found', message: `실행 없음: ${id}` });

  const outcome = await abortRun(id);
  switch (outcome.kind) {
    case 'not-found':
      return apiError({ status: 404, code: 'run-not-found', message: `실행 없음: ${id}` });
    case 'finished':
      return apiError({
        status: 409,
        code: 'run-finished',
        message: `${id}은 이미 끝났다 (${outcome.state.status}${outcome.state.finishedAt ? ` · ${outcome.state.finishedAt}` : ''})`,
      });
    case 'requested':
      return NextResponse.json<AbortRunResponse>(outcome.response, { status: 202 });
  }
}
