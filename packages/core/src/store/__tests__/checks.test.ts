import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckRun } from '../../types/index.js';
import { toStatusResponse, ValidationError } from '../index.js';
import { makeTempStore, REFUND_RULE, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

function checkRun(runId: `c-${string}`, finishedAt: string, overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    runId,
    commit: 'a1b2c3d',
    startedAt: finishedAt,
    finishedAt,
    runner: { exitCode: 0 },
    results: [
      {
        check: REFUND_RULE.checks[0] ?? { kind: 'acceptance', ref: 'x' },
        ruleIds: [REFUND_RULE.id],
        outcome: 'fail',
        durationSec: 0.12,
        failure: {
          check: REFUND_RULE.checks[0] ?? { kind: 'acceptance', ref: 'x' },
          anchor: { block: 'payment', file: 'test/acceptance/refund-window.property.spec.ts', line: 12 },
          message: 'expected 7 to be 30',
          counterexample: '[8]',
          seed: '42',
        },
      },
    ],
    quarantined: [{ ref: 'test/acceptance/flaky.spec.ts', passes: 2, runs: 3 }],
    counts: { junit: 1, static: 0 },
    storeStatus: 'ok',
    ...overrides,
  };
}

describe('store.checks', () => {
  it('write → checks/<runId>.json (들여쓴 JSON, 임시 파일 없음) → list · latest 왕복', async () => {
    const run = checkRun('c-0001', '2026-10-01T10:00:00.000Z', { metrics: { noReasonEvents: 1, totalEvents: 4 } });
    const written = await t.store.checks.write(run);
    expect(written).toEqual(run);

    const text = await readFile(t.store.paths.check('c-0001'), 'utf8');
    expect(JSON.parse(text)).toEqual(run);
    expect(text.endsWith('\n')).toBe(true);
    expect(await readdir(t.store.paths.checksDir)).toEqual(['c-0001.json']);

    expect(await t.store.checks.list()).toEqual([run]);
    expect(await t.store.checks.latest()).toEqual(run);
  });

  it('list는 finishedAt 시각순(파일 이름 순이 아니다), latest는 마지막', async () => {
    await t.store.checks.write(checkRun('c-0001', '2026-10-01T10:00:00.000Z'));
    await t.store.checks.write(checkRun('c-0003', '2026-10-01T23:00:00.000Z'));
    await t.store.checks.write(checkRun('c-0002', '2026-10-02T08:00:00.000Z'));

    const runs = await t.store.checks.list();
    expect(runs.map((run) => run.runId)).toEqual(['c-0001', 'c-0003', 'c-0002']);
    expect((await t.store.checks.latest())?.runId).toBe('c-0002');
  });

  it('비어 있으면 list [] · latest null · status().lastCheck null', async () => {
    expect(await t.store.checks.list()).toEqual([]);
    expect(await t.store.checks.latest()).toBeNull();
    expect((await t.store.status()).lastCheck).toBeNull();
  });

  it('status().lastCheck는 latest()의 { runId, commit, finishedAt }', async () => {
    await t.store.checks.write(checkRun('c-0001', '2026-10-01T10:00:00.000Z', { commit: 'old0000' }));
    await t.store.checks.write(checkRun('c-0002', '2026-10-02T08:00:00.000Z', { commit: 'new1111' }));

    const status = await t.store.status();
    expect(status.lastCheck).toEqual({ runId: 'c-0002', commit: 'new1111', finishedAt: '2026-10-02T08:00:00.000Z' });
    expect(toStatusResponse(status).lastCheck).toEqual({ commit: 'new1111', finishedAt: '2026-10-02T08:00:00.000Z' });
  });

  it('스키마에 어긋나는 실행은 ValidationError, 아무것도 쓰지 않는다', async () => {
    await expect(t.store.checks.write({ runId: 'c-0001' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.checks.write(checkRun('c-0001', 'not-a-date'))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      t.store.checks.write({ ...checkRun('c-0001', '2026-10-01T10:00:00.000Z'), storeStatus: 'fine' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // runId가 c- 형식이 아니면 거부
    await expect(
      t.store.checks.write({ ...checkRun('c-0001', '2026-10-01T10:00:00.000Z'), runId: 'r-0001' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(t.store.paths.checksDir)).toEqual([]);
  });

  it('러너가 죽은 실행도 기록한다 (exitCode · stderrTail, 결과 없음)', async () => {
    const dead = checkRun('c-dead', '2026-10-02T08:00:00.000Z', {
      runner: { exitCode: 1, stderrTail: ['Error: vitest not found'] },
      results: [],
      quarantined: [],
      counts: { junit: 0, static: 0 },
    });
    await t.store.checks.write(dead);
    expect(await t.store.checks.latest()).toEqual(dead);
  });
});
