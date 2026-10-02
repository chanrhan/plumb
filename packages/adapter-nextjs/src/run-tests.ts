/**
 * `Adapter.runTests()` — 대상 루트에서 Vitest를 JUnit 리포터로 실행한다 (이슈 #44, 기획안 §4.2 "테스트 러너 연결").
 *
 * 어댑터는 파싱하지 않는다. JUnit XML 경로와 가로챈 출력만 돌려주고, 코어의 JUnit 파서(#43)가 XML을 읽는다.
 * XML이 안 생기면(러너 없음 · 설정 오류 · 죽음) `junitPath: null` — 이전 실행의 XML을 대신 돌려주지 않도록 실행 전에 지운다.
 */

import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AdapterContext, TestRunOptions, TestRunResult } from '@plumb/core';
import { capture, readToolInfo } from './capture.js';

/** 어댑터 기본 JUnit 경로 (루트 기준). testbed의 `vitest.config.ts` `outputFile.junit`과 같다 */
export const DEFAULT_JUNIT_PATH = 'reports/junit.xml';

/** `opts.junitPath` → `config.checks.junitReport` → 어댑터 기본값 순. 전부 루트 기준 상대 경로를 받는다 */
export function resolveJunitPath(ctx: AdapterContext, opts: TestRunOptions): string {
  return resolve(ctx.root, opts.junitPath ?? ctx.config.checks?.junitReport ?? DEFAULT_JUNIT_PATH);
}

/** `vitest run --reporter=default --reporter=junit --outputFile=<junitPath> [scope...]` */
export function vitestArgs(junitPath: string, opts: TestRunOptions): string[] {
  return ['run', '--reporter=default', '--reporter=junit', `--outputFile=${junitPath}`, ...(opts.scope ?? [])];
}

export async function runTests(ctx: AdapterContext, opts: TestRunOptions = {}): Promise<TestRunResult> {
  const junitPath = resolveJunitPath(ctx, opts);

  // 이전 결과를 "지금 결과"로 착각하지 않도록 먼저 지운다. 디렉토리는 만들어 둔다 (러너가 안 만들 수도 있다)
  await rm(junitPath, { force: true });
  await mkdir(dirname(junitPath), { recursive: true });

  const [tool, { output }] = await Promise.all([
    readToolInfo(ctx, 'vitest'),
    capture(ctx, {
      bin: 'vitest',
      args: vitestArgs(junitPath, opts),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    }),
  ]);

  return {
    junitPath: (await fileExists(junitPath)) ? junitPath : null,
    exitCode: output.exitCode,
    output,
    tool,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
