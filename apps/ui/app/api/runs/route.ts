import { type ApiError, type CreateRunResponse, RULE_ID_PATTERN, type RuleId, type RunListResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import {
  isUnreadableRunFile,
  preconditionToApiError,
  RETRY_AFTER_MS,
  RunPreconditionFailed,
  RunSpawnError,
  type RunStateUnreadableBody,
  readRunList,
  startDetachedRun,
  unreadableBody,
} from '@/lib/runs';

export const dynamic = 'force-dynamic';

function apiError(error: ApiError): NextResponse<ApiError> {
  return NextResponse.json(error, { status: error.status });
}

/**
 * `GET /api/runs` — 실행 목록 (README 3.3, work-run 3.2). 저장소: `runs/*.json`. 쓰는 도중 읽어 찢긴 파일이 있으면 503
 * `run-state-unreadable` — 화면은 직전 목록을 유지한다. 쿠키 검사는 미들웨어가 먼저 한다
 */
export async function GET(): Promise<NextResponse<RunListResponse | RunStateUnreadableBody>> {
  try {
    return NextResponse.json(await readRunList());
  } catch (error) {
    if (isUnreadableRunFile(error)) {
      return NextResponse.json(unreadableBody(error), {
        status: 503,
        headers: { 'Retry-After': String(Math.ceil(RETRY_AFTER_MS / 1000)) },
      });
    }
    throw error;
  }
}

/** 본문 `{ ruleIds: RuleId[] }`. 비어 있거나 ID 꼴이 아니면 400 `invalid-body` */
async function parseBody(request: Request): Promise<RuleId[] | NextResponse<ApiError>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문이 JSON이 아니다' });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문은 객체여야 한다' });
  }
  const { ruleIds } = raw as { ruleIds?: unknown };
  if (!Array.isArray(ruleIds) || ruleIds.length === 0 || !ruleIds.every((id) => typeof id === 'string')) {
    return apiError({ status: 400, code: 'invalid-body', message: 'ruleIds는 비어 있지 않은 문자열 배열이어야 한다' });
  }
  const malformed = (ruleIds as string[]).find((id) => !RULE_ID_PATTERN.test(id));
  if (malformed !== undefined) {
    return apiError({ status: 400, code: 'invalid-body', message: `규칙 ID 꼴이 아니다: ${malformed}` });
  }
  return ruleIds as RuleId[];
}

/**
 * `POST /api/runs` — 파이프라인 시작 (work-run 4절 "새 실행", README 3.1). UI 서버가 `plumb run --rules … --detach --json`을 spawn하고
 * **201** `{ id }`만 돌려준다. 전제조건(미승인 400 `rule-not-approved` · 상한 없음 400 `no-budget` · 규칙 없음 404 · 동시 1개 409
 * `run-in-progress`)은 CLI 부모가 검사한 결과를 그대로 옮긴다. 프로세스를 못 띄우면 500 `spawn-failed`. 토큰 쿠키 없음 401은 미들웨어
 */
export async function POST(request: Request): Promise<NextResponse<CreateRunResponse | ApiError>> {
  const ruleIds = await parseBody(request);
  if (ruleIds instanceof NextResponse) return ruleIds;
  try {
    const started = await startDetachedRun(ruleIds);
    return NextResponse.json<CreateRunResponse>({ id: started.id }, { status: 201 });
  } catch (error) {
    if (error instanceof RunPreconditionFailed) return apiError(await preconditionToApiError(error, ruleIds));
    if (error instanceof RunSpawnError) {
      return apiError({ status: 500, code: 'spawn-failed', message: [error.message, ...error.stderrTail].join('\n') });
    }
    throw error;
  }
}
