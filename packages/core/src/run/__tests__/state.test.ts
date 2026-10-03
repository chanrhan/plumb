import { describe, expect, it } from 'vitest';
import type { ReviewQueueItem, RunState } from '../../types/index.js';
import { limitsOf, newRunState, RunRecorder } from '../state.js';

const config = {
  roles: {
    'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  run: { maxBudgetUsd: 1 },
};

function fakeStore() {
  const writes: RunState[] = [];
  const queue: ReviewQueueItem[] = [];
  return {
    writes,
    queue,
    store: {
      runs: {
        write: async (s: RunState) => {
          writes.push(s);
          return s;
        },
      },
      reviewQueue: {
        enqueue: async (input: Omit<ReviewQueueItem, 'id' | 'createdAt'>) => {
          const item = {
            ...input,
            id: `q-${String(queue.length + 1).padStart(4, '0')}`,
            createdAt: 't',
          } as ReviewQueueItem;
          queue.push(item);
          return item;
        },
      },
    } as never,
  };
}

let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 3, 0, 0, tick++));

describe('newRunState · limitsOf', () => {
  it('초기 상태: running · stage 1 · 역할 사용량 0 · 상한은 설정 스냅샷', () => {
    const s = newRunState({ id: 'r-0001', ruleIds: ['pay.refund-window'], config, pid: 42, worktree: '/w', now });
    expect(s).toMatchObject({
      id: 'r-0001',
      pid: 42,
      status: 'running',
      stage: 1,
      stages: [],
      costUsd: null,
      worktree: '/w',
    });
    expect(s.limits).toEqual({
      maxBudgetUsd: 1,
      stopBlockLimit: 5,
      maxTurns: { 'test-writer': 60, implementer: 80, injector: 30, 'rule-drafter': 1 },
    });
    expect(limitsOf({ ...config, run: undefined }).maxBudgetUsd).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('RunRecorder 전이', () => {
  it('startStage/finishStage: attempt가 오르고 result가 붙는다, 매 전이마다 저장', async () => {
    const { store, writes } = fakeStore();
    const rec = new RunRecorder(newRunState({ id: 'r-0001', ruleIds: ['a.b'], config, now }), store, now);
    await rec.startStage(2, 'test-writer');
    expect(rec.current).toMatchObject({ stage: 2, currentRole: 'test-writer' });
    await rec.finishStage({ stage: 2, tests: { total: 1, passed: 0, failed: 1 }, allFailed: true });
    await rec.startStage(2, 'test-writer'); // ⑤→② 되돌아간 경우
    expect(rec.current.stages.map((s) => [s.stage, s.attempt])).toEqual([
      [2, 1],
      [2, 2],
    ]);
    expect(rec.current.stages[0]?.result).toMatchObject({ allFailed: true });
    expect(rec.current.stages[0]?.finishedAt).toBeDefined();
    expect(writes).toHaveLength(3);
    await expect(rec.finishStage({ stage: 4, checkRunId: 'c-x', byRule: {} })).rejects.toThrow(/시작되지 않았다/);
  });

  it('recordRole: 턴 · 비용 누적(null은 유지), overBudget', async () => {
    const { store } = fakeStore();
    const rec = new RunRecorder(newRunState({ id: 'r-0001', ruleIds: ['a.b'], config, now }), store, now);
    await rec.recordRole('test-writer', { turns: 3, costUsd: 0.4, stopBlocks: 1, consecutiveStopBlocks: 0 });
    await rec.recordRole('implementer', { turns: 5, costUsd: null });
    expect(rec.current.roles['test-writer']).toEqual({
      turns: 3,
      stopBlocks: 1,
      consecutiveStopBlocks: 0,
      costUsd: 0.4,
    });
    expect(rec.current.roles.implementer.costUsd).toBeNull();
    expect(rec.current.costUsd).toBeCloseTo(0.4);
    expect(rec.overBudget()).toBe(false);
    await rec.recordRole('implementer', { turns: 1, costUsd: 0.7 });
    expect(rec.overBudget()).toBe(true);
  });

  it('fail → 검토 대기열 run-failed + outcome.queueItemId, budgetExceeded → budget-exceeded, complete, abort', async () => {
    const a = fakeStore();
    const rec = new RunRecorder(newRunState({ id: 'r-0001', ruleIds: ['a.b'], config, now }), a.store, now);
    await rec.fail('maxTurns', 'implementer');
    expect(rec.current.status).toBe('failed');
    expect(rec.current.outcome).toMatchObject({
      status: 'failed',
      reason: 'maxTurns',
      role: 'implementer',
      queueItemId: 'q-0001',
    });
    expect(a.queue[0]).toMatchObject({ kind: 'run-failed', runId: 'r-0001', ruleIds: ['a.b'] });

    const b = fakeStore();
    const rec2 = new RunRecorder(newRunState({ id: 'r-0002', ruleIds: ['a.b'], config, now }), b.store, now);
    await rec2.recordRole('implementer', { turns: 1, costUsd: 1.5 });
    await rec2.budgetExceeded();
    expect(rec2.current.outcome).toMatchObject({
      status: 'budget-exceeded',
      costUsd: 1.5,
      maxBudgetUsd: 1,
      queueItemId: 'q-0001',
    });
    expect(b.queue[0]?.kind).toBe('budget-exceeded');

    const c = fakeStore();
    const rec3 = new RunRecorder(newRunState({ id: 'r-0003', ruleIds: ['a.b'], config, now }), c.store, now);
    await rec3.complete();
    expect(rec3.current).toMatchObject({ status: 'completed', currentRole: null });
    expect(rec3.current.finishedAt).toBeDefined();
    const rec4 = new RunRecorder(newRunState({ id: 'r-0004', ruleIds: ['a.b'], config, now }), c.store, now);
    await rec4.abort();
    expect(rec4.current.outcome).toMatchObject({ status: 'aborted', by: 'user', signal: 'SIGTERM' });
    expect(c.queue).toHaveLength(0);
  });
});
