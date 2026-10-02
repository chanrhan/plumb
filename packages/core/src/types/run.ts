// 원본: docs/types/run.ts (#5). 정본은 이 파일. #63에서 보완.
/**
 * 파이프라인 실행 상태 — `runs/<id>.json`.
 *
 * 출처 와이어프레임: `work-run.md` 3.2 · 3.3절, 6절 4번 (필드 목록 `id` `pid` `status` `reason` `stage` `stages[]`
 * `currentRole` `ruleIds[]` `roles.{role}.{turns,stopBlocks}` `costUsd` `disputes[]` `startedAt` `updatedAt` `finishedAt`).
 * 기획안 §8.3 (파이프라인 ①~⑥) · §8.4 (이의 제기) · §15.4 (역할 · 예산 · 상한).
 *
 * 출처 접두어는 전부 `저장소: runs/<id>.json` 폴링이다 (README 3.1). 단계 결과와 마지막 출력의 원자료는 `실행:`.
 *
 * 설계 원칙을 타입으로 묶은 곳:
 * - 자기 보고는 입력이 아니다 → 에이전트 메시지 필드가 없다. 가로챈 명령 출력 {@link CapturedOutput}만 있다
 * - LLM 판정은 상태를 바꾸지 못한다 → 이의 제기 재검토 결과는 {@link Dispute}`.advisory` 아래에만
 * - 종료 사유는 종료 상태마다 다르다 → {@link RunOutcome} discriminated union
 */

import type { ReviewQueueItemId, RuleId, RuleStatus } from './rules.js';
import type { CheckRunId } from './rules.js';

/** 실행 ID. 파일 이름과 같다 (`runs/r-0003.json`) */
export type RunId = `r-${string}`;

/** 파이프라인 단계 ①~⑥ (기획안 §8.3). ① 승인 ② 테스트 작성 ③ 구현 ④ 전체 검사 ⑤ 위반 주입 ⑥ View 갱신 */
export type Stage = 1 | 2 | 3 | 4 | 5 | 6;

/** 역할 (기획안 §15.4 `roles.{role}`). 단계 ④⑥은 역할 없음 */
export type Role = 'test-writer' | 'implementer' | 'injector' | 'rule-drafter';

/** 단계 → 역할. ④⑥은 `null` (work-run 3.3 "현재 역할" 비고) */
export type RoleOfStage = { 1: null; 2: 'test-writer'; 3: 'implementer'; 4: null; 5: 'injector'; 6: null };

/** 상태: 진행중 + 종료 네 가지 (work-run 3.2 "상태") */
export type RunStatus = 'running' | 'completed' | 'failed' | 'budget-exceeded' | 'aborted';

/** 테스트 실행 집계. 실행: JUnit XML (work-run 3.3 "단계 ② 결과", "단계 ③ 결과") */
export interface TestTally {
  total: number;
  passed: number;
  failed: number;
}

/**
 * 단계별 결과. ② 전부 실패해야 ✔, ③ 전부 통과하거나 이의 제기를 내야 ✔ (기획안 §8.3).
 * ⑤ 잡히지 않은 주입이 있으면 ②로 되돌아간다.
 */
export type StageResult =
  | { stage: 1; approvedAt: Record<RuleId, string> }
  | { stage: 2; tests: TestTally; allFailed: boolean }
  | { stage: 3; tests: TestTally; allPassed: boolean; disputeId?: DisputeId }
  | { stage: 4; checkRunId: CheckRunId; byRule: Record<RuleId, RuleStatus> }
  | { stage: 5; injections: number; caught: number; weak: boolean }
  | { stage: 6; viewsUpdated: number; queued: number };

/**
 * 단계 기록 하나. ⑤→② 되돌아가면 같은 단계가 다시 나타나고 `attempt`가 오른다 — 배열 반복과 카운터를 둘 다 쓴다
 * (work-run 6절 4번). 화면은 가장 최근 항목으로 그리며 "n회차"를 덧붙인다.
 */
export interface StageRecord {
  stage: Stage;
  /** 1부터. 같은 단계의 몇 번째 시도인가 */
  attempt: number;
  role: Role | null;
  startedAt: string;
  finishedAt?: string;
  result?: StageResult;
}

/** 역할별 사용량 (work-run 3.3 "역할별 반복 횟수", "역할별 종료 차단 횟수"). 원자료는 오케스트레이터가 센 SDK 턴 수와 Stop hook 차단 횟수 */
export interface RoleUsage {
  turns: number;
  stopBlocks: number;
  /** 연속 차단 횟수. `stopBlockLimit`에 닿으면 이의 제기 경로 (기획안 §8.3) */
  consecutiveStopBlocks: number;
  /** SDK 결과 메시지의 비용 누적. SDK가 안 주면 null (work-run 6절 6번) */
  costUsd: number | null;
}

