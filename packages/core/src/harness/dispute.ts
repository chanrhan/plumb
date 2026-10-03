/**
 * 이의 제기 파일 (이슈 #78, 기획안 §8.4, 타입 `Dispute`). implementer가 `.work/implementer/disputes/d-<이름>.md`에 쓴다.
 * 형식: 첫 비어 있지 않은 줄 = 한 문장 요약, 그 아래 근거(어떤 입력에서 진술과 테스트가 갈리는가).
 * Stop hook(`all-pass-or-dispute`)은 **유효한** 파일이 있을 때만 "이의 제기 있음"으로 본다 — 빈 파일로 빠져나갈 수 없다.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dispute, DisputeId, Role } from '../types/index.js';

export const DISPUTE_FILE_PATTERN = /^(d-[\w-]+)\.md$/;
/** 요약 최소 길이 — "안 됨" 같은 한 단어는 이의 제기가 아니다 */
export const DISPUTE_SUMMARY_MIN = 10;
/** 근거 최소 길이 */
export const DISPUTE_BODY_MIN = 20;

export type DisputeValidation = { ok: true; summary: string; body: string } | { ok: false; reason: string };

export function validateDisputeText(text: string): DisputeValidation {
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx < 0) return { ok: false, reason: '빈 파일' };
  const summary = (lines[firstIdx] ?? '').replace(/^#+\s*/, '').trim();
  if (summary.length < DISPUTE_SUMMARY_MIN)
    return { ok: false, reason: `요약이 너무 짧다 (${summary.length} < ${DISPUTE_SUMMARY_MIN})` };
  const body = lines
    .slice(firstIdx + 1)
    .join('\n')
    .trim();
  if (body.length < DISPUTE_BODY_MIN)
    return { ok: false, reason: `근거가 없거나 너무 짧다 (${body.length} < ${DISPUTE_BODY_MIN})` };
  return { ok: true, summary, body };
}

export interface DisputeFile {
  id: DisputeId;
  /** 절대 경로 */
  file: string;
  summary: string;
  body: string;
}

export interface DisputeScan {
  valid: DisputeFile[];
  /** 이름은 맞는데 내용이 모자란 파일 — 로그에 적어 implementer에게 되돌려 준다 */
  invalid: Array<{ file: string; reason: string }>;
}

export async function scanDisputes(disputesDir: string): Promise<DisputeScan> {
  let names: string[];
  try {
    names = await readdir(disputesDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  const valid: DisputeFile[] = [];
  const invalid: DisputeScan['invalid'] = [];
  for (const name of names.sort()) {
    const m = DISPUTE_FILE_PATTERN.exec(name);
    if (!m) continue;
    const file = join(disputesDir, name);
    const v = validateDisputeText(await readFile(file, 'utf8'));
    if (v.ok) valid.push({ id: m[1] as DisputeId, file, summary: v.summary, body: v.body });
    else invalid.push({ file, reason: v.reason });
  }
  return { valid, invalid };
}

/** 스캔 결과를 `RunState.disputes` 항목으로. 재검토(`advisory`)는 M6 */
export function toDispute(d: DisputeFile, by: Role, reviewer: Role, at = new Date().toISOString()): Dispute {
  return { id: d.id, at, by, reviewer, summary: d.summary, file: d.file, status: 'reviewing' };
}
