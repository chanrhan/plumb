import { describe, expect, it } from 'vitest';
import type { Quarantine } from '../../types/index.js';
import { computeOutOfScope, ruleBearingBlocks } from '../out-of-scope.js';
import { block, graph, record, rule } from './fixtures.js';

describe('computeOutOfScope', () => {
  it('규칙 0개 블록 = L1 도메인 블록 − 규칙 block 집합. app(entry) · lib · test · L0는 세지 않는다', () => {
    const g = graph();
    expect(ruleBearingBlocks(g)).toEqual(['payment', 'auth']);

    const out = computeOutOfScope({
      rules: [rule('pay.refund-window', { block: 'payment' })],
      graph: g,
      statuses: [],
      quarantined: [],
    });
    expect(out.blocksWithoutRules).toEqual(['auth']);
  });

  it('블록 없는 규칙(블록 공통)은 어느 블록도 덮지 않는다', () => {
    const out = computeOutOfScope({
      rules: [rule('common.no-console', { block: undefined })],
      graph: graph(),
      statuses: [],
      quarantined: [],
    });
    expect(out.blocksWithoutRules).toEqual(['payment', 'auth']);
  });

  it('lib는 kind와 무관하게 제외, 미분류 kind의 L1 노드도 제외', () => {
    const g = graph({
      blocks: [block('lib', 'app'), block('orders', 'domain'), block('misc', 'unclassified')],
      unclassified: [],
    });
    expect(ruleBearingBlocks(g)).toEqual(['orders']);
  });

  it('codeWithoutRules는 빈 배열(scope 미도입 — 규칙은 블록 전체를 덮는다), untestedFlows는 측정 불가', () => {
    const out = computeOutOfScope({ rules: [], graph: graph(), statuses: [], quarantined: [] });
    expect(out.codeWithoutRules).toEqual([]);
    expect(out.untestedFlows).toEqual({ unavailable: 'no-trace' });
  });

  it('rulesWithoutCode = check-missing 상태의 규칙만', () => {
    const missing = record('pay.refund-window', 'unchecked');
    missing.detail = { status: 'unchecked', reason: 'check-missing' };
    const out = computeOutOfScope({
      rules: [],
      graph: graph(),
      statuses: [
        missing,
        record('pay.payment-record', 'unchecked'), // not-run
        record('pay.ok', 'pass-unverified'),
        record('pay.bad', 'fail'),
      ],
      quarantined: [],
    });
    expect(out.rulesWithoutCode).toEqual([{ ruleId: 'pay.refund-window', reason: 'check-missing' }]);
  });

  it('unclassifiedFiles = graph.unclassified.length, quarantined는 그대로 (복사본)', () => {
    const quarantined: Quarantine[] = [{ ref: 'test/acceptance/flaky.spec.ts', passes: 2, runs: 3 }];
    const out = computeOutOfScope({ rules: [], graph: graph(), statuses: [], quarantined });
    expect(out.unclassifiedFiles).toBe(2);
    expect(out.quarantined).toEqual(quarantined);
    expect(out.quarantined).not.toBe(quarantined);

    expect(
      computeOutOfScope({ rules: [], graph: graph({ unclassified: [] }), statuses: [], quarantined: [] }),
    ).toMatchObject({ unclassifiedFiles: 0, quarantined: [] });
  });
});
