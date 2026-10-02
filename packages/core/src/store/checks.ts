/**
 * 검사 실행 기록 `checks/<c-id>.json` (이슈 #46, docs/types/README "상태 기록은 두 곳" — 이 파일이 입력이자 진실).
 * `plumb check`(#47)가 한 번 돌 때마다 하나 쓴다. 원자적 쓰기 (`fs.ts`). 이력(`RuleStatusRecord.history`)과
 * `status().lastCheck`는 이 파일들을 시각순으로 읽은 것이다.
 */

import { z } from 'zod';
import type { CheckFailure, CheckResult, CheckRun, CheckRunId, Quarantine } from '../types/index.js';
import { ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';
import { checkRefSchema, ruleIdSchema } from './rules.js';

/** 검사 실행 ID `c-…` (`types/rules.ts` `CheckRunId`) */
export const CHECK_RUN_ID_PATTERN = /^c-[\w-]+$/;

export const checkRunIdSchema = z.custom<CheckRunId>(
  (value) => typeof value === 'string' && CHECK_RUN_ID_PATTERN.test(value),
  { message: '검사 실행 ID는 c-… 형식' },
);

export const anchorSchema = z
  .object({
    block: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();

export const checkFailureSchema = z
  .object({
    check: checkRefSchema,
    anchor: anchorSchema,
    message: z.string(),
    counterexample: z.string().optional(),
    seed: z.string().optional(),
  })
  .strict() satisfies z.ZodType<CheckFailure, z.ZodTypeDef, unknown>;

export const checkResultSchema = z
  .object({
    check: checkRefSchema,
    ruleIds: z.array(ruleIdSchema),
    outcome: z.enum(['pass', 'fail', 'error', 'skipped']),
    durationSec: z.number().nonnegative().optional(),
    failure: checkFailureSchema.optional(),
  })
  .strict() satisfies z.ZodType<CheckResult, z.ZodTypeDef, unknown>;

export const quarantineSchema = z
  .object({
    ref: z.string().min(1),
    passes: z.number().int().nonnegative(),
    runs: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<Quarantine, z.ZodTypeDef, unknown>;

export const checkRunSchema = z
  .object({
    runId: checkRunIdSchema,
    commit: z.string(),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    runner: z.object({ exitCode: z.number().int(), stderrTail: z.array(z.string()).optional() }).strict(),
    results: z.array(checkResultSchema),
    quarantined: z.array(quarantineSchema),
    counts: z.object({ junit: z.number().int().nonnegative(), static: z.number().int().nonnegative() }).strict(),
    storeStatus: z.enum(['ok', 'tampered', 'unverified']),
    metrics: z
      .object({ noReasonEvents: z.number().int().nonnegative(), totalEvents: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<CheckRun, z.ZodTypeDef, unknown>;

function parseCheckRun(raw: unknown, where: string): CheckRun {
  const result = checkRunSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: 검사 실행 기록이 스키마에 맞지 않는다`, result.error.issues);
  }
  return result.data;
}

/** 시각순 비교: `finishedAt`, 같으면 `runId` */
function byFinishedAt(a: CheckRun, b: CheckRun): number {
  const diff = a.finishedAt.localeCompare(b.finishedAt);
  return diff !== 0 ? diff : a.runId.localeCompare(b.runId);
}

/** `checks/<runId>.json` 원자적 쓰기. 입력은 검증된다 — 모양이 어긋나면 {@link ValidationError} */
export async function writeCheckRun(paths: StorePaths, run: CheckRun | unknown): Promise<CheckRun> {
  const parsed = parseCheckRun(run, 'checks.write');
  await writeJsonAtomic(paths.check(parsed.runId), parsed);
  return parsed;
}

/** `checks/*.json` 전부, 시각순(오래된 것부터). 폴더가 없으면 빈 배열 */
export async function listCheckRuns(paths: StorePaths): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const file of await listFiles(paths.checksDir, '.json')) {
    const path = `${paths.checksDir}/${file}`;
    const raw = await readJsonFile(path);
    if (raw !== undefined) runs.push(parseCheckRun(raw, path));
  }
  return runs.sort(byFinishedAt);
}

/** 가장 최근 `finishedAt`의 실행. 없으면 null */
export async function latestCheckRun(paths: StorePaths): Promise<CheckRun | null> {
  const runs = await listCheckRuns(paths);
  return runs.length === 0 ? null : (runs[runs.length - 1] ?? null);
}
