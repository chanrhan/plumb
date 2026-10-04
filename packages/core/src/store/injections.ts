/**
 * 위반 주입 기록 `injections/<ruleId>/<i-id>.json` (기획안 §7.4, 타입 `Validity`, 이슈 #90).
 * 사람은 `description` 한 줄과 결과만 본다 — 패치 본문은 저장하지 않는다. 검사가 실패하면 유효 ✔(`check-failed`), 통과하면 무효 ✘(`check-passed` → 차이 탐색 #91).
 */

import type { InjectionId, RuleId, Validity } from '../types/index.js';
import { ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';

export const INJECTION_ID_PATTERN = /^i-\d{4,}$/;

function parseValidity(raw: unknown, where: string): Validity {
  const r = raw as Partial<Validity> | null;
  if (!r || typeof r !== 'object') throw new ValidationError(`${where}: 객체가 아니다`);
  if (typeof r.id !== 'string' || !INJECTION_ID_PATTERN.test(r.id))
    throw new ValidationError(`${where}: id가 i-nnnn 꼴이 아니다`);
  if (typeof r.ruleId !== 'string') throw new ValidationError(`${where}: ruleId 필요`);
  if (typeof r.description !== 'string' || r.description.trim().length === 0)
    throw new ValidationError(`${where}: description 한 줄 필요`);
  if (typeof r.commit !== 'string' || typeof r.at !== 'string') throw new ValidationError(`${where}: commit · at 필요`);
  if (!r.checkFileHashes || typeof r.checkFileHashes !== 'object')
    throw new ValidationError(`${where}: checkFileHashes 필요`);
  const v = r as Validity;
  if (!((v.result === 'check-failed' && v.valid === true) || (v.result === 'check-passed' && v.valid === false))) {
    throw new ValidationError(`${where}: result와 valid가 맞지 않는다 (check-failed ↔ true, check-passed ↔ false)`);
  }
  return v;
}

export async function nextInjectionId(paths: StorePaths, ruleId: RuleId): Promise<InjectionId> {
  let max = 0;
  for (const file of await listFiles(paths.injectionDir(ruleId), '.json')) {
    const m = /^i-(\d+)\.json$/.exec(file);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `i-${String(max + 1).padStart(4, '0')}` as InjectionId;
}

export async function writeInjection(paths: StorePaths, validity: Validity | unknown): Promise<Validity> {
  const parsed = parseValidity(validity, 'injections.write');
  await writeJsonAtomic(paths.injection(parsed.ruleId, parsed.id), parsed);
  return parsed;
}

/** 규칙 하나의 주입 기록, 시각순 */
export async function listInjections(paths: StorePaths, ruleId: RuleId): Promise<Validity[]> {
  const out: Validity[] = [];
  for (const file of await listFiles(paths.injectionDir(ruleId), '.json')) {
    const raw = await readJsonFile(`${paths.injectionDir(ruleId)}/${file}`);
    if (raw !== undefined) out.push(parseValidity(raw, file));
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** 가장 최근 기록. 검증 View의 "유효성" 열이 읽는다 */
export async function latestInjection(paths: StorePaths, ruleId: RuleId): Promise<Validity | undefined> {
  const all = await listInjections(paths, ruleId);
  return all[all.length - 1];
}
