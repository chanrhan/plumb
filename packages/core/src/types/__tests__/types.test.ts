import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CheckFailure, RuleStatus, RuleStatusDetail, RunId, Stage } from '../index.js';
import * as types from '../index.js';

describe('@plumb/core types', () => {
  it('타입 모듈이 import된다 (순수 타입이라 런타임 export는 없다)', () => {
    expect(typeof types).toBe('object');
    expect(Object.keys(types)).toEqual([]);
  });

  it('리터럴 유니온 샘플이 타입 검사를 통과한다', () => {
    const status: RuleStatus = 'pass-verified';
    const stage: Stage = 4;
    const runId: RunId = 'r-0001';

    expectTypeOf<RuleStatus>().toEqualTypeOf<'pass-verified' | 'pass-unverified' | 'recheck' | 'fail' | 'unchecked'>();
    // @ts-expect-error 유니온 밖의 값은 거부된다
    const bad: RuleStatus = 'pass';

    expect([status, stage, runId, bad]).toHaveLength(4);
  });

  it('fail 상태는 비어 있지 않은 failures 없이 만들 수 없다 (§7.3)', () => {
    const failure: CheckFailure = {
      check: { kind: 'acceptance', ref: 'test/pay/refund-window.test.ts' },
      anchor: { file: 'test/pay/refund-window.test.ts', line: 1 },
      message: 'expected 7 days',
    };
    const fail: RuleStatusDetail = { status: 'fail', failures: [failure] };
    // @ts-expect-error 빈 배열로는 🔴를 만들 수 없다
    const empty: RuleStatusDetail = { status: 'fail', failures: [] };

    expect(fail.status).toBe('fail');
    expect(empty.status).toBe('fail');
  });
});
