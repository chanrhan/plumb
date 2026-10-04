import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunState } from '../../types/index.js';
import { ValidationError } from '../errors.js';
import { openStore, type Store } from '../index.js';

function state(id: `r-${string}`, startedAt: string, status: RunState['status'] = 'running'): RunState {
  return {
    id,
    pid: 1,
    status,
    stage: 2,
    stages: [],
    currentRole: 'test-writer',
    ruleIds: ['pay.refund-window'],
    roles: {
      'test-writer': { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null },
      implementer: { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null },
      injector: { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null },
      'rule-drafter': { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null },
    },
    costUsd: null,
    limits: { maxBudgetUsd: 10, stopBlockLimit: 5, maxTurns: {} },
    disputes: [],
    startedAt,
    updatedAt: startedAt,
  };
}

describe('store.runs · store.reviewQueue', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-runs-'));
    store = openStore({ store: './.plumb-store' }, dir);
    await store.init();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('nextId는 r-0001부터, 쓰고 읽고 목록(최근 순) · active(진행 중 하나)', async () => {
    expect(await store.runs.nextId()).toBe('r-0001');
    await store.runs.write(state('r-0001', '2026-10-03T00:00:00.000Z', 'completed'));
    await store.runs.write(state('r-0002', '2026-10-03T01:00:00.000Z'));
    expect(await store.runs.nextId()).toBe('r-0003');
    expect((await store.runs.get('r-0002'))?.status).toBe('running');
    expect((await store.runs.list()).map((r) => r.id)).toEqual(['r-0002', 'r-0001']);
    expect((await store.runs.active())?.id).toBe('r-0002');
    expect(await store.runs.get('r-0009')).toBeUndefined();
  });

  it('모양이 어긋나면 ValidationError (id · status · stage)', async () => {
    await expect(store.runs.write({ ...state('r-0001', 'x'), id: 'run-1' })).rejects.toBeInstanceOf(ValidationError);
    await expect(store.runs.write({ ...state('r-0001', 'x'), status: 'done' })).rejects.toBeInstanceOf(ValidationError);
    await expect(store.runs.write({ ...state('r-0001', 'x'), stage: 7 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('검토 대기열: enqueue가 q-nnnn을 매기고, list(openOnly)가 미처리만, status().reviewQueue에 반영', async () => {
    const a = await store.reviewQueue.enqueue({
      kind: 'run-failed',
      ruleIds: ['pay.refund-window'],
      runId: 'r-0001',
      summary: '실행 실패: maxTurns',
    });
    const b = await store.reviewQueue.enqueue({
      kind: 'dispute',
      ruleIds: ['pay.refund-window'],
      summary: '7일 경계 해석이 갈린다',
    });
    expect([a.id, b.id]).toEqual(['q-0001', 'q-0002']);
    expect((await store.reviewQueue.list()).map((i) => i.id)).toEqual(['q-0001', 'q-0002']);
    expect((await store.status()).reviewQueue).toBe(2);
    await expect(
      store.reviewQueue.enqueue({ kind: 'bogus' as never, ruleIds: [], summary: 'x' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.reviewQueue.enqueue({ kind: 'dispute', ruleIds: [], summary: '  ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
