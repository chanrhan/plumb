/**
 * 결정 기록 저장소 조회 · 쓰기 — `decisions/D-xxxx.md` (이슈 #35). 경로는 #31의 {@link StorePaths}(`paths.decisionsDir`,
 * `paths.decision(id)`), 파일 입출력은 `store/fs.ts`의 원자적 쓰기 헬퍼를 그대로 쓴다.
 *
 * 결정 기록은 3등급(기록)이라 승인 절차가 없다 — 에이전트 · 사람이 쓰면 그대로 저장된다. 규칙은 `Rule.decision`으로,
 * 결정 기록은 `links.rules`로 서로를 가리킨다 (work-approve 6절 4번: 결정 기록 없는 규칙의 승인도 허용).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isEnoent, listFiles, writeFileAtomic } from '../store/fs.js';
import type { StorePaths } from '../store/index.js';
import type { DecisionId, DecisionRecord, RuleId } from '../types/index.js';
import { DECISION_ID_PATTERN, formatDecision, parseDecision } from './format.js';

/** `writeDecision` 입력. `id`가 없으면 다음 번호를 받는다 */
export type DecisionInput = Omit<DecisionRecord, 'id'> & { id?: DecisionId };

/** 번호 자릿수. `D-0001`. 넘치면 자릿수가 늘어난다 (`D-10000`) */
export const DECISION_ID_WIDTH = 4;

function numberOf(id: string): number | undefined {
  return DECISION_ID_PATTERN.test(id) ? Number.parseInt(id.slice(2), 10) : undefined;
}

export function decisionIdOf(n: number): DecisionId {
  return `D-${String(n).padStart(DECISION_ID_WIDTH, '0')}`;
}

/** 폴더 안의 `D-nnnn.md` 파일 ID. 번호 오름차순. 다른 이름의 `.md`는 결정 기록이 아니므로 무시한다 */
async function listDecisionIds(paths: StorePaths): Promise<DecisionId[]> {
  const files = await listFiles(paths.decisionsDir, '.md');
  return files
    .map((file) => file.slice(0, -'.md'.length))
    .filter((id): id is DecisionId => numberOf(id) !== undefined)
    .sort((a, b) => (numberOf(a) as number) - (numberOf(b) as number));
}

/** 다음 결정 ID — 기존 최대 번호 + 1. 폴더가 없거나 비어 있으면 `D-0001` */
export async function nextDecisionId(paths: StorePaths): Promise<DecisionId> {
  const ids = await listDecisionIds(paths);
  const last = ids.length === 0 ? 0 : (numberOf(ids[ids.length - 1] as string) as number);
  return decisionIdOf(last + 1);
}

async function readDecisionFile(path: string): Promise<DecisionRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  return parseDecision(text, path);
}

/** 전체 결정 기록. 번호 오름차순. 한 파일이라도 형식이 아니면 {@link DecisionParseError} */
export async function listDecisions(paths: StorePaths): Promise<DecisionRecord[]> {
  const records: DecisionRecord[] = [];
  for (const id of await listDecisionIds(paths)) {
    const record = await readDecisionFile(join(paths.decisionsDir, `${id}.md`));
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** 없으면 `undefined`. 파일이 있는데 형식이 아니면 {@link DecisionParseError} */
export async function getDecision(paths: StorePaths, id: DecisionId): Promise<DecisionRecord | undefined> {
  return readDecisionFile(paths.decision(id));
}

/**
 * `decisions/<id>.md`에 쓴다 (원자적). `id`가 없으면 {@link nextDecisionId}. 같은 ID가 있으면 덮어쓴다.
 * 쓰기 전에 직렬화한 원문을 다시 파싱해 디스크의 파일이 반드시 읽히는 것을 보장한다 — 입력이 스키마에 어긋나면
 * {@link DecisionParseError}이고 파일은 쓰지 않는다. 돌려주는 값은 그 파싱 결과(정규화된 기록)
 */
export async function writeDecision(paths: StorePaths, input: DecisionInput): Promise<DecisionRecord> {
  const id = input.id ?? (await nextDecisionId(paths));
  const text = formatDecision({ ...input, id });
  const record = parseDecision(text, `결정 ${id}`);
  await writeFileAtomic(paths.decision(id), text);
  return record;
}

/** `links.rules`에 규칙 ID가 들어 있는 결정 기록. 번호 오름차순 */
export async function decisionsForRule(paths: StorePaths, ruleId: RuleId): Promise<DecisionRecord[]> {
  return (await listDecisions(paths)).filter((record) => record.links.rules.includes(ruleId));
}
