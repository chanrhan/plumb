/**
 * 규칙별 상태 계산 (이슈 #46, 기획안 §7.3, view-verification 3.3 "상태 계산 우선순위").
 *
 * 입력은 `CheckResult[]`(실행) + 규칙(저장소) + 승인 상태(저장소) + 격리 목록(실행) + 이전 상태 기록(저장소)
 * + 규칙별 최신 위반 주입 기록(실행, `injections/<ruleId>/`)이고,
 * 출력은 {@link RuleStatusRecord}[] — `rule-status/<ruleId>.json`에 쓰인다 (docs/types/README "상태 기록은 두 곳").
 *
 * 판정 순서 (앞에서부터 처음 맞는 것):
 * 1. 승인 안 됨(provisional · rejected · 기록 없음) → `unchecked/unapproved`
 * 2. `checks[]` 비어 있음 → `unchecked/no-checks`
 * 3. `checks[]`의 파일이 하나라도 레포에 없음 → `unchecked/check-missing` (`static` 검사는 파일이 아니므로 보지 않는다)
 * 4. 그 규칙의 검사가 전부 격리됨 → `unchecked/quarantined` (일부만 격리면 격리된 검사의 결과를 빼고 계속)
 * 5. 결과가 하나도 없음(또는 전부 skipped) → `unchecked/not-run`
 * 6. 결과에 fail · error 있음 → `fail` + `failures[]`
 * 7. 전부 pass이고 주입 기록이 없음 → `pass-unverified/no-injection`
 * 8. 전부 pass이고 주입 기록의 `checkFileHashes`가 현재 검사 파일 해시와 다름 → `recheck/check-file-changed` + `changedFiles[]`
 *    (§7.4 "검사 파일이 바뀌면 유효성은 무효가 되고 다시 주입한다" — 주입이 잡혔든 못 잡았든 그 기록은 더 이상 근거가 아니다)
 * 9. 전부 pass이고 주입이 잡힘(`valid: true`) → `pass-verified/passed-and-injection-valid` + `validity`
 * 10. 전부 pass이고 주입을 못 잡음(`valid: false`) → `pass-unverified/injection-invalid` + `validity`(차이 탐색 결과 포함)
 *
 * 🔴는 실패 결과가 있을 때만 만든다. `failure`가 없는 fail 결과는 "실패 상세 없음" 메시지의 {@link CheckFailure}가 된다 —
 * 추정으로 통과를 만들지 않는다 (§7.3). 🟢도 마찬가지로 주입 기록(`valid: true`)이 있을 때만 만든다 — 기획안 §7.3
 * "🟢 = 인수 테스트 통과 + 위반 주입으로 유효성 확인". 해시 비교는 주입 기록에 적힌 파일만 본다 (injector가 해시한 인수 테스트 · PBT 파일).
 */

import type {
  Approval,
  ApprovalState,
  CheckFailure,
  CheckResult,
  Quarantine,
  Rule,
  RuleId,
  RuleStatusDetail,
  RuleStatusRecord,
  Validity,
} from '../types/index.js';

/** `RuleStatusRecord.history`에 남기는 최근 상태 수 (view-verification 3.3 "이력 (최근 n회)") */
export const HISTORY_LIMIT = 10;

/** `failure`가 없는 fail · error 결과에 붙이는 메시지 */
export const NO_FAILURE_DETAIL_MESSAGE = '실패 상세 없음';

export interface ComputeRuleStatusesInput {
  rules: Rule[];
  /** 규칙별 승인 상태. 항목이 없으면 미승인으로 본다 → {@link approvalStatesFrom} */
  approvalStates: ReadonlyMap<RuleId, ApprovalState>;
  /** 이번 `plumb check`의 결과 전부 (JUnit + 정적) */
  results: CheckResult[];
  /** 이번 실행의 격리 목록 (`CheckRun.quarantined`) */
  quarantined: Quarantine[];
  /** 이전 `rule-status/<ruleId>.json`. `since` 유지와 `history` 누적의 근거 */
  previous: ReadonlyMap<RuleId, RuleStatusRecord>;
  /** 검사 파일(대상 루트 기준 상대 경로)이 레포에 있는가 */
  fileExists: (relPath: string) => boolean;
  /** 규칙별 최신 위반 주입 기록 (`injections/<ruleId>/`의 마지막 1건). 없는 규칙은 맵에 없다 (= 주입 기록 없음) */
  validity: ReadonlyMap<RuleId, Validity>;
  /**
   * 검사 파일(대상 루트 기준 상대 경로)의 현재 sha256 — `Validity.checkFileHashes`와 비교한다.
   * 읽을 수 없으면 `undefined` (→ 기록된 해시와 다른 것으로 본다)
   */
  fileHash: (relPath: string) => string | undefined;
  now: Date;
  /** 이번 실행의 커밋 (`git rev-parse HEAD`) */
  commit: string;
}

/** 비어 있지 않은 배열 — `RuleStatusDetail`의 `failures` 모양 */
export type NonEmptyArray<T> = [T, ...T[]];

export function isNonEmpty<T>(items: readonly T[]): items is readonly T[] & NonEmptyArray<T> {
  return items.length > 0;
}

/**
 * 🔴 상세를 만든다. `failures`가 비어 있으면 던진다 — 타입이 막는 것을 런타임에서도 막는다 (§7.3 "추정으로 🔴를 만들지 않는다").
 */
export function failDetail(failures: readonly CheckFailure[]): Extract<RuleStatusDetail, { status: 'fail' }> {
  const [first, ...rest] = failures;
  if (first === undefined) {
    throw new Error('fail 상태는 실패 결과(failures) 없이는 만들 수 없다');
  }
  return { status: 'fail', failures: [first, ...rest] };
}

