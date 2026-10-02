import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allCases, findAnchor, JunitParseError, parseJunit, toRootRelative } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** fail-pbt.xml의 절대 프레임이 가리키는 대상 루트 */
const ROOT = '/repo/testbed';

describe('parseJunit — 통과만 (testbed `pnpm test:junit` 실제 출력)', () => {
  const report = parseJunit(fixture('pass.xml'));

  it('testsuite 하나 · testcase 7개 · 전부 pass', () => {
    expect(report.suites).toHaveLength(1);
    expect(report.totals).toMatchObject({ tests: 7, passed: 7, failures: 0, errors: 0, skipped: 0 });
    expect(allCases(report).every((testcase) => testcase.status === 'pass')).toBe(true);
    expect(allCases(report).every((testcase) => testcase.failure === undefined)).toBe(true);
  });

  it('Vitest는 file 속성이 없다 → classname에서 파일 경로를 읽는다', () => {
    const suite = report.suites[0];
    expect(suite?.file).toBe('src/domains/payment/__tests__/payment.unit.test.ts');
    for (const testcase of allCases(report)) {
      expect(testcase.file).toBe('src/domains/payment/__tests__/payment.unit.test.ts');
      expect(testcase.classname).toBe('src/domains/payment/__tests__/payment.unit.test.ts');
    }
  });

  it('id = classname + name, name의 XML 엔티티는 풀린다, time은 초(숫자)', () => {
    const first = allCases(report)[0];
    expect(first?.name).toBe('createPayment > amount·currency 로 결제를 만들고 status 는 PAID 다');
    expect(first?.id).toBe(
      'src/domains/payment/__tests__/payment.unit.test.ts::createPayment > amount·currency 로 결제를 만들고 status 는 PAID 다',
    );
    expect(first?.timeSec).toBeCloseTo(0.004215814, 9);
    // testsuites@time(0.0135)이 아니라 testcase@time의 합
    expect(report.totals.timeSec).toBeCloseTo(
      0.004215814 + 0.00268332 + 0.001542798 + 0.000607151 + 0.000376158 + 0.000667794 + 0.002003473,
      9,
    );
  });
});

describe('parseJunit — 실패 + fast-check 반례 (fail-pbt.xml)', () => {
  const report = parseJunit(fixture('fail-pbt.xml'), { root: ROOT });
  const [pbt, plain, skipped, passed] = report.suites[0]?.cases ?? [];

  it('집계는 testcase를 직접 센다', () => {
    expect(report.suites).toHaveLength(3);
    expect(report.totals).toEqual({
      tests: 7,
      passed: 3,
      failures: 2,
      errors: 1,
      skipped: 1,
      timeSec: expect.closeTo(0.023415946 + 0.007627768 + 0 + 0.000399556 + 0.005 + 0.004215814 + 0.010667794, 9),
    });
  });

  it('PBT 실패: counterexample · seed · anchor.line이 채워진다 (완료 증거)', () => {
    expect(pbt?.status).toBe('fail');
    expect(pbt?.failure?.kind).toBe('failure');
    expect(pbt?.failure?.type).toBe('Error');
    expect(pbt?.failure?.counterexample).toBe('[8]');
    expect(pbt?.failure?.seed).toBe('42');
    // 첫 test/ 프레임은 `at /repo/testbed/test/…:42:22` (절대) — root로 상대화된다. 뒤의 :38:8 · setup.ts:22가 아니다
    expect(pbt?.failure?.anchor).toEqual({ file: 'test/acceptance/refund-window.property.spec.ts', line: 42 });
    expect(pbt?.failure?.message.startsWith('Property failed after 1 test(s)')).toBe(true);
    expect(pbt?.failure?.body).toContain('Got error: AssertionError: expected 8 to be less than 8');
  });

  it('일반 실패: ❯ 상대 프레임에서 anchor, 반례 · 시드는 없다', () => {
    expect(plain?.status).toBe('fail');
    expect(plain?.failure?.message).toBe('expected 2 to be 3 // Object.is equality');
    expect(plain?.failure?.type).toBe('AssertionError');
    expect(plain?.failure?.anchor).toEqual({ file: 'test/acceptance/refund-window.property.spec.ts', line: 57 });
    expect(plain?.failure?.counterexample).toBeUndefined();
    expect(plain?.failure?.seed).toBeUndefined();
  });

  it('<skipped/> → skipped, 빈 testcase → pass', () => {
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.failure).toBeUndefined();
    expect(passed?.status).toBe('pass');
  });

  it('<error>: status error, 스택에 test/·src/ 프레임이 없으면 testcase 파일 + line 1', () => {
    const errored = report.suites[1]?.cases[0];
    expect(errored?.status).toBe('error');
    expect(errored?.failure?.kind).toBe('error');
    expect(errored?.failure?.message).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(errored?.failure?.anchor).toEqual({ file: 'test/acceptance/payment-record.spec.ts', line: 1 });
  });

  it('root 없이 파싱하면 상대 ❯ 프레임이 anchor가 된다 (절대 프레임은 상대화 불가 → 건너뜀)', () => {
    const noRoot = parseJunit(fixture('fail-pbt.xml'));
    expect(noRoot.suites[0]?.cases[0]?.failure?.anchor).toEqual({
      file: 'test/acceptance/refund-window.property.spec.ts',
      line: 42,
    });
  });
});

