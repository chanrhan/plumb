/**
 * {@link JunitReport} + 규칙 → `CheckResult[]` (이슈 #43). 상태 계산(#46 `computeRuleStatuses`)의 입력을 만든다.
 *
 * 매핑 키는 **테스트 파일 경로 = 규칙 `checks[].ref`** (결정 #17 항목 5 · view-verification 6절 1번: 파일 하나 = 규칙).
 * 같은 파일의 testcase 여러 개는 `CheckResult` 하나로 접는다 — 하나라도 fail · error면 그 outcome이고 첫 실패가 `failure`,
 * `durationSec`은 합. 어느 규칙의 `checks[]`에도 없는 파일의 testcase는 `unmapped`로 분리한다: 구현자의 단위 테스트는
 * 규칙의 근거가 아니다 (기획안 §8.2). 🔴를 만드는 것은 실패한 testcase뿐이다 (§7.3) — 매핑 안 됨 · 파일 없음은 결과를 만들지 않는다.
 *
 * 규칙은 정규화된 {@link Rule}(`checks: CheckRef[]`)과 YAML 모양 {@link RuleYaml}(`checks: Array<string | CheckRef>`) 둘 다 받는다.
 * 문자열은 `store/rules.ts`의 `normalizeRule`과 같은 뜻으로 `{ kind: 'acceptance', ref }`다.
 */

import type { CheckFailure, CheckRef, CheckResult, Rule, RuleId, RuleYaml } from '../types/index.js';
import { allCases, type JunitCase, type JunitReport, toRootRelative } from './junit.js';

export interface ToCheckResultsOptions {
  /** 대상 루트(절대). 절대 경로로 온 테스트 파일 · `checks[].ref`를 이 기준으로 상대화해 비교한다 */
  root?: string;
}

export interface CheckResultsFromJunit {
  /** 규칙에 매핑된 검사 파일마다 하나. 보고서의 파일 등장 순서 */
  results: CheckResult[];
  /** 어느 규칙의 `checks[]`에도 없는 testcase (단위 테스트 등 — 규칙 근거 아님). 파일을 모르는 testcase도 여기 */
  unmapped: JunitCase[];
}

/** `Rule`과 `RuleYaml` 공통으로 `checks[]`를 `CheckRef[]`로 */
export function checkRefsOf(rule: Rule | RuleYaml): CheckRef[] {
  return (rule.checks ?? []).map((check) => (typeof check === 'string' ? { kind: 'acceptance', ref: check } : check));
}

interface Mapping {
  /** 이 파일을 가리키는 첫 규칙의 CheckRef (kind는 여기서 온다) */
  check: CheckRef;
  ruleIds: RuleId[];
}

/** 정규화한 파일 경로 → 매핑. 같은 파일을 여러 규칙이 가리키면 `ruleIds`에 모두 */
function buildIndex(rules: ReadonlyArray<Rule | RuleYaml>, root?: string): Map<string, Mapping> {
  const index = new Map<string, Mapping>();
  for (const rule of rules) {
    for (const check of checkRefsOf(rule)) {
      const key = toRootRelative(check.ref, root);
      const existing = index.get(key);
      if (existing) {
        if (!existing.ruleIds.includes(rule.id)) existing.ruleIds.push(rule.id);
      } else {
        index.set(key, { check: { kind: check.kind, ref: check.ref }, ruleIds: [rule.id] });
      }
    }
  }
  return index;
}

function toCheckFailure(testcase: JunitCase, check: CheckRef): CheckFailure | undefined {
  const failure = testcase.failure;
  if (!failure) return undefined;
  const result: CheckFailure = {
    check,
    anchor: failure.anchor ?? { file: testcase.file ?? check.ref, line: 1 },
    message: failure.message,
  };
  if (failure.counterexample !== undefined) result.counterexample = failure.counterexample;
  if (failure.seed !== undefined) result.seed = failure.seed;
  return result;
}

/** 한 파일의 testcase들을 `CheckResult` 하나로 접는다 */
function foldCases(cases: JunitCase[], mapping: Mapping): CheckResult {
  const firstFailing = cases.find((testcase) => testcase.status === 'fail' || testcase.status === 'error');
  let outcome: CheckResult['outcome'];
  if (firstFailing) outcome = firstFailing.status === 'error' ? 'error' : 'fail';
  else if (cases.some((testcase) => testcase.status === 'pass')) outcome = 'pass';
  else outcome = 'skipped';

  const result: CheckResult = { check: mapping.check, ruleIds: [...mapping.ruleIds], outcome };
  const timed = cases.filter((testcase) => testcase.timeSec !== undefined);
  if (timed.length > 0) result.durationSec = timed.reduce((sum, testcase) => sum + (testcase.timeSec ?? 0), 0);
  if (firstFailing) {
    const failure = toCheckFailure(firstFailing, mapping.check);
    if (failure) result.failure = failure;
  }
  return result;
}

/**
 * JUnit 보고서의 testcase를 규칙의 검사 파일별 `CheckResult`로. 규칙에 없는 testcase는 `unmapped`.
 * 순수 함수 — 파일 존재 여부는 보지 않는다 (`check-missing` 판정은 #46).
 */
export function toCheckResults(
  report: JunitReport,
  rules: ReadonlyArray<Rule | RuleYaml>,
  opts: ToCheckResultsOptions = {},
): CheckResultsFromJunit {
  const index = buildIndex(rules, opts.root);
  const byFile = new Map<string, JunitCase[]>();
  const unmapped: JunitCase[] = [];

  for (const testcase of allCases(report)) {
    const key = testcase.file ? toRootRelative(testcase.file, opts.root) : undefined;
    if (key === undefined || !index.has(key)) {
      unmapped.push(testcase);
      continue;
    }
    const group = byFile.get(key);
    if (group) group.push(testcase);
    else byFile.set(key, [testcase]);
  }

  const results: CheckResult[] = [];
  for (const [key, cases] of byFile) {
    const mapping = index.get(key);
    if (mapping) results.push(foldCases(cases, mapping));
  }
  return { results, unmapped };
}
