/**
 * 차이 탐색 (이슈 #91, 기획안 §7.4). 주입이 검사를 **통과해 버린**(`Validity.valid: false`) 경우에만 돈다. 에이전트가 아니라 러너다.
 *
 *   원본 · 위반 구현에 같은 입력 N개(fast-check, 고정 시드)를 넣고 출력을 비교한다.
 *   차이 > 0  → `weak-check`   : 구현은 분명히 달라졌는데 검사가 그 입력을 안 본다 — 검사를 보강해야 한다
 *   차이 = 0  → `undetermined` : 동치 변형이거나 입력 공간 밖 — 사람이 본다(검토 대기열 `undetermined-injection`)
 *   `real-violation`은 검사가 실패했을 때 inject.ts가 바로 기록하므로 여기로 오지 않는다.
 *
 * 대상 정의는 서비스 레포의 `plumb/diff-targets.ts`(규약 — 설정 스키마를 바꾸지 않는다):
 *   export default { 'pay.refund-window': { module: 'src/domains/payment/pure.ts', export: 'isRefundable', arbitrary: fc.tuple(fc.date(), fc.date()) } }
 * 실행은 자식 프로세스(`node --import tsx/esm checks/diff-search-driver.js`)에서 — 두 구현을 같은 프로세스에 로드하지 않는다.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Store } from '../store/index.js';
import { writeInjection } from '../store/injections.js';
import type { DiffSearch, RunId, Validity } from '../types/index.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

export const DIFF_TARGETS_FILE = 'plumb/diff-targets.ts';

/** 드라이버가 stdout 마지막 줄에 쓰는 결과 */
export interface DriverOutput {
  inputs: number;
  differing: number;
  /** 갈린 입력 몇 개 (문자열화) */
  examples: Array<{ input: string; original: string; injected: string }>;
  seed: number;
}

export interface DiffSearchJudgement {
  verdict: DiffSearch['verdict'];
  reason: string;
}

/** 순수 판정. `checkPassed`는 항상 true(검사가 통과해 버린 주입만 온다) */
export function judgeDiffSearch(out: Pick<DriverOutput, 'inputs' | 'differing'>): DiffSearchJudgement {
  if (out.inputs === 0) return { verdict: 'undetermined', reason: '입력을 만들지 못했다' };
  if (out.differing > 0) {
    return {
      verdict: 'weak-check',
      reason: `${out.differing}/${out.inputs} 입력에서 출력이 갈리는데 검사는 통과했다 — 검사가 그 입력을 보지 않는다`,
    };
  }
  return {
    verdict: 'undetermined',
    reason: `${out.inputs}개 입력에서 출력이 같다 — 동치 변형이거나 입력 공간 밖. 사람이 본다`,
  };
}

export interface RunDiffSearchInput {
  /** 원본 서비스 루트(절대) */
  originalRoot: string;
  /** 위반 구현이 있는 worktree 서비스 루트(절대) */
  injectedRoot: string;
  ruleId: string;
  numRuns: number;
  seed?: number;
  /** 기본 `plumb/diff-targets.ts` */
  targetsFile?: string;
  timeoutMs?: number;
}

export async function hasDiffTargets(serviceRoot: string, targetsFile = DIFF_TARGETS_FILE): Promise<boolean> {
  try {
    await access(join(serviceRoot, targetsFile));
    return true;
  } catch {
    return false;
  }
}

/** `tsx/esm` 로더 — 서비스의 것, 없으면 core의 것 */
export function resolveTsxLoader(serviceRoot: string): string {
  try {
    return createRequire(join(serviceRoot, 'package.json')).resolve('tsx/esm');
  } catch {
    return createRequire(import.meta.url).resolve('tsx/esm');
  }
}

export function driverPath(): string {
  // src에서는 .ts, dist에서는 .js — 같은 폴더의 형제 파일
  const ext = HERE.includes(`${'/'}src${'/'}`) ? 'ts' : 'js';
  return join(HERE, `diff-search-driver.${ext}`);
}

export async function runDiffSearch(input: RunDiffSearchInput): Promise<DriverOutput> {
  const seed = input.seed ?? 20261001;
  const env = {
    ...process.env,
    PLUMB_DIFF_ORIGINAL: resolve(input.originalRoot),
    PLUMB_DIFF_INJECTED: resolve(input.injectedRoot),
    PLUMB_DIFF_TARGETS: input.targetsFile ?? DIFF_TARGETS_FILE,
    PLUMB_DIFF_RULE: input.ruleId,
    PLUMB_DIFF_NUM_RUNS: String(input.numRuns),
    PLUMB_DIFF_SEED: String(seed),
  };
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', resolveTsxLoader(input.originalRoot), driverPath()],
    {
      cwd: input.originalRoot,
      env,
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const last = stdout.trim().split('\n').at(-1) ?? '';
  const parsed = JSON.parse(last) as DriverOutput;
  return { ...parsed, seed };
}

export interface RecordDiffSearchInput {
  store: Pick<Store, 'paths' | 'reviewQueue'>;
  validity: Validity & { valid: false };
  runId: RunId;
  out: DriverOutput;
}

/** 무효 주입 기록에 `diffSearch`를 채워 다시 쓴다. 미판정이면 검토 대기열 */
export async function recordDiffSearch(
  input: RecordDiffSearchInput,
): Promise<Validity & { valid: false; diffSearch: DiffSearch }> {
  const { verdict, reason } = judgeDiffSearch(input.out);
  let queueItemId: DiffSearch['queueItemId'];
  if (verdict === 'undetermined') {
    const item = await input.store.reviewQueue.enqueue({
      kind: 'undetermined-injection',
      ruleIds: [input.validity.ruleId],
      runId: input.runId,
      summary: `${input.validity.description} — 차이 탐색 미판정: ${reason}`,
    });
    queueItemId = item.id;
  }
  const diffSearch: DiffSearch = {
    runId: input.runId,
    inputs: input.out.inputs,
    differingOutputs: input.out.differing,
    verdict,
    ...(queueItemId ? { queueItemId } : {}),
  };
  const updated = { ...input.validity, diffSearch };
  await writeInjection(input.store.paths, updated);
  return updated;
}
