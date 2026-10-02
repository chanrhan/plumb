import { describe, expect, it } from 'vitest';
import type { ApprovalState, RuleId } from '../../types/index.js';
import {
  COMMON_BLOCK_ID,
  computeBlockSummaries,
  computeStatusCounts,
  emptyStatusCounts,
  worstStatus,
} from '../summary.js';
import { record, rule } from './fixtures.js';

describe('computeStatusCounts · worstStatus', () => {
  it('상태별 집계. 비어 있으면 전부 0', () => {
    expect(computeStatusCounts([])).toEqual(emptyStatusCounts());
    expect(
      computeStatusCounts([
        record('pay.a', 'fail'),
        record('pay.b', 'pass-unverified'),
        record('pay.c', 'pass-unverified'),
        record('pay.d', 'unchecked'),
      ]),
    ).toEqual({ 'pass-verified': 0, 'pass-unverified': 2, recheck: 0, fail: 1, unchecked: 1 });
  });

  it('최악 상태: 🔴 > 🟠 > 🟡 > 🟢 > ⬜. 비어 있으면 null', () => {
    expect(worstStatus([])).toBeNull();
    expect(worstStatus(['unchecked', 'pass-verified'])).toBe('pass-verified');
    expect(worstStatus(['pass-unverified', 'recheck', 'pass-verified'])).toBe('recheck');
    expect(worstStatus(['unchecked', 'fail', 'recheck'])).toBe('fail');
  });
});

describe('computeBlockSummaries', () => {
  const approvalStates = new Map<RuleId, ApprovalState>([
    ['pay.a', 'approved'],
    ['pay.b', 'provisional'],
    ['auth.a', 'approved'],
    ['common.x', 'approved'],
  ]);

  it('블록별 규칙 수 · 승인 수 · 상태 집계. 블록 없는 규칙은 common. 순서는 최악 상태 우선, 같으면 ID 순', () => {
    const blocks = computeBlockSummaries({
      rules: [
        rule('pay.a', { block: 'payment' }),
        rule('pay.b', { block: 'payment' }),
        rule('auth.a', { block: 'auth' }),
        rule('common.x', { block: undefined }),
      ],
      statuses: [record('pay.a', 'pass-unverified'), record('pay.b', 'unchecked'), record('auth.a', 'fail')],
      approvalStates,
    });

    expect(blocks).toEqual([
      {
        id: 'auth',
        rules: 1,
        approved: 1,
        byStatus: { ...emptyStatusCounts(), fail: 1 },
      },
      {
        id: 'payment',
        rules: 2,
        approved: 1,
        byStatus: { ...emptyStatusCounts(), 'pass-unverified': 1, unchecked: 1 },
      },
      // 상태 기록이 없는 규칙: 규칙 수에는 들어가고 상태 집계에는 없다
      { id: COMMON_BLOCK_ID, rules: 1, approved: 1, byStatus: emptyStatusCounts() },
    ]);
  });

  it('상태가 같은 블록은 ID 순', () => {
    const blocks = computeBlockSummaries({
      rules: [rule('pay.a', { block: 'payment' }), rule('auth.a', { block: 'auth' })],
      statuses: [record('pay.a', 'unchecked'), record('auth.a', 'unchecked')],
      approvalStates,
    });
    expect(blocks.map((b) => b.id)).toEqual(['auth', 'payment']);
  });
});
