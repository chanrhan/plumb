/**
 * 종료 조건 Stop hook (이슈 #78, 기획안 §8.3 "종료 시점에 도는 검사 스크립트가 정한다").
 *
 * 역할은 스스로 끝낼 수 없다. 모델이 멈추려 하면 `hooks.Stop`이 **오케스트레이터가 직접 실행한 테스트 결과**로 판정한다:
 *   test-writer  `all-fail`             담당 규칙마다 인수 테스트 파일이 있고 그 테스트가 전부 실패할 때만 끝난다
 *   implementer  `all-pass-or-dispute`  인수 테스트가 전부 통과하거나 이의 제기 파일이 있을 때만 끝난다
 * 조건이 안 맞으면 `decision: 'block'` + 이유를 돌려주고 모델은 계속한다. 연속 차단이 `stopBlockLimit`에 닿으면
 * 더 붙잡지 않고 끝내되 `state.disputeRequired`를 켠다 → 오케스트레이터가 이의 제기 · 검토 대기열 경로로(§8.4).
 *
 * 판정(`decideStop`)은 순수 함수. 증거(`StopEvidence`)는 `collect` 콜백이 모은다 — 에이전트 메시지 텍스트는 입력이 아니다.
 */

import { readFile } from 'node:fs/promises';
import type { HookCallback, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { type JunitReport, parseJunit } from '../checks/junit.js';
import type { TestTally } from '../types/index.js';

export type StopKind = 'all-fail' | 'all-pass-or-dispute';

export interface StopEvidence {
  tally: TestTally;
  /** `all-fail`: 담당 규칙이 요구하는 테스트 파일(루트 기준 상대) */
  expectedFiles?: readonly string[];
  /** 보고서에 실제로 나타난 테스트 파일 */
  presentFiles?: readonly string[];
  /** `all-pass-or-dispute`: 이의 제기 파일이 하나 이상 있는가 */
  hasDispute?: boolean;
  /** 러너가 보고서를 못 만들었을 때(죽음 · 설정 오류) 그 이유 */
  runnerError?: string;
}

export interface StopVerdict {
  approve: boolean;
  /** `approve`일 때 무엇으로 통과했는가 */
  by?: 'condition' | 'dispute';
  reason: string;
}

export function decideStop(kind: StopKind, e: StopEvidence): StopVerdict {
  if (e.runnerError) return { approve: false, reason: `테스트 러너 실패: ${e.runnerError}` };
  const { total, passed, failed } = e.tally;
  if (kind === 'all-fail') {
    const missing = (e.expectedFiles ?? []).filter((f) => !(e.presentFiles ?? []).includes(f));
    if (missing.length > 0) return { approve: false, reason: `인수 테스트 파일 없음: ${missing.join(', ')}` };
    if (total === 0) return { approve: false, reason: '인수 테스트가 하나도 없다' };
    if (passed > 0)
      return {
        approve: false,
        reason: `${passed}/${total} 테스트가 이미 통과한다 — 구현 없이 통과하는 테스트는 규칙을 검증하지 않는다`,
      };
    if (failed !== total) return { approve: false, reason: `${total - failed - passed}개가 건너뛰어졌다` };
    return { approve: true, by: 'condition', reason: `${total}개 전부 실패 (정상 시작점)` };
  }
  if (e.hasDispute) return { approve: true, by: 'dispute', reason: '이의 제기 파일 있음' };
  if (total === 0) return { approve: false, reason: '인수 테스트가 하나도 없다' };
  if (failed > 0) return { approve: false, reason: `${failed}/${total} 테스트가 아직 실패한다` };
  return { approve: true, by: 'condition', reason: `${total}개 전부 통과` };
}

/** 오케스트레이터가 읽는 상태 (`RoleUsage.stopBlocks` · `consecutiveStopBlocks`의 원자료) */
export interface StopState {
  blocks: number;
  consecutiveBlocks: number;
  lastVerdict?: StopVerdict;
  /** 연속 차단이 상한에 닿아 끝냈다 → 이의 제기 · 검토 대기열 경로 */
  disputeRequired: boolean;
  approvedBy?: StopVerdict['by'] | 'limit';
}

export function newStopState(): StopState {
  return { blocks: 0, consecutiveBlocks: 0, disputeRequired: false };
}

export interface StopHookConfig {
  kind: StopKind;
  /** `plumb.config.json stopBlockLimit`. 1 이상 */
  stopBlockLimit: number;
  /** 증거 수집 — 보통 테스트를 실제로 돌리고 JUnit을 읽는다 */
  collect: () => Promise<StopEvidence>;
  log?: (line: string) => void;
  state?: StopState;
}

export interface StopHook {
  hook: HookCallback;
  state: StopState;
}

export function makeStopHook(config: StopHookConfig): StopHook {
  if (!Number.isInteger(config.stopBlockLimit) || config.stopBlockLimit < 1)
    throw new Error('stopBlockLimit은 1 이상의 정수');
  const state = config.state ?? newStopState();
  const log = config.log ?? ((line) => process.stderr.write(`${line}\n`));
  const hook: HookCallback = async (input) => {
    const stop = input as StopHookInput;
    let verdict: StopVerdict;
    try {
      verdict = decideStop(config.kind, await config.collect());
    } catch (error) {
      verdict = { approve: false, reason: `증거 수집 실패: ${(error as Error).message ?? String(error)}` };
    }
    state.lastVerdict = verdict;
    if (verdict.approve) {
      state.consecutiveBlocks = 0;
      state.approvedBy = verdict.by;
      log(`[stop] approve (${verdict.by}): ${verdict.reason}`);
      return {};
    }
    state.blocks += 1;
    state.consecutiveBlocks += 1;
    if (state.consecutiveBlocks >= config.stopBlockLimit) {
      state.disputeRequired = true;
      state.approvedBy = 'limit';
      log(
        `[stop] block (${state.consecutiveBlocks}/${config.stopBlockLimit}) → 상한 — 끝내고 이의 제기 경로로: ${verdict.reason}`,
      );
      return {};
    }
    log(
      `[stop] block (${state.consecutiveBlocks}/${config.stopBlockLimit}): ${verdict.reason}${stop.stop_hook_active ? '' : ''}`,
    );
    return {
      decision: 'block',
      reason: `아직 끝낼 수 없다 — ${verdict.reason}. 계속 작업하거나, 테스트가 틀렸다고 판단하면 이의 제기 파일을 쓴다.`,
    };
  };
  return { hook, state };
}

// ---------------------------------------------------------------------------
// 증거 — JUnit에서
// ---------------------------------------------------------------------------

/** skipped는 분모에서 뺀다 — "전부 실패"·"전부 통과"는 실행된 테스트에 대한 말이다 */
export function tallyFromJunit(report: JunitReport): TestTally {
  const t = report.totals;
  return { total: t.tests - t.skipped, passed: t.passed, failed: t.failures + t.errors };
}

export function presentFilesOf(report: JunitReport): string[] {
  const files = new Set<string>();
  for (const suite of report.suites) {
    if (suite.file) files.add(suite.file);
    for (const c of suite.cases) if (c.file) files.add(c.file);
  }
  return [...files].sort();
}

export interface JunitEvidenceInput {
  /** `TestRunResult.junitPath`. null이면 러너가 보고서를 못 만든 것 */
  junitPath: string | null;
  root: string;
  expectedFiles?: readonly string[];
  hasDispute?: boolean;
  /** 보고서가 없을 때 이유로 쓸 러너 출력 꼬리 */
  runnerTail?: readonly string[];
}

export async function evidenceFromJunit(input: JunitEvidenceInput): Promise<StopEvidence> {
  if (input.junitPath === null) {
    return {
      tally: { total: 0, passed: 0, failed: 0 },
      expectedFiles: input.expectedFiles,
      presentFiles: [],
      hasDispute: input.hasDispute,
      runnerError: `JUnit 보고서 없음${input.runnerTail?.length ? ` — ${input.runnerTail.slice(-3).join(' | ')}` : ''}`,
    };
  }
  const report = parseJunit(await readFile(input.junitPath, 'utf8'), { root: input.root });
  return {
    tally: tallyFromJunit(report),
    expectedFiles: input.expectedFiles,
    presentFiles: presentFilesOf(report),
    hasDispute: input.hasDispute,
  };
}
