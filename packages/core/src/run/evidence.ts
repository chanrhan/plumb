/**
 * 단계 증거 (이슈 #86). 오케스트레이터가 **직접** 테스트를 돌리고(어댑터 `runTests`) JUnit을 읽어 Stop hook 증거와 `StageResult`를 만든다.
 * 에이전트의 메시지 텍스트는 입력이 아니다(기획안 §8.3). 명령 출력은 `runs/<id>/output.log`에 구분자와 함께 덧붙인다(`CapturedOutput`).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Adapter, AdapterContext, TestRunResult } from '../adapter/types.js';
import { scanDisputes } from '../harness/dispute.js';
import { evidenceFromJunit, type StopEvidence } from '../harness/stop.js';
import type { CapturedOutput, TestTally } from '../types/index.js';

export interface CollectEvidenceInput {
  adapter: Pick<Adapter, 'runTests'>;
  ctx: AdapterContext;
  /** 돌릴 테스트 파일(서비스 루트 기준). 담당 규칙의 `checks[].ref` */
  scope: readonly string[];
  /** 이 파일들이 보고서에 있어야 한다 (`all-fail`) */
  expectedFiles?: readonly string[];
  /** implementer: 이의 제기 디렉토리 — 유효 파일이 있으면 `hasDispute` */
  disputesDir?: string;
  /** `runs/<id>/output.log` 절대 경로 */
  logPath: string;
  timeoutMs?: number;
}

export interface CollectedEvidence {
  evidence: StopEvidence;
  tally: TestTally;
  testRun: TestRunResult;
  captured: CapturedOutput;
}

/** 출력 로그에 한 명령 블록을 덧붙인다 (work-run 3.3 "마지막 실행 출력": 꼬리 N줄은 `captured.tail`) */
export async function appendOutputLog(logPath: string, captured: CapturedOutput): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const block = [
    `===== ${captured.startedAt} $ ${captured.command}`,
    ...captured.tail,
    `===== exit ${captured.exitCode} @ ${captured.finishedAt}`,
    '',
  ].join('\n');
  await appendFile(logPath, block, 'utf8');
}

export async function collectEvidence(input: CollectEvidenceInput): Promise<CollectedEvidence> {
  const testRun = await input.adapter.runTests(input.ctx, {
    scope: [...input.scope],
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const captured: CapturedOutput = { ...testRun.output, logPath: input.logPath };
  await appendOutputLog(input.logPath, captured);

  const hasDispute =
    input.disputesDir === undefined ? undefined : (await scanDisputes(input.disputesDir)).valid.length > 0;
  const evidence = await evidenceFromJunit({
    junitPath: testRun.junitPath,
    root: input.ctx.root,
    expectedFiles: input.expectedFiles,
    hasDispute,
    runnerTail: testRun.output.tail,
  });
  return { evidence, tally: evidence.tally, testRun, captured };
}
