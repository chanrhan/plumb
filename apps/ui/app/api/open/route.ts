import {
  type ApiError,
  type CodeOpenInput,
  type CodeOpenReason,
  type CodeOpenRecord,
  type CodeOpenResponse,
  isCodeOpenReason,
  openInIde,
  ValidationError,
  type ViewName,
} from '@plumb/core';
import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/rules';
import { getStore, getTarget } from '@/lib/store';
import { isViewName, VIEW_NAMES } from '@/lib/views';

export const dynamic = 'force-dynamic';

function apiError(error: ApiError): NextResponse<ApiError> {
  return NextResponse.json(error, { status: error.status });
}

interface ParsedOpen {
  file: string;
  line?: number;
  reason: CodeOpenReason;
  view?: ViewName;
  item?: string;
  note?: string;
}

/** 본문 검사. 이유가 없으면 400 `reason-required` — 저장소를 열기 전에 돌려준다 (README 2.2 "고르지 않으면 열리지 않는다") */
async function parseBody(request: Request): Promise<ParsedOpen | NextResponse<ApiError>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문이 JSON이 아니다' });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문은 객체여야 한다' });
  }
  const { file, line, reason, view, item, note } = raw as Record<string, unknown>;
  if (!isCodeOpenReason(reason)) {
    return apiError({
      status: 400,
      code: 'reason-required',
      message: '코드를 열려면 이유(reason)를 골라야 한다: view-error · missing-info · debugging-env',
    });
  }
  if (typeof file !== 'string' || file.trim().length === 0) {
    return apiError({ status: 400, code: 'invalid-body', message: 'file이 없다' });
  }
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    return apiError({ status: 400, code: 'invalid-body', message: 'line은 1 이상의 정수여야 한다' });
  }
  if (view !== undefined && !isViewName(view)) {
    return apiError({
      status: 400,
      code: 'invalid-body',
      message: `그런 View 없음: ${String(view)} (${VIEW_NAMES.join(' · ')} 중 하나)`,
    });
  }
  if (item !== undefined && typeof item !== 'string') {
    return apiError({ status: 400, code: 'invalid-body', message: 'item은 문자열이어야 한다' });
  }
  if (note !== undefined && typeof note !== 'string') {
    return apiError({ status: 400, code: 'invalid-body', message: 'note는 문자열이어야 한다' });
  }
  return {
    file: file.trim(),
    reason,
    ...(line === undefined ? {} : { line: line as number }),
    ...(view === undefined ? {} : { view: view as ViewName }),
    ...(item === undefined || item.length === 0 ? {} : { item }),
    ...(note === undefined || note.trim().length === 0 ? {} : { note: note.trim() }),
  };
}

/**
 * `POST /api/open` — 코드 열람 점프 + 이유 기록 (README 2.2 · 3.3, work-views 4절, 기획안 §3 · §15.3).
 * `config.ide`(기본 `code --goto {file}:{line}`)를 셸 없이 띄우고, 성공 · 실패와 무관하게 `code-opens.jsonl`에 한 줄 남긴 뒤 200.
 * IDE 명령 실패는 `record.result.status: 'failed'` — 화면은 "IDE를 열지 못함: <명령>" (work-views 6절 3번). 400 이유 없음.
 */
export async function POST(request: Request): Promise<NextResponse<CodeOpenResponse | ApiError>> {
  const body = await parseBody(request);
  if (body instanceof NextResponse) return body;

  const [store, config] = await Promise.all([getStore(), getConfig()]);

  let viewCommit: string | undefined;
  if (body.view !== undefined) {
    const stored = await store.views.read(body.view).catch(() => null);
    viewCommit = stored?.view.header.commit;
  }

  const result = await openInIde(
    { file: body.file, ...(body.line === undefined ? {} : { line: body.line }) },
    { ...(config.ide === undefined ? {} : { template: config.ide }), cwd: getTarget() },
  );

  const input: CodeOpenInput = {
    file: body.file,
    reason: body.reason,
    result,
    ...(body.line === undefined ? {} : { line: body.line }),
    ...(body.view === undefined ? {} : { view: body.view }),
    ...(body.item === undefined ? {} : { item: body.item }),
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(viewCommit === undefined ? {} : { viewCommit }),
  };
  try {
    const record = await store.codeOpens.append(input);
    const codeOpens =
      body.view === undefined
        ? 0
        : await store.codeOpens.count(body.view, (await store.views.read(body.view))?.view.header.generatedAt);
    // `view`가 없는 기록은 공유 타입(`CodeOpenRecord.view` 필수)보다 느슨하다 — 타입 보완 후보 (PR 본문)
    return NextResponse.json<CodeOpenResponse>({ record: record as CodeOpenRecord, codeOpens });
  } catch (error) {
    if (error instanceof ValidationError) {
      return apiError({ status: 400, code: 'invalid-body', message: error.message });
    }
    throw error;
  }
}