/** 실행 시점의 상한 스냅샷. 저장소: `plumb.config.json`에서 복사 (화면에서 바꾸지 않는다) */
export interface RunLimits {
  maxBudgetUsd: number;
  stopBlockLimit: number;
  maxTurns: Partial<Record<Role, number>>;
}

export type DisputeId = `d-${string}`;

/**
 * 이의 제기 (기획안 §8.4, work-run 3.3 "이의 제기"). implementer → test-writer 재검토.
 * 재검토 결과(판정 + 근거 테스트 입력)는 LLM 출력이므로 `advisory`다 — 규칙 상태를 바꾸지 못한다.
 * 해석이 갈리면 검토 대기열로.
 */
export interface Dispute {
  id: DisputeId;
  at: string;
  by: Role;
  reviewer: Role;
  /** 이의 제기 파일의 첫 줄 */
  summary: string;
  /** `.work/<role>/disputes/<id>.md` */
  file: string;
  status: 'reviewing' | 'resolved' | 'queued';
  /** 재검토 결과. 참고용. 상태 계산의 입력이 아니다 */
  advisory?: {
    by: Role;
    at: string;
    verdict: 'test-correct' | 'test-wrong' | 'ambiguous';
    /** 근거 테스트 입력 */
    evidenceInput?: string;
  };
  queueItemId?: ReviewQueueItemId;
}

/**
 * 가로챈 실행 출력 (work-run 3.3 "마지막 실행 출력"). 오케스트레이터가 직접 실행한 테스트·검사 명령의 stdout/stderr.
 * **에이전트의 메시지 텍스트는 절대 아니다.** 꼬리 20줄 (work-run 6절 5번).
 */
export interface CapturedOutput {
  command: string;
  startedAt: string;
  finishedAt: string;
  /** 프로세스 exit code. 시그널로 죽었으면 `-1` + `tail` 끝에 `[plumb] 시그널로 종료: …` 한 줄, 바이너리가 없으면 `127` (#49) */
  exitCode: number;
  tail: string[];
  /**
   * 전체 로그 파일의 절대 경로. 어댑터가 직접 돌린 명령은 `<work>/logs/<시각>-<bin>.log`(#44),
   * 파이프라인 실행은 `runs/<id>/output.log`(명령별 구분자 포함, M6). 전체 보기는 M10
   */
  logPath: string;
}

/** 종료 상태와 사유 (work-run 2절 "종료된 실행의 마지막 줄"). 실패 · 예산 초과는 검토 대기열에 올라간다 (§15.4) */
export type RunOutcome =
  | { status: 'completed'; finishedAt: string }
  | {
      status: 'failed';
      finishedAt: string;
      reason: 'stopBlockLimit' | 'maxTurns' | 'stage-2-not-all-failed' | 'runner-error' | 'spawn-error';
      role?: Role;
      queueItemId: ReviewQueueItemId;
    }
  | { status: 'budget-exceeded'; finishedAt: string; costUsd: number; maxBudgetUsd: number; queueItemId: ReviewQueueItemId }
  | { status: 'aborted'; finishedAt: string; by: 'user'; signal: 'SIGTERM' | 'SIGKILL' };

/**
 * 실행 상태 파일 `runs/<id>.json`. `plumb run`만 쓰고 UI 서버는 읽기만 한다.
 * heartbeat는 `updatedAt` — pid 생존 여부는 화면에 두지 않는다 (work-run 6절 3번, 이슈 #5 코멘트).
 */
export interface RunState {
  id: RunId;
  pid: number;
  status: RunStatus;
  /** 현재(또는 멈춘) 단계 */
  stage: Stage;
  stages: StageRecord[];
  currentRole: Role | null;
  /** 첫 슬라이스는 1개 (work-run 3.1 "선택한 규칙") */
  ruleIds: RuleId[];
  roles: Record<Role, RoleUsage>;
  /** 전체 비용 누적 (추정). SDK가 비용을 안 주면 null — 0으로 보이지 않는다 */
  costUsd: number | null;
  limits: RunLimits;
  disputes: Dispute[];
  startedAt: string;
  /** heartbeat. 60초 넘게 그대로면 화면이 경고 (work-run 4절) */
  updatedAt: string;
  finishedAt?: string;
  /** 종료되면 채워진다. 진행 중이면 없음 */
  outcome?: RunOutcome;
  /** 마지막으로 가로챈 명령 출력. 아직 없으면 없음 ("아직 실행 출력 없음") */
  capturedOutput?: CapturedOutput;
  /** 이 실행이 만든 커밋 범위. 변경 로그 View의 세션 역매핑 (view-changelog 3절 "커밋 묶음 머리글 (세션)") */
  commits?: { from: string; to: string };
  /** 작업 worktree. 중단해도 테스트 파일과 구현은 여기 남는다 */
  worktree?: string;
}

/** 실행 목록 한 행 (`GET /api/runs`). RunState의 부분집합 */
export type RunSummary = Pick<RunState, 'id' | 'status' | 'stage' | 'startedAt' | 'finishedAt' | 'ruleIds'>;
