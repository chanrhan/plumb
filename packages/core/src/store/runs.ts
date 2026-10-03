/**
 * 실행 상태 파일 `runs/<r-id>.json` (이슈 #86, 타입 `RunState`). `plumb run`(오케스트레이터)만 쓰고 UI 서버 · CLI `runs`는 읽는다.
 * 쓰기는 원자적(임시 파일 → rename) — UI가 쓰는 도중 읽어도 반쪽을 보지 않는다(work-run 4절 "파싱 실패면 직전 응답 유지").
 * 검증은 모양만 본다(id · status · stage · startedAt). 상태 전이의 의미는 `run/state.ts`가 책임진다.
 */

import type { RunId, RunState, RunStatus, RunSummary } from '../types/index.js';
import { ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';

export const RUN_ID_PATTERN = /^r-\d{4,}$/;
const RUN_STATUSES: readonly RunStatus[] = ['running', 'completed', 'failed', 'budget-exceeded', 'aborted'];

export function isRunId(value: unknown): value is RunId {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

function parseRunState(raw: unknown, where: string): RunState {
  const r = raw as Partial<RunState> | null;
  if (!r || typeof r !== 'object') throw new ValidationError(`${where}: 객체가 아니다`);
  if (!isRunId(r.id)) throw new ValidationError(`${where}: id가 r-nnnn 꼴이 아니다: ${String(r.id)}`);
  if (!RUN_STATUSES.includes(r.status as RunStatus))
    throw new ValidationError(`${where}: status 값이 아니다: ${String(r.status)}`);
  if (typeof r.stage !== 'number' || r.stage < 1 || r.stage > 6) throw new ValidationError(`${where}: stage는 1~6`);
  if (typeof r.startedAt !== 'string' || typeof r.updatedAt !== 'string')
    throw new ValidationError(`${where}: startedAt · updatedAt 필요`);
  if (!Array.isArray(r.stages) || !Array.isArray(r.ruleIds) || !Array.isArray(r.disputes)) {
    throw new ValidationError(`${where}: stages · ruleIds · disputes는 배열`);
  }
  return r as RunState;
}

export async function writeRunState(paths: StorePaths, state: RunState | unknown): Promise<RunState> {
  const parsed = parseRunState(state, 'runs.write');
  await writeJsonAtomic(paths.run(parsed.id), parsed);
  return parsed;
}

/** 없으면 undefined. 쓰는 도중 읽혀 깨진 JSON이면 {@link ValidationError} — 호출자(UI)는 직전 응답을 유지한다 */
export async function readRunState(paths: StorePaths, id: RunId): Promise<RunState | undefined> {
  const raw = await readJsonFile(paths.run(id));
  return raw === undefined ? undefined : parseRunState(raw, paths.run(id));
}

export function toRunSummary(state: RunState): RunSummary {
  return {
    id: state.id,
    status: state.status,
    stage: state.stage,
    startedAt: state.startedAt,
    ruleIds: state.ruleIds,
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
  };
}

/** 최근 시작 순. 깨진 파일은 건너뛴다(목록이 한 파일 때문에 죽지 않는다) */
export async function listRuns(paths: StorePaths): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  for (const file of await listFiles(paths.runsDir, '.json')) {
    const raw = await readJsonFile(`${paths.runsDir}/${file}`);
    if (raw === undefined) continue;
    try {
      out.push(toRunSummary(parseRunState(raw, file)));
    } catch {
      /* 쓰는 도중이거나 손상 — 다음 폴링에서 */
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

/** `r-0001`부터. 파일 이름의 최대 번호 + 1 */
export async function nextRunId(paths: StorePaths): Promise<RunId> {
  let max = 0;
  for (const file of await listFiles(paths.runsDir, '.json')) {
    const m = /^r-(\d+)\.json$/.exec(file);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `r-${String(max + 1).padStart(4, '0')}` as RunId;
}

/** 진행 중(`running`)인 실행. 첫 슬라이스는 동시 1개(work-run 6절 1번) */
export async function activeRun(paths: StorePaths): Promise<RunSummary | undefined> {
  return (await listRuns(paths)).find((r) => r.status === 'running');
}
