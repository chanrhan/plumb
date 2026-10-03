import { describe, expect, it } from 'vitest';
import { parseJunit } from '../../checks/junit.js';
import { decideStop, makeStopHook, newStopState, presentFilesOf, tallyFromJunit } from '../stop.js';

const stopInput = (active = false) => ({
  session_id: 's',
  transcript_path: '/t',
  cwd: '/svc',
  hook_event_name: 'Stop' as const,
  stop_hook_active: active,
});
const ctl = { signal: new AbortController().signal };

describe('decideStop — all-fail (test-writer)', () => {
  const expected = ['test/acceptance/refund-window.property.spec.ts'];
  it('담당 파일이 있고 전부 실패 → approve', () => {
    expect(
      decideStop('all-fail', {
        tally: { total: 3, passed: 0, failed: 3 },
        expectedFiles: expected,
        presentFiles: expected,
      }),
    ).toMatchObject({
      approve: true,
      by: 'condition',
    });
  });
  it('파일 없음 · 테스트 0 · 하나라도 통과 · 건너뜀 → block', () => {
    expect(
      decideStop('all-fail', { tally: { total: 3, passed: 0, failed: 3 }, expectedFiles: expected, presentFiles: [] })
        .reason,
    ).toMatch(/파일 없음/);
    expect(
      decideStop('all-fail', { tally: { total: 0, passed: 0, failed: 0 }, expectedFiles: [], presentFiles: [] }).reason,
    ).toMatch(/하나도 없다/);
    expect(
      decideStop('all-fail', {
        tally: { total: 3, passed: 1, failed: 2 },
        expectedFiles: expected,
        presentFiles: expected,
      }).reason,
    ).toMatch(/1\/3 테스트가 이미 통과/);
    expect(
      decideStop('all-fail', {
        tally: { total: 3, passed: 0, failed: 2 },
        expectedFiles: expected,
        presentFiles: expected,
      }).reason,
    ).toMatch(/건너뛰/);
  });
  it('러너 실패는 어느 종류든 block', () => {
    expect(
      decideStop('all-fail', { tally: { total: 0, passed: 0, failed: 0 }, runnerError: 'exit 127' }).reason,
    ).toMatch(/러너 실패/);
    expect(
      decideStop('all-pass-or-dispute', { tally: { total: 0, passed: 0, failed: 0 }, runnerError: 'x' }).approve,
    ).toBe(false);
  });
});

describe('decideStop — all-pass-or-dispute (implementer)', () => {
  it('전부 통과 → approve(condition), 이의 제기 → approve(dispute), 실패 남음 → block', () => {
    expect(decideStop('all-pass-or-dispute', { tally: { total: 3, passed: 3, failed: 0 } })).toMatchObject({
      approve: true,
      by: 'condition',
    });
    expect(
      decideStop('all-pass-or-dispute', { tally: { total: 3, passed: 1, failed: 2 }, hasDispute: true }),
    ).toMatchObject({ approve: true, by: 'dispute' });
    expect(decideStop('all-pass-or-dispute', { tally: { total: 3, passed: 1, failed: 2 } }).reason).toMatch(
      /2\/3 테스트가 아직 실패/,
    );
    expect(decideStop('all-pass-or-dispute', { tally: { total: 0, passed: 0, failed: 0 } }).approve).toBe(false);
  });
});

describe('makeStopHook — 차단 · 연속 상한', () => {
  it('조건 불만족이면 block + reason, 상한에 닿으면 approve하되 disputeRequired', async () => {
    const lines: string[] = [];
    const { hook, state } = makeStopHook({
      kind: 'all-pass-or-dispute',
      stopBlockLimit: 3,
      collect: async () => ({ tally: { total: 2, passed: 0, failed: 2 } }),
      log: (l) => lines.push(l),
    });
    expect(await hook(stopInput(), undefined, ctl)).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('2/2 테스트가 아직 실패'),
    });
    expect(await hook(stopInput(true), undefined, ctl)).toMatchObject({ decision: 'block' });
    expect(state).toMatchObject({ blocks: 2, consecutiveBlocks: 2, disputeRequired: false });
    expect(await hook(stopInput(true), undefined, ctl)).toEqual({});
    expect(state).toMatchObject({ blocks: 3, consecutiveBlocks: 3, disputeRequired: true, approvedBy: 'limit' });
    expect(lines).toEqual([
      '[stop] block (1/3): 2/2 테스트가 아직 실패한다',
      '[stop] block (2/3): 2/2 테스트가 아직 실패한다',
      '[stop] block (3/3) → 상한 — 끝내고 이의 제기 경로로: 2/2 테스트가 아직 실패한다',
    ]);
  });
  it('조건이 맞으면 approve하고 연속 카운터를 0으로', async () => {
    let failed = 1;
    const { hook, state } = makeStopHook({
      kind: 'all-pass-or-dispute',
      stopBlockLimit: 5,
      collect: async () => ({ tally: { total: 1, passed: 1 - failed, failed } }),
      log: () => {},
    });
    await hook(stopInput(), undefined, ctl);
    failed = 0;
    expect(await hook(stopInput(true), undefined, ctl)).toEqual({});
    expect(state).toMatchObject({ blocks: 1, consecutiveBlocks: 0, approvedBy: 'condition', disputeRequired: false });
  });
  it('증거 수집이 던지면 block으로 취급', async () => {
    const { hook } = makeStopHook({
      kind: 'all-fail',
      stopBlockLimit: 2,
      collect: async () => {
        throw new Error('vitest 없음');
      },
      log: () => {},
    });
    expect(await hook(stopInput(), undefined, ctl)).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('증거 수집 실패: vitest 없음'),
    });
  });
  it('stopBlockLimit 0은 거부', () => {
    expect(() =>
      makeStopHook({
        kind: 'all-fail',
        stopBlockLimit: 0,
        collect: async () => ({ tally: { total: 0, passed: 0, failed: 0 } }),
      }),
    ).toThrow();
  });
});

describe('JUnit → 증거', () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="test/acceptance/refund-window.property.spec.ts" file="/svc/test/acceptance/refund-window.property.spec.ts" tests="3" failures="1" errors="0" skipped="1">
    <testcase classname="test/acceptance/refund-window.property.spec.ts" name="a" time="0.1"><failure message="x">x</failure></testcase>
    <testcase classname="test/acceptance/refund-window.property.spec.ts" name="b" time="0.1"/>
    <testcase classname="test/acceptance/refund-window.property.spec.ts" name="c" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`;
  it('skipped는 분모에서 빼고, 파일 목록은 루트 기준 상대', () => {
    const report = parseJunit(xml, { root: '/svc' });
    expect(tallyFromJunit(report)).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(presentFilesOf(report)).toEqual(['test/acceptance/refund-window.property.spec.ts']);
  });
  it('newStopState', () => {
    expect(newStopState()).toEqual({ blocks: 0, consecutiveBlocks: 0, disputeRequired: false });
  });
});
