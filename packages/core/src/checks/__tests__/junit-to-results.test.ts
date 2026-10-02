import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Rule, RuleYaml } from '../../types/index.js';
import { checkRefsOf, parseJunit, toCheckResults } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const ROOT = '/repo/testbed';

/** 정규화된 규칙 (`Rule`): checks는 CheckRef 객체 */
const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: ['pay.payment-record'],
  checks: [{ kind: 'pbt', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};

/** YAML 모양 (`RuleYaml`): checks 문자열 축약 — acceptance로 읽힌다 */
const RECORD_RULE_YAML: RuleYaml = {
  id: 'pay.payment-record',
  block: 'payment',
  kind: 'technical',
  statement: 'THE SYSTEM SHALL 결제 성공 시 Payment 레코드를 남긴다',
  source: 'code:src/domains/payment/index.ts',
  risk: 'normal',
  checks: ['test/acceptance/payment-record.spec.ts'],
};

/** 정적 검사만 있는 규칙 — JUnit과 무관 */
const STATIC_RULE: Rule = {
  id: 'payment.public-entry-only',
  block: 'payment',
  kind: 'architecture',
  statement: 'THE SYSTEM SHALL 블록 밖에서는 index.ts로만 import한다',
  source: 'plan:ARCH-01',
  risk: 'normal',
  depends_on: [],
  checks: [{ kind: 'static', ref: 'depcruise:block-1-public-entry-only' }],
};

describe('toCheckResults — 매핑과 unmapped 분리', () => {
  const report = parseJunit(fixture('fail-pbt.xml'), { root: ROOT });
  const { results, unmapped } = toCheckResults(report, [REFUND_RULE, RECORD_RULE_YAML, STATIC_RULE], { root: ROOT });

  it('규칙에 매핑된 검사 파일마다 CheckResult 하나 (보고서 순서)', () => {
    expect(results.map((result) => result.check.ref)).toEqual([
      'test/acceptance/refund-window.property.spec.ts',
      'test/acceptance/payment-record.spec.ts',
    ]);
    expect(results.map((result) => result.ruleIds)).toEqual([['pay.refund-window'], ['pay.payment-record']]);
  });

  it('Rule의 CheckRef kind는 그대로, RuleYaml 문자열은 acceptance', () => {
    expect(results[0]?.check).toEqual({ kind: 'pbt', ref: 'test/acceptance/refund-window.property.spec.ts' });
    expect(results[1]?.check).toEqual({ kind: 'acceptance', ref: 'test/acceptance/payment-record.spec.ts' });
  });

  it('단위 테스트(src/**/*.test.ts)는 어느 규칙에도 없다 → unmapped (규칙 근거 아님, 기획안 §8.2)', () => {
    expect(unmapped).toHaveLength(2);
    expect(unmapped.every((testcase) => testcase.file === 'src/domains/payment/__tests__/payment.unit.test.ts')).toBe(
      true,
    );
    expect(unmapped.every((testcase) => testcase.status === 'pass')).toBe(true);
  });

  it('<error> testcase → outcome error, anchor는 파일 + line 1', () => {
    expect(results[1]).toMatchObject({
      outcome: 'error',
      durationSec: 0.005,
      failure: {
        check: { kind: 'acceptance', ref: 'test/acceptance/payment-record.spec.ts' },
        anchor: { file: 'test/acceptance/payment-record.spec.ts', line: 1 },
        message: 'connect ECONNREFUSED 127.0.0.1:5432',
      },
    });
    expect(results[1]?.failure?.counterexample).toBeUndefined();
    expect(results[1]?.failure?.seed).toBeUndefined();
  });

  it('규칙이 없으면 결과도 없고 전부 unmapped', () => {
    const none = toCheckResults(report, []);
    expect(none.results).toEqual([]);
    expect(none.unmapped).toHaveLength(7);
  });
});

describe('toCheckResults — 같은 파일의 testcase 접기', () => {
  const report = parseJunit(fixture('fail-pbt.xml'), { root: ROOT });
  const { results } = toCheckResults(report, [REFUND_RULE], { root: ROOT });
  const folded = results[0];

  it('4개(fail · fail · skipped · pass) → 하나, 하나라도 실패면 fail', () => {
    expect(results).toHaveLength(1);
    expect(folded?.outcome).toBe('fail');
  });

  it('첫 실패가 failure — 반례 · 시드 · anchor가 CheckFailure로 옮겨진다', () => {
    expect(folded?.failure).toEqual({
      check: { kind: 'pbt', ref: 'test/acceptance/refund-window.property.spec.ts' },
      anchor: { file: 'test/acceptance/refund-window.property.spec.ts', line: 42 },
      message: expect.stringContaining('Property failed after 1 test(s)'),
      counterexample: '[8]',
      seed: '42',
    });
  });

  it('durationSec은 testcase time의 합', () => {
    expect(folded?.durationSec).toBeCloseTo(0.023415946 + 0.007627768 + 0 + 0.000399556, 9);
  });

  it('전부 통과면 pass · failure 없음, 전부 skipped면 skipped', () => {
    const passReport = parseJunit(fixture('pass.xml'));
    const unitRule: Rule = {
      ...STATIC_RULE,
      id: 'payment.unit',
      checks: [{ kind: 'acceptance', ref: 'src/domains/payment/__tests__/payment.unit.test.ts' }],
    };
    const passed = toCheckResults(passReport, [unitRule]).results[0];
    expect(passed).toMatchObject({ outcome: 'pass', ruleIds: ['payment.unit'] });
    expect(passed?.failure).toBeUndefined();
    expect(passed?.durationSec).toBeGreaterThan(0);

    const skippedOnly = parseJunit(
      '<testsuites><testsuite name="test/s.spec.ts"><testcase classname="test/s.spec.ts" name="a"><skipped/></testcase></testsuite></testsuites>',
    );
    const skipRule: Rule = { ...STATIC_RULE, id: 'x.skip', checks: [{ kind: 'acceptance', ref: 'test/s.spec.ts' }] };
    expect(toCheckResults(skippedOnly, [skipRule]).results[0]).toMatchObject({ outcome: 'skipped' });
    expect(toCheckResults(skippedOnly, [skipRule]).results[0]?.durationSec).toBeUndefined();
  });
});

describe('toCheckResults — 경로 정규화 · 다중 규칙', () => {
  it('같은 파일을 두 규칙이 가리키면 ruleIds에 둘 다, kind는 첫 규칙 것', () => {
    const report = parseJunit(fixture('fail-pbt.xml'), { root: ROOT });
    const second: Rule = {
      ...REFUND_RULE,
      id: 'pay.refund-window-2',
      checks: [{ kind: 'acceptance', ref: './test/acceptance/refund-window.property.spec.ts' }],
    };
    const { results } = toCheckResults(report, [REFUND_RULE, second], { root: ROOT });
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleIds).toEqual(['pay.refund-window', 'pay.refund-window-2']);
    expect(results[0]?.check.kind).toBe('pbt');
  });

  it('ref가 절대 경로여도 root로 상대화해 매핑한다', () => {
    const report = parseJunit(fixture('fail-pbt.xml'));
    const absolute: Rule = {
      ...REFUND_RULE,
      checks: [{ kind: 'pbt', ref: `${ROOT}/test/acceptance/refund-window.property.spec.ts` }],
    };
    const { results, unmapped } = toCheckResults(report, [absolute], { root: ROOT });
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleIds).toEqual(['pay.refund-window']);
    expect(unmapped).toHaveLength(3);
  });

  it('checkRefsOf: Rule · RuleYaml · checks 없음', () => {
    expect(checkRefsOf(REFUND_RULE)).toEqual(REFUND_RULE.checks);
    expect(checkRefsOf(RECORD_RULE_YAML)).toEqual([
      { kind: 'acceptance', ref: 'test/acceptance/payment-record.spec.ts' },
    ]);
    expect(checkRefsOf({ ...RECORD_RULE_YAML, checks: undefined })).toEqual([]);
  });
});
