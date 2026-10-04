/**
 * 차이 탐색 드라이버 (이슈 #91). `diff-search.ts`가 `node --import tsx/esm`로 띄우는 자식 프로세스.
 * 환경변수: PLUMB_DIFF_ORIGINAL · PLUMB_DIFF_INJECTED(서비스 루트 둘) · PLUMB_DIFF_TARGETS · PLUMB_DIFF_RULE · PLUMB_DIFF_NUM_RUNS · PLUMB_DIFF_SEED.
 * 대상 정의(`plumb/diff-targets.ts`)는 **원본**에서 읽는다 — 위반 구현이 대상 정의를 바꿔 빠져나갈 수 없다.
 * 마지막 줄에 JSON(`DriverOutput`)을 쓴다. 다른 출력은 없다.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Target {
  /** 서비스 루트 기준 모듈 경로 */
  module: string;
  export: string;
  /** fast-check Arbitrary — 샘플 하나가 인자 배열이거나 단일 값 */
  arbitrary: { generate?: unknown } & object;
  /** 호출 방식. 기본: 배열이면 펼쳐서, 아니면 하나로 */
  call?: (fn: (...args: unknown[]) => unknown, input: unknown) => unknown;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 없음`);
  return v;
}

function stringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Date ? v.toISOString() : v)) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}

async function callSafely(fn: (...args: unknown[]) => unknown, input: unknown, call?: Target['call']): Promise<string> {
  try {
    const result = call ? await call(fn, input) : Array.isArray(input) ? await fn(...input) : await fn(input);
    return stringify(result);
  } catch (error) {
    return `throw:${(error as Error).name ?? 'Error'}:${(error as Error).message ?? String(error)}`;
  }
}

async function main(): Promise<void> {
  const original = env('PLUMB_DIFF_ORIGINAL');
  const injected = env('PLUMB_DIFF_INJECTED');
  const targetsFile = env('PLUMB_DIFF_TARGETS');
  const ruleId = env('PLUMB_DIFF_RULE');
  const numRuns = Number(env('PLUMB_DIFF_NUM_RUNS'));
  const seed = Number(env('PLUMB_DIFF_SEED'));

  const targetsMod = (await import(pathToFileURL(join(original, targetsFile)).href)) as {
    default?: Record<string, Target>;
  } & Record<string, unknown>;
  const targets = (targetsMod.default ?? targetsMod) as Record<string, Target>;
  const target = targets[ruleId];
  if (!target) throw new Error(`diff-targets에 ${ruleId} 없음`);

  // fast-check는 서비스(원본)의 것을 쓴다 — 대상 정의가 만든 Arbitrary와 같은 인스턴스여야 한다
  const { createRequire } = await import('node:module');
  const req = createRequire(join(original, 'package.json'));
  const fc = (await import(pathToFileURL(req.resolve('fast-check')).href)) as unknown as {
    default?: { sample: (arb: unknown, params: { numRuns: number; seed: number }) => unknown[] };
    sample?: (arb: unknown, params: { numRuns: number; seed: number }) => unknown[];
  };
  const sample = fc.default?.sample ?? fc.sample;
  if (!sample) throw new Error('fast-check sample 없음');

  const load = async (root: string) => {
    const mod = (await import(pathToFileURL(join(root, target.module)).href)) as Record<string, unknown>;
    const fn = mod[target.export];
    if (typeof fn !== 'function') throw new Error(`${root}/${target.module}에 ${target.export} 함수 없음`);
    return fn as (...args: unknown[]) => unknown;
  };
  const [fnA, fnB] = await Promise.all([load(original), load(injected)]);
  const inputs = sample(target.arbitrary, { numRuns, seed });

  let differing = 0;
  const examples: Array<{ input: string; original: string; injected: string }> = [];
  for (const input of inputs) {
    const [a, b] = await Promise.all([callSafely(fnA, input, target.call), callSafely(fnB, input, target.call)]);
    if (a !== b) {
      differing += 1;
      if (examples.length < 3) examples.push({ input: stringify(input), original: a, injected: b });
    }
  }
  process.stdout.write(`${JSON.stringify({ inputs: inputs.length, differing, examples, seed })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
