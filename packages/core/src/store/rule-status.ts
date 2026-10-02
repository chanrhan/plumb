/**
 * 규칙별 상태 기록 `rule-status/<ruleId>.json` (이슈 #46, docs/types/README "상태 기록은 두 곳" — `checks/`가 입력, 이것이 출력).
 * `plumb check`(#47)가 `computeRuleStatuses()` 결과를 쓰고, `rule list` · UI `/rules`의 상태 열이 읽는다.
 * 규칙당 파일 하나, 원자적 쓰기. 🔴 `fail`은 `failures`가 비어 있지 않을 때만 받는다 — 저장소도 추정 🔴를 거부한다.
 */

import { z } from 'zod';
import type { RuleId, RuleStatusDetail, RuleStatusRecord } from '../types/index.js';
import { checkFailureSchema } from './checks.js';
import { ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';
import { ruleIdSchema } from './rules.js';

export const ruleStatusSchema = z.enum(['pass-verified', 'pass-unverified', 'recheck', 'fail', 'unchecked']);

/**
 * `RuleStatusDetail`. `fail`의 `failures`는 `nonempty()`. `pass-verified` · `recheck`의 선택 필드(유효성 · 대기열)는 M6 · M7에서
 * 스키마에 들어온다 — 지금은 `plumb check`가 만들지 않으므로 받지 않는다 (strict).
 */
export const ruleStatusDetailSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('fail'), failures: z.array(checkFailureSchema).nonempty() }).strict(),
  z
    .object({ status: z.literal('pass-verified'), reason: z.enum(['passed-and-injection-valid', 'static-proof']) })
    .strict(),
  z.object({ status: z.literal('pass-unverified'), reason: z.enum(['no-injection', 'injection-invalid']) }).strict(),
  z
    .object({
      status: z.literal('recheck'),
      reason: z.enum(['check-file-changed', 'interpretation-dispute']),
      changedFiles: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unchecked'),
      reason: z.enum(['no-checks', 'check-missing', 'unapproved', 'quarantined', 'not-run']),
    })
    .strict(),
]) satisfies z.ZodType<RuleStatusDetail, z.ZodTypeDef, unknown>;

export const ruleStatusRecordSchema = z
  .object({
    ruleId: ruleIdSchema,
    detail: ruleStatusDetailSchema,
    since: z.string().datetime({ offset: true }),
    commit: z.string(),
    checkedAt: z.string().datetime({ offset: true }),
    history: z.array(ruleStatusSchema),
  })
  .strict() satisfies z.ZodType<RuleStatusRecord, z.ZodTypeDef, unknown>;

function parseRecord(raw: unknown, where: string): RuleStatusRecord {
  const result = ruleStatusRecordSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: 규칙 상태 기록이 스키마에 맞지 않는다`, result.error.issues);
  }
  return result.data;
}

/** 규칙별 파일을 각각 원자적으로 쓴다. 전부 검증한 뒤에 쓰므로 하나라도 어긋나면 아무것도 쓰지 않는다 */
export async function writeRuleStatuses(
  paths: StorePaths,
  records: RuleStatusRecord[] | unknown[],
): Promise<RuleStatusRecord[]> {
  const parsed = records.map((record, index) => parseRecord(record, `ruleStatus.write[${index}]`));
  for (const record of parsed) {
    await writeJsonAtomic(paths.ruleStatus(record.ruleId), record);
  }
  return parsed;
}

/** `rule-status/<ruleId>.json`. 없으면 `undefined` (아직 `plumb check`가 돌지 않았다 → 화면은 ⬜ not-run) */
export async function getRuleStatus(paths: StorePaths, ruleId: RuleId): Promise<RuleStatusRecord | undefined> {
  const path = paths.ruleStatus(ruleId);
  const raw = await readJsonFile(path);
  return raw === undefined ? undefined : parseRecord(raw, path);
}

/** 모든 규칙의 상태 기록 (규칙 ID 순). 폴더가 없으면 빈 배열 */
export async function listRuleStatuses(paths: StorePaths): Promise<RuleStatusRecord[]> {
  const records: RuleStatusRecord[] = [];
  for (const file of await listFiles(paths.ruleStatusDir, '.json')) {
    const path = `${paths.ruleStatusDir}/${file}`;
    const raw = await readJsonFile(path);
    if (raw !== undefined) records.push(parseRecord(raw, path));
  }
  return records.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}