describe('parseJunit — 깨진 XML · JUnit 아님', () => {
  it('닫히지 않은 요소 → JunitParseError (줄 번호 있음)', () => {
    const error = (() => {
      try {
        parseJunit(fixture('broken.xml'));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(JunitParseError);
    expect((error as JunitParseError).name).toBe('JunitParseError');
    expect((error as JunitParseError).line).toBeTypeOf('number');
  });

  it('빈 문자열 · 비-JUnit 루트 → JunitParseError', () => {
    expect(() => parseJunit('')).toThrow(JunitParseError);
    expect(() => parseJunit('   \n')).toThrow(JunitParseError);
    expect(() => parseJunit('<report><case/></report>')).toThrow(JunitParseError);
    expect(() => parseJunit('<report><case/></report>')).toThrow(/testsuites 또는 testsuite/);
  });

  it('테스트 0개인 빈 testsuites는 오류가 아니다 (passWithNoTests)', () => {
    const report = parseJunit('<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="0" />');
    expect(report.suites).toEqual([]);
    expect(report.totals.tests).toBe(0);
  });

  it('루트가 testsuite 하나여도 읽는다', () => {
    const report = parseJunit(
      '<testsuite name="test/a.spec.ts" tests="1"><testcase classname="test/a.spec.ts" name="x" time="1.5"/></testsuite>',
    );
    expect(report.suites).toHaveLength(1);
    expect(report.suites[0]?.cases[0]).toMatchObject({ file: 'test/a.spec.ts', status: 'pass', timeSec: 1.5 });
  });

  it('표준 file 속성이 있으면 classname보다 우선, 절대 경로는 root로 상대화', () => {
    const report = parseJunit(
      '<testsuites><testsuite name="suite"><testcase classname="Suite.Class" name="x" file="/r/test/b.spec.ts"/></testsuite></testsuites>',
      { root: '/r' },
    );
    expect(report.suites[0]?.cases[0]?.file).toBe('test/b.spec.ts');
    expect(report.suites[0]?.file).toBeUndefined();
  });
});

describe('findAnchor · toRootRelative', () => {
  it('Node `at` · Vitest `❯` · 괄호 file:// 프레임을 모두 읽고 test/·src/ 아닌 것은 건너뛴다', () => {
    expect(findAnchor('    at Foo (file:///x/node_modules/a.js:1:2)\n ❯ src/domains/pay.ts:12:3')).toEqual({
      file: 'src/domains/pay.ts',
      line: 12,
    });
    expect(findAnchor('    at /abs/test/a.spec.ts:8:22', { root: '/abs' })).toEqual({
      file: 'test/a.spec.ts',
      line: 8,
    });
    expect(findAnchor('Seed: 42\nPath: 0:1:0\nCounterexample: [8]')).toBeUndefined();
    expect(findAnchor('')).toBeUndefined();
  });

  it('toRootRelative: file:// · ./ · 역슬래시 · 루트 밖 절대 경로', () => {
    expect(toRootRelative('file:///r/test/a.ts', '/r')).toBe('test/a.ts');
    expect(toRootRelative('./test/a.ts')).toBe('test/a.ts');
    expect(toRootRelative('test\\a.ts')).toBe('test/a.ts');
    expect(toRootRelative('/elsewhere/test/a.ts', '/r')).toBe('/elsewhere/test/a.ts');
  });
});