/**
 * 승인 기록(`approvals/<ruleId>.jsonl`)에서 규칙별 승인 상태. 마지막 행위가 기준이다:
 * `approve` → approved · `reject` → rejected · `propose` → provisional. 기록이 없는 규칙은 맵에 없다 (= 미승인).
 */
export function approvalStatesFrom(records: Iterable<Approval>): Map<RuleId, ApprovalState> {
  const latest = new Map<RuleId, Approval>();
  for (const record of records) {
    const prev = latest.get(record.ruleId);
    if (prev === undefined || record.at.localeCompare(prev.at) >= 0) latest.set(record.ruleId, record);
  }
  const states = new Map<RuleId, ApprovalState>();
  for (const [ruleId, record] of latest) {
    states.set(
      ruleId,
      record.action === 'approve' ? 'approved' : record.action === 'reject' ? 'rejected' : 'provisional',
    );
  }
  return states;
}

/** 이 규칙에 속한 결과: `ruleIds`에 규칙이 있거나, `check.ref`가 규칙의 `checks[].ref`와 같은 것 */
export function resultsForRule(rule: Rule, results: readonly CheckResult[]): CheckResult[] {
  const refs = new Set(rule.checks.map((check) => check.ref));
  return results.filter((result) => result.ruleIds.includes(rule.id) || refs.has(result.check.ref));
}

/** 레포에 없는 검사 파일. 정적 검사의 `ref`는 dependency-cruiser 규칙 이름이라 파일이 아니므로 보지 않는다 */
export function missingCheckFiles(rule: Rule, fileExists: (relPath: string) => boolean): string[] {
  return rule.checks.filter((check) => check.kind !== 'static' && !fileExists(check.ref)).map((check) => check.ref);
}

/**
 * 주입 기록 이후 바뀐 검사 파일. `validity.checkFileHashes`의 파일마다 현재 해시와 비교해 다른 것(읽을 수 없는 것 포함)을 돌려준다.
 * 비어 있으면 유효성 기록이 아직 근거다 (§7.4)
 */
export function changedCheckFiles(validity: Validity, fileHash: (relPath: string) => string | undefined): string[] {
  return Object.entries(validity.checkFileHashes)
    .filter(([relPath, recorded]) => fileHash(relPath) !== recorded)
    .map(([relPath]) => relPath);
}

/** 전부 통과한 규칙의 상태 — 주입 기록 유무 · 해시 일치 · 잡힘 여부로 🟡 · 🟠 · 🟢를 가른다 (파일 머리 7~10) */
export function passDetail(
  validity: Validity | undefined,
  fileHash: (relPath: string) => string | undefined,
): RuleStatusDetail {
  if (validity === undefined) return { status: 'pass-unverified', reason: 'no-injection' };
  const changedFiles = changedCheckFiles(validity, fileHash);
  if (changedFiles.length > 0) return { status: 'recheck', reason: 'check-file-changed', changedFiles };
  return validity.valid
    ? { status: 'pass-verified', reason: 'passed-and-injection-valid', validity }
    : { status: 'pass-unverified', reason: 'injection-invalid', validity };
}

function failureOf(rule: Rule, result: CheckResult): CheckFailure {
  if (result.failure !== undefined) return result.failure;
  return {
    check: result.check,
    anchor: {
      ...(rule.block === undefined ? {} : { block: rule.block }),
      ...(result.check.kind === 'static' ? {} : { file: result.check.ref, line: 1 }),
    },
    message: NO_FAILURE_DETAIL_MESSAGE,
  };
}

/** 규칙 하나의 상태와 근거. 파일 머리의 판정 순서 그대로 */
export function computeRuleStatusDetail(
  rule: Rule,
  input: Pick<
    ComputeRuleStatusesInput,
    'approvalStates' | 'results' | 'quarantined' | 'fileExists' | 'validity' | 'fileHash'
  >,
): RuleStatusDetail {
  if (input.approvalStates.get(rule.id) !== 'approved') return { status: 'unchecked', reason: 'unapproved' };
  if (rule.checks.length === 0) return { status: 'unchecked', reason: 'no-checks' };
  if (missingCheckFiles(rule, input.fileExists).length > 0) return { status: 'unchecked', reason: 'check-missing' };

  const quarantinedRefs = new Set(input.quarantined.map((q) => q.ref));
  if (rule.checks.every((check) => quarantinedRefs.has(check.ref))) {
    return { status: 'unchecked', reason: 'quarantined' };
  }

  const results = resultsForRule(rule, input.results).filter(
    (result) => !quarantinedRefs.has(result.check.ref) && result.outcome !== 'skipped',
  );
  if (results.length === 0) return { status: 'unchecked', reason: 'not-run' };

  const failed = results.filter((result) => result.outcome === 'fail' || result.outcome === 'error');
  if (failed.length > 0) return failDetail(failed.map((result) => failureOf(rule, result)));

  return passDetail(input.validity.get(rule.id), input.fileHash);
}

/** 규칙 전부의 상태 기록. 입력 `rules` 순서 그대로 */
export function computeRuleStatuses(input: ComputeRuleStatusesInput): RuleStatusRecord[] {
  const nowIso = input.now.toISOString();
  return input.rules.map((rule) => {
    const detail = computeRuleStatusDetail(rule, input);
    const previous = input.previous.get(rule.id);
    const since = previous !== undefined && previous.detail.status === detail.status ? previous.since : nowIso;
    const history = [...(previous?.history ?? []), detail.status].slice(-HISTORY_LIMIT);
    return { ruleId: rule.id, detail, since, commit: input.commit, checkedAt: nowIso, history };
  });
}
