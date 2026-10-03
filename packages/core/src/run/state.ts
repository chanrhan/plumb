/**
 * 실행 상태 전이 (이슈 #86, 타입 `RunState` · `StageRecord` · `RunOutcome`). 전이마다 저장소에 쓴다 — 파일이 진실이고 UI는 그것만 읽는다(work-run).
 * 실패 · 예산 초과는 검토 대기열에 올리고 `queueItemId`를 outcome에 적는다(기획안 §15.4).
 */

import type { Store } from '../store/index.js';
import type {
  CapturedOutput,
  Dispute,
  PlumbConfig,
  Role,
  RoleUsage,
  RuleId,
  RunId,
  RunLimits,
  RunOutcome,
  RunState,
  RunStatus,
  Stage,
  StageResult,
} from '../types/index.js';

export const ROLES: readonly Role[] = ['test-writer', 'implementer', 'injector', 'rule-drafter'];

export function emptyUsage(): RoleUsage {
  return { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null };
}

export function limitsOf(config: Pick<PlumbConfig, 'roles' | 'stopBlockLimit' | 'run'>): RunLimits {
  const maxTurns: Partial<Record<Role, number>> = {};
  for (const role of ROLES) {
    const rc = config.roles?.[role];
    if (rc) maxTurns[role] = rc.maxTurns;
  }
  return {
    maxBudgetUsd: config.run?.maxBudgetUsd ?? Number.POSITIVE_INFINITY,
    stopBlockLimit: config.stopBlockLimit,
    maxTurns,
  };
}

export interface NewRunInput {
  id: RunId;
  ruleIds: RuleId[];
  config: Pick<PlumbConfig, 'roles' | 'stopBlockLimit' | 'run'>;
  pid?: number;
  worktree?: string;
  now?: () => Date;
}

export function newRunState(input: NewRunInput): RunState {
  const at = (input.now ?? (() => new Date()))().toISOString();
  return {
    id: input.id,
    pid: input.pid ?? process.pid,
    status: 'running',
    stage: 1,
    stages: [],
    currentRole: null,
    ruleIds: input.ruleIds,
    roles: {
      'test-writer': emptyUsage(),
      implementer: emptyUsage(),
      injector: emptyUsage(),
      'rule-drafter': emptyUsage(),
    },
    costUsd: null,
    limits: limitsOf(input.config),
    disputes: [],
    startedAt: at,
    updatedAt: at,
    ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
  };
}

export interface RoleOutcomeInput {
  turns: number;
  costUsd: number | null;
  stopBlocks?: number;
  consecutiveStopBlocks?: number;
}

/** 상태 파일을 들고 전이시키는 객체. 모든 전이는 `persist()`로 끝난다 */
export class RunRecorder {
  constructor(
    private state: RunState,
    private readonly store: Pick<Store, 'runs' | 'reviewQueue'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get current(): RunState {
    return this.state;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  async persist(): Promise<RunState> {
    this.state = { ...this.state, updatedAt: this.stamp() };
    await this.store.runs.write(this.state);
    return this.state;
  }

  /** heartbeat(work-run 4절: 60초 넘게 그대로면 경고) */
  heartbeat(): Promise<RunState> {
    return this.persist();
  }

  async startStage(stage: Stage, role: Role | null): Promise<RunState> {
    const attempt = this.state.stages.filter((s) => s.stage === stage).length + 1;
    this.state = {
      ...this.state,
      stage,
      currentRole: role,
      stages: [...this.state.stages, { stage, attempt, role, startedAt: this.stamp() }],
    };
    return this.persist();
  }

  async finishStage(result: StageResult): Promise<RunState> {
    const stages = [...this.state.stages];
    const idx = stages.map((s) => s.stage).lastIndexOf(result.stage);
    if (idx < 0) throw new Error(`stage ${result.stage}가 시작되지 않았다`);
    const rec = stages[idx];
    if (rec) stages[idx] = { ...rec, finishedAt: this.stamp(), result };
    this.state = { ...this.state, stages, currentRole: null };
    return this.persist();
  }

  /** 역할 실행 1회의 원자료를 누적한다 (`RoleUsage` · 전체 `costUsd`) */
  async recordRole(role: Role, r: RoleOutcomeInput): Promise<RunState> {
    const prev = this.state.roles[role];
    const usage: RoleUsage = {
      turns: prev.turns + r.turns,
      stopBlocks: prev.stopBlocks + (r.stopBlocks ?? 0),
      consecutiveStopBlocks: r.consecutiveStopBlocks ?? prev.consecutiveStopBlocks,
      costUsd: r.costUsd === null ? prev.costUsd : (prev.costUsd ?? 0) + r.costUsd,
    };
    const costUsd = r.costUsd === null ? this.state.costUsd : (this.state.costUsd ?? 0) + r.costUsd;
    this.state = { ...this.state, roles: { ...this.state.roles, [role]: usage }, costUsd };
    return this.persist();
  }

  async addDispute(d: Dispute): Promise<RunState> {
    this.state = { ...this.state, disputes: [...this.state.disputes, d] };
    return this.persist();
  }

  /** 재검토 결과로 같은 id의 항목을 바꾼다 (#88) */
  async replaceDispute(d: Dispute): Promise<RunState> {
    this.state = { ...this.state, disputes: this.state.disputes.map((x) => (x.id === d.id ? d : x)) };
    return this.persist();
  }

  async setCapturedOutput(captured: CapturedOutput): Promise<RunState> {
    this.state = { ...this.state, capturedOutput: captured };
    return this.persist();
  }

  /** 예산을 넘겼는가 (`run.maxBudgetUsd`, 없으면 무한) */
  overBudget(): boolean {
    return this.state.costUsd !== null && this.state.costUsd > this.state.limits.maxBudgetUsd;
  }

  async complete(): Promise<RunState> {
    return this.finish('completed', { status: 'completed', finishedAt: this.stamp() });
  }

  async fail(
    reason: Extract<RunOutcome, { status: 'failed' }>['reason'],
    role?: Role,
    summary?: string,
  ): Promise<RunState> {
    const item = await this.store.reviewQueue.enqueue({
      kind: 'run-failed',
      ruleIds: this.state.ruleIds,
      runId: this.state.id,
      summary: summary ?? `실행 실패: ${reason}${role ? ` (${role})` : ''}`,
    });
    return this.finish('failed', {
      status: 'failed',
      finishedAt: this.stamp(),
      reason,
      ...(role === undefined ? {} : { role }),
      queueItemId: item.id,
    });
  }

  async budgetExceeded(): Promise<RunState> {
    const costUsd = this.state.costUsd ?? 0;
    const item = await this.store.reviewQueue.enqueue({
      kind: 'budget-exceeded',
      ruleIds: this.state.ruleIds,
      runId: this.state.id,
      summary: `예산 초과: $${costUsd.toFixed(4)} > $${this.state.limits.maxBudgetUsd}`,
    });
    return this.finish('budget-exceeded', {
      status: 'budget-exceeded',
      finishedAt: this.stamp(),
      costUsd,
      maxBudgetUsd: this.state.limits.maxBudgetUsd,
      queueItemId: item.id,
    });
  }

  async abort(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<RunState> {
    return this.finish('aborted', { status: 'aborted', finishedAt: this.stamp(), by: 'user', signal });
  }

  private async finish(status: RunStatus, outcome: RunOutcome): Promise<RunState> {
    this.state = { ...this.state, status, currentRole: null, finishedAt: outcome.finishedAt, outcome };
    return this.persist();
  }
}
