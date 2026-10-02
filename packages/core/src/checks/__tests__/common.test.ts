import { describe, expect, it } from 'vitest';
import type { CheckRef, CheckResult } from '../../types/index.js';
import { COMMON_CHECK_TITLES, commonCheckIndexOf, computeCommonRows, depcruiseRuleName } from '../common.js';
import { REFUND_CHECK, result } from './fixtures.js';

const staticRef = (name: string): CheckRef => ({ kind: 'static', ref: `depcruise:${name}` });

const PUBLIC_ENTRY = staticRef('block-1-public-entry-only');
const CROSS_DOMAIN = staticRef('block-1-public-entry-only-cross-domain');
const NO_CYCLES = staticRef('block-2-no-cycles');
const DECLARED = staticRef('block-2-declared-direction');
const PROJECT_RULE = staticRef('prisma-only-in-repo');

function violation(check: CheckRef, file: string, line: number, to: string): CheckResult {
  return result(check, 'fail', {
    failure: { check, anchor: { block: 'app', file, line }, message: `${file} → ${to}` },
  });
}

describe('computeCommonRows', () => {
  it('결과가 없으면 세 행 모두 unchecked. (3)은 M8까지 언제나 unchecked', () => {
    const rows = computeCommonRows([]);
    expect(rows).toEqual([
      { index: 1, title: COMMON_CHECK_TITLES[1], result: { status: 'unchecked' } },
      { index: 2, title: COMMON_CHECK_TITLES[2], result: { status: 'unchecked' } },
      { index: 3, title: COMMON_CHECK_TITLES[3], result: { status: 'unchecked' } },
    ]);
  });

  it('block-1-* 통과 → (1) pass, block-2-* 통과 → (2) pass', () => {
    const rows = computeCommonRows([
      result(PUBLIC_ENTRY, 'pass'),
      result(CROSS_DOMAIN, 'pass'),
      result(NO_CYCLES, 'pass'),
      result(DECLARED, 'pass'),
    ]);
    expect(rows[0]?.result).toEqual({ status: 'pass', violations: [] });
    expect(rows[1]?.result).toEqual({ status: 'pass', violations: [] });
    expect(rows[2]?.result).toEqual({ status: 'unchecked' });
  });

  it('한 행의 규칙 중 하나라도 fail이면 fail + 위반 목록 + 첫 위반의 anchor. 다른 행은 영향 없다', () => {
    const rows = computeCommonRows([
      result(PUBLIC_ENTRY, 'pass'),
      violation(CROSS_DOMAIN, 'src/app/page.tsx', 3, 'src/domains/payment/internal.ts'),
      violation(CROSS_DOMAIN, 'src/app/layout.tsx', 7, 'src/domains/auth/session.ts'),
      result(NO_CYCLES, 'pass'),
    ]);
    const first = rows[0];
    expect(first?.result.status).toBe('fail');
    if (first?.result.status !== 'fail') throw new Error('unreachable');
    expect(first.result.violations).toEqual([
      {
        rule: 'block-1-public-entry-only-cross-domain',
        from: { block: 'app', file: 'src/app/page.tsx', line: 3 },
        to: 'src/domains/payment/internal.ts',
        fromBlock: 'app',
        toBlock: '',
      },
      {
        rule: 'block-1-public-entry-only-cross-domain',
        from: { block: 'app', file: 'src/app/layout.tsx', line: 7 },
        to: 'src/domains/auth/session.ts',
        fromBlock: 'app',
        toBlock: '',
      },
    ]);
    expect(first.anchor).toEqual({ block: 'app', file: 'src/app/page.tsx', line: 3 });

    expect(rows[1]?.result).toEqual({ status: 'pass', violations: [] });
    expect(rows[1]?.anchor).toBeUndefined();
  });

  it('error 결과도 위반으로 센다. failure가 없으면 file 빈 문자열 · line 1', () => {
    const rows = computeCommonRows([{ check: NO_CYCLES, ruleIds: [], outcome: 'error' }]);
    expect(rows[1]?.result).toEqual({
      status: 'fail',
      violations: [{ rule: 'block-2-no-cycles', from: { file: '', line: 1 }, to: '', fromBlock: '', toBlock: '' }],
    });
  });

  it('프로젝트 고유 정적 규칙과 정적이 아닌 결과는 무시한다', () => {
    const rows = computeCommonRows([violation(PROJECT_RULE, 'src/x.ts', 1, 'prisma'), result(REFUND_CHECK, 'fail')]);
    expect(rows.map((row) => row.result.status)).toEqual(['unchecked', 'unchecked', 'unchecked']);
    expect(commonCheckIndexOf(result(PROJECT_RULE, 'pass'))).toBeNull();
    expect(commonCheckIndexOf(result(REFUND_CHECK, 'pass'))).toBeNull();
    expect(commonCheckIndexOf(result(PUBLIC_ENTRY, 'pass'))).toBe(1);
    expect(commonCheckIndexOf(result(DECLARED, 'pass'))).toBe(2);
  });

  it('depcruiseRuleName: 접두어를 벗긴다. 없으면 그대로', () => {
    expect(depcruiseRuleName('depcruise:block-1-public-entry-only')).toBe('block-1-public-entry-only');
    expect(depcruiseRuleName('block-2-no-cycles')).toBe('block-2-no-cycles');
  });
});
