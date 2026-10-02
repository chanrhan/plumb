/**
 * 코드 열람 기록 `code-opens.jsonl` (이슈 #60, screens/README 2.2, work-views 3절 "열람 횟수", 기획안 §3 · §15.3).
 *
 * View의 `file:line`을 눌러 IDE를 열 때마다 한 줄. **IDE 열기 실패도 남긴다** — 명제 검증에는 "보려 했다"가 중요하다
 * (work-views 6절 3번 → `result.status: 'failed'`). 이유 세 가지(`view-error` · `missing-info` · `debugging-env`)는 필수다 —
 * 이유 없는 기록은 받지 않는다 (README 2.2 "고르지 않으면 열리지 않는다").
 *
 * `view` · `item`은 공유 타입 `CodeOpenRecord`에서 필수지만, `plumb open <file>:<line>`은 View 밖(셸)에서도 부를 수 있어
 * 둘 다 선택으로 받는다. `item`이 없으면 `file:line` 라벨을 넣고, `view`가 없으면 키를 비운다 — 타입 보완 후보 (PR 본문).
 */

import { z } from 'zod';
import type { CodeOpenReason, CodeOpenRecord, ViewName } from '../types/index.js';
import { isViewName } from '../views/types.js';
import { ValidationError } from './errors.js';
import { appendJsonLine, readJsonLines } from './fs.js';
import type { StorePaths } from './paths.js';

export const CODE_OPEN_REASONS: readonly CodeOpenReason[] = ['view-error', 'missing-info', 'debugging-env'] as const;

export function isCodeOpenReason(value: unknown): value is CodeOpenReason {
  return typeof value === 'string' && (CODE_OPEN_REASONS as readonly string[]).includes(value);
}

/** 이유 → 화면 라벨 (work-views 2절 대화창) */
export const CODE_OPEN_REASON_LABEL: Record<CodeOpenReason, string> = {
  'view-error': 'View 오류',
  'missing-info': '정보 부족',
  'debugging-env': '디버깅·환경',
};

/** 이유 → 한 줄 설명 (work-views 2절 대화창) */
export const CODE_OPEN_REASON_HINT: Record<CodeOpenReason, string> = {
  'view-error': '이 View가 틀렸거나 빠졌다',
  'missing-info': 'View에 없는 것을 알아야 한다',
  'debugging-env': 'View와 무관한 작업',
};

export const codeOpenReasonSchema = z.enum(['view-error', 'missing-info', 'debugging-env']);

const codeOpenResultSchema = z.union([
  z.object({ status: z.literal('opened'), command: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal('failed'),
      command: z.string().min(1),
      exitCode: z.number().int().optional(),
      error: z.string(),
    })
    .strict(),
]);

/** 저장되는 한 줄. `view`가 선택인 것 외에는 `CodeOpenRecord`와 같다 */
export const codeOpenRecordSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    view: z.custom<ViewName>((value) => isViewName(value), { message: 'View 이름 여섯 개 중 하나' }).optional(),
    item: z.string().min(1),
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    reason: codeOpenReasonSchema,
    note: z.string().optional(),
    viewCommit: z.string().min(1).optional(),
    result: codeOpenResultSchema,
  })
  .strict();

/** `code-opens.jsonl` 한 줄. `CodeOpenRecord`에서 `view`만 선택 (셸에서 `plumb open`을 부른 경우) */
export type StoredCodeOpen = Omit<CodeOpenRecord, 'view'> & { view?: ViewName };

/** `append()` 입력. `at`은 저장소 시계로 채우고, `item`이 없으면 `file:line` */
export interface CodeOpenInput {
  view?: ViewName;
  item?: string;
  file: string;
  line?: number;
  reason: CodeOpenReason;
  note?: string;
  viewCommit?: string;
  result: CodeOpenRecord['result'];
}

/** 이유별 수. M10 명제 검증 화면의 원자료 — 지금은 CLI · API 요약에만 쓴다 */
export interface CodeOpenSummary {
  total: number;
  byReason: Record<CodeOpenReason, number>;
  byResult: { opened: number; failed: number };
}

export function anchorItemLabel(file: string, line: number | undefined): string {
  return line === undefined ? file : `${file}:${line}`;
}

/** 한 줄을 검증해 `code-opens.jsonl`에 덧붙인다. 이유가 없거나 모르는 값이면 {@link ValidationError} */
export async function appendCodeOpen(
  paths: StorePaths,
  input: CodeOpenInput,
  timing: { now?: () => Date } = {},
): Promise<StoredCodeOpen> {
  if (!isCodeOpenReason(input.reason)) {
    throw new ValidationError(
      `코드 열람 이유(reason)는 ${CODE_OPEN_REASONS.join(' · ')} 중 하나여야 한다 — 고르지 않으면 열리지 않는다`,
    );
  }
  if (typeof input.file !== 'string' || input.file.length === 0) {
    throw new ValidationError('코드 열람 기록에 file이 없다');
  }
  const candidate: Record<string, unknown> = {
    at: (timing.now ?? (() => new Date()))().toISOString(),
    item: input.item !== undefined && input.item.length > 0 ? input.item : anchorItemLabel(input.file, input.line),
    file: input.file,
    reason: input.reason,
    result: input.result,
  };
  if (input.view !== undefined) candidate.view = input.view;
  if (input.line !== undefined) candidate.line = input.line;
  if (input.note !== undefined && input.note.length > 0) candidate.note = input.note;
  if (input.viewCommit !== undefined) candidate.viewCommit = input.viewCommit;

  const parsed = codeOpenRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ValidationError('코드 열람 기록이 스키마에 맞지 않는다', parsed.error.issues);
  }
  await appendJsonLine(paths.codeOpens, parsed.data);
  return parsed.data as StoredCodeOpen;
}

/** 전부, 파일 순서(= 시각순). 파일이 없으면 빈 배열. 깨진 줄은 {@link ValidationError} — 조용히 건너뛰지 않는다 */
export async function listCodeOpens(paths: StorePaths): Promise<StoredCodeOpen[]> {
  const lines = await readJsonLines(paths.codeOpens);
  return lines.map((raw, index) => {
    const parsed = codeOpenRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        `${paths.codeOpens}:${index + 1}: 코드 열람 기록이 스키마에 맞지 않는다`,
        parsed.error.issues,
      );
    }
    return parsed.data as StoredCodeOpen;
  });
}

export function summarizeCodeOpens(records: readonly StoredCodeOpen[]): CodeOpenSummary {
  const summary: CodeOpenSummary = {
    total: records.length,
    byReason: { 'view-error': 0, 'missing-info': 0, 'debugging-env': 0 },
    byResult: { opened: 0, failed: 0 },
  };
  for (const record of records) {
    summary.byReason[record.reason] += 1;
    summary.byResult[record.result.status] += 1;
  }
  return summary;
}

/**
 * 이 View의 열람 수. `since`(ISO 시각, 보통 머리말 `generatedAt`)가 있으면 그 이후 기록만 — work-views 3절
 * "이 View · 이 생성 커밋 이후 레코드 수". 파일이 없으면 0 (5절 "열람 0회")
 */
export async function countCodeOpens(paths: StorePaths, view: ViewName, since?: string): Promise<number> {
  const records = await listCodeOpens(paths);
  return records.filter((record) => record.view === view && (since === undefined || record.at >= since)).length;
}
