import { describe, expect, it } from 'vitest';
import { validateDecision } from '../index.js';
import { REDIS_DECISION } from './fixtures.js';

describe('validateDecision', () => {
  it('네 절이 다 있으면 incomplete 비어 있고 noReason false', () => {
    expect(validateDecision(REDIS_DECISION)).toEqual({ incomplete: [], noReason: false });
  });

  it('빈 절은 네 절 순서대로 incomplete에 들어간다. 공백만 있어도 빈 것이다', () => {
    expect(validateDecision({ ...REDIS_DECISION, accepted: '', rejected: '  \n ' })).toEqual({
      incomplete: ['rejected', 'tradeoff'],
      noReason: false,
    });
    expect(validateDecision({ ...REDIS_DECISION, decision: '', reason: '', rejected: '', accepted: '' })).toEqual({
      incomplete: ['decision', 'reason', 'rejected', 'tradeoff'],
      noReason: true,
    });
  });

  it('"사유 없음"은 이유만 본다 — 기각 · 감수가 비어도 noReason은 false (view-changelog 6절 3번)', () => {
    expect(validateDecision({ ...REDIS_DECISION, rejected: '', accepted: '' }).noReason).toBe(false);
    expect(validateDecision({ ...REDIS_DECISION, reason: '' })).toEqual({ incomplete: ['reason'], noReason: true });
  });
});
