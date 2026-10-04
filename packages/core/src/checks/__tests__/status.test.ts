import { describe, expect, it } from 'vitest';
import type {
  Approval,
  ApprovalState,
  CheckResult,
  Quarantine,
  RuleId,
  RuleStatus,
  RuleStatusDetail,
  RuleStatusRecord,
  Validity,
} from '../../types/index.js';
import {
  approvalStatesFrom,
  changedCheckFiles,
  computeRuleStatusDetail,
  computeRuleStatuses,
  failDetail,
  HISTORY_LIMIT,
  missingCheckFiles,
  NO_FAILURE_DETAIL_MESSAGE,
  passDetail,
  resultsForRule,
} from '../status.js';
import { COMMIT, EARLIER, NOW, RECORD_CHECK, REFUND_CHECK, record, result, rule, STATIC_CHECK } from './fixtures.js';

const RULE_ID: RuleId = 'pay.refund-window';

type ApprovalCase = ApprovalState | 'none';
type ChecksCase = 'checks' | 'no-checks';
type FileCase = 'file' | 'no-file';
type ResultCase = 'none' | 'pass' | 'fail' | 'quarantined';

function approvals(state: ApprovalCase): Map<RuleId, ApprovalState> {
  return state === 'none' ? new Map() : new Map([[RULE_ID, state]]);
}

function scenario(checks: ChecksCase, file: FileCase, outcome: ResultCase) {
  const r = rule(RULE_ID, { checks: checks === 'checks' ? [REFUND_CHECK] : [] });
  const results: CheckResult[] =
    outcome === 'none' ? [] : [result(REFUND_CHECK, outcome === 'fail' ? 'fail' : 'pass', { ruleIds: [RULE_ID] })];
  const quarantined: Quarantine[] = outcome === 'quarantined' ? [{ ref: REFUND_CHECK.ref, passes: 2, runs: 3 }] : [];
  return { rule: r, results, quarantined, fileExists: () => file === 'file', ...NO_INJECTION };
}

/** 주입 기록 없음 — 검사 파일 해시도 볼 일이 없다 */
const NO_INJECTION = { validity: new Map<RuleId, Validity>(), fileHash: () => undefined };

/** 주입 시점의 검사 파일 해시 (현재 해시와 같다고 두는 값) */
const HASH_AT_INJECTION = 'sha256-at-injection';

/** 주입 기록 1건. `valid`가 true면 잡힘 ✔(check-failed), false면 통과해 버림 ✘(check-passed + 차이 탐색) */
function injection(
  valid: boolean,
  hashes: Record<string, string> = { [REFUND_CHECK.ref]: HASH_AT_INJECTION },
): Validity {
  const base = {
    id: 'i-0001' as const,
    ruleId: RULE_ID,
    description: '7일 검사 제거',
    anchor: { file: 'src/domains/payment/payment.ts', line: 30, block: 'payment' },
    commit: 'abc1234',
    at: EARLIER,
    checkFileHashes: hashes,
  };
  return valid
    ? { ...base, result: 'check-failed', valid: true }
    : {
        ...base,
        result: 'check-passed',
        valid: false,
        diffSearch: { runId: 'r-0001', inputs: 100, differingOutputs: 3, verdict: 'weak-check' },
      };
}

describe('computeRuleStatusDetail — 상태 전이 표 (승인 × checks 유무 × 파일 존재 × 결과)', () => {
  // 승인 안 됨(provisional · rejected · 기록 없음)은 다른 축과 무관하게 unapproved
  // checks 없음은 파일 · 결과와 무관하게 no-checks
  // 파일 없음은 결과와 무관하게 check-missing
  // 그 다음에야 결과가 보인다: 없음 → not-run · 전부 격리 → quarantined · 실패 → fail · 통과 → pass-unverified
  it.each`
    approval         | checks         | file         | outcome          | status               | reason
    ${'provisional'} | ${'checks'}    | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'checks'}    | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'provisional'} | ${'no-checks'} | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'checks'}    | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'rejected'}    | ${'no-checks'} | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'checks'}    | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'unapproved'}
    ${'none'}        | ${'no-checks'} | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'unapproved'}
    ${'approved'}    | ${'no-checks'} | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'file'}    | ${'pass'}        | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'file'}    | ${'fail'}        | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'no-checks'} | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'no-checks'}
    ${'approved'}    | ${'checks'}    | ${'no-file'} | ${'none'}        | ${'unchecked'}       | ${'check-missing'}
    ${'approved'}    | ${'checks'}    | ${'no-file'} | ${'pass'}        | ${'unchecked'}       | ${'check-missing'}
    ${'approved'}    | ${'checks'}    | ${'no-file'} | ${'fail'}        | ${'unchecked'}       | ${'check-missing'}
    ${'approved'}    | ${'checks'}    | ${'no-file'} | ${'quarantined'} | ${'unchecked'}       | ${'check-missing'}
    ${'approved'}    | ${'checks'}    | ${'file'}    | ${'none'}        | ${'unchecked'}       | ${'not-run'}
    ${'approved'}    | ${'checks'}    | ${'file'}    | ${'quarantined'} | ${'unchecked'}       | ${'quarantined'}
    ${'approved'}    | ${'checks'}    | ${'file'}    | ${'fail'}        | ${'fail'}            | ${undefined}
    ${'approved'}    | ${'checks'}    | ${'file'}    | ${'pass'}        | ${'pass-unverified'} | ${'no-injection'}
  `(
    '$approval · $checks · $file · $outcome → $status/$reason',
    ({
      approval,
      checks,
      file,
      outcome,
      status,
      reason,
    }: {
      approval: ApprovalCase;
      checks: ChecksCase;
      file: FileCase;
      outcome: ResultCase;
      status: RuleStatus;
      reason: string | undefined;
    }) => {
      const s = scenario(checks, file, outcome);
      const detail = computeRuleStatusDetail(s.rule, { ...s, approvalStates: approvals(approval) });
      expect(detail.status).toBe(status);
      if (detail.status === 'fail') {
        expect(reason).toBeUndefined();
        expect(detail.failures.length).toBeGreaterThan(0);
      } else {
        expect(detail.reason).toBe(reason);
      }
    },
  );
});

describe('computeRuleStatusDetail — 유효성 판정표 (#105, 기획안 §7.3 · §7.4)', () => {
  // 전부 통과한 규칙만 주입 기록을 본다: 기록 없음 → 🟡 no-injection · 잡힘 → 🟢 · 못 잡음 → 🟡 injection-invalid ·
  // 기록 뒤 검사 파일 해시가 바뀜 → 🟠 recheck (잡혔든 못 잡았든 — 그 기록은 더 이상 근거가 아니다)
  type InjectionCase = 'none' | 'valid' | 'invalid';
  type HashCase = 'same' | 'changed' | 'unreadable';
  it.each`
    injection    | hash            | status               | reason
    ${'none'}    | ${'same'}       | ${'pass-unverified'} | ${'no-injection'}
    ${'none'}    | ${'changed'}    | ${'pass-unverified'} | ${'no-injection'}
    ${'valid'}   | ${'same'}       | ${'pass-verified'}   | ${'passed-and-injection-valid'}
    ${'invalid'} | ${'same'}       | ${'pass-unverified'} | ${'injection-invalid'}
    ${'valid'}   | ${'changed'}    | ${'recheck'}         | ${'check-file-changed'}
    ${'invalid'} | ${'changed'}    | ${'recheck'}         | ${'check-file-changed'}
    ${'valid'}   | ${'unreadable'} | ${'recheck'}         | ${'check-file-changed'}
  `(
    '전부 통과 · 주입 $injection · 해시 $hash → $status/$reason',
    ({
      injection: inj,
      hash,
      status,
      reason,
    }: {
      injection: InjectionCase;
      hash: HashCase;
      status: RuleStatus;
      reason: string;
    }) => {
      const record = inj === 'none' ? undefined : injection(inj === 'valid');
      const validity = new Map<RuleId, Validity>(record === undefined ? [] : [[RULE_ID, record]]);
      const fileHash = () => (hash === 'same' ? HASH_AT_INJECTION : hash === 'changed' ? 'sha256-now' : undefined);
      const detail = computeRuleStatusDetail(rule(RULE_ID), {
        approvalStates: approvals('approved'),
        quarantined: [],
        fileExists: () => true,
        results: [result(REFUND_CHECK, 'pass', { ruleIds: [RULE_ID] })],
        validity,
        fileHash,
      });
      expect(detail.status).toBe(status);
      if (detail.status === 'fail') throw new Error('unreachable');
      expect(detail.reason).toBe(reason);
      if (detail.status === 'pass-verified' || detail.status === 'pass-unverified') {
        // 🟢 · 🟡 injection-invalid는 기록 그대로(차이 탐색 포함) — View의 "유효성" 열이 이것을 읽는다
        expect(detail.validity).toEqual(reason === 'no-injection' ? undefined : record);
      }
      if (detail.status === 'recheck') expect(detail.changedFiles).toEqual([REFUND_CHECK.ref]);
    },
  );

  it('🔴 · ⬜는 주입 기록과 무관하다 — 잡힌 주입이 있어도 실패는 실패, 미승인은 미승인', () => {
    const validity = new Map<RuleId, Validity>([[RULE_ID, injection(true)]]);
    const fileHash = () => HASH_AT_INJECTION;
    expect(
      computeRuleStatusDetail(rule(RULE_ID), {
        approvalStates: approvals('approved'),
        quarantined: [],
        fileExists: () => true,
        results: [result(REFUND_CHECK, 'fail', { ruleIds: [RULE_ID] })],
        validity,
        fileHash,
      }).status,
    ).toBe('fail');
    expect(
      computeRuleStatusDetail(rule(RULE_ID), {
        approvalStates: approvals('provisional'),
        quarantined: [],
        fileExists: () => true,
        results: [result(REFUND_CHECK, 'pass', { ruleIds: [RULE_ID] })],
        validity,
        fileHash,
      }),
    ).toEqual({ status: 'unchecked', reason: 'unapproved' });
  });

  it('changedCheckFiles는 기록에 적힌 파일만 비교하고, 바뀐 파일(읽을 수 없는 것 포함)만 돌려준다', () => {
    const record = injection(true, {
      [REFUND_CHECK.ref]: 'aaa',
      [RECORD_CHECK.ref]: 'bbb',
      'test/gone.spec.ts': 'ccc',
    });
    const current: Record<string, string> = { [REFUND_CHECK.ref]: 'aaa', [RECORD_CHECK.ref]: 'changed' };
    expect(changedCheckFiles(record, (relPath) => current[relPath])).toEqual([RECORD_CHECK.ref, 'test/gone.spec.ts']);
    expect(changedCheckFiles(record, () => 'aaa')).toEqual([RECORD_CHECK.ref, 'test/gone.spec.ts']);
    expect(changedCheckFiles(injection(true, {}), () => undefined)).toEqual([]);
  });

  it('passDetail — 기록 없음 🟡 · 잡힘 🟢 · 못 잡음 🟡 · 해시 다름 🟠', () => {
    const same = () => HASH_AT_INJECTION;
    expect(passDetail(undefined, same)).toEqual({ status: 'pass-unverified', reason: 'no-injection' });
    expect(passDetail(injection(true), same)).toEqual({
      status: 'pass-verified',
      reason: 'passed-and-injection-valid',
      validity: injection(true),
    });
    expect(passDetail(injection(false), same)).toEqual({
      status: 'pass-unverified',
      reason: 'injection-invalid',
      validity: injection(false),
    });
    expect(passDetail(injection(true), () => 'other')).toEqual({
      status: 'recheck',
      reason: 'check-file-changed',
      changedFiles: [REFUND_CHECK.ref],
    });
  });
});

describe('computeRuleStatusDetail — 세부', () => {
  const approved = approvals('approved');
  const base = { approvalStates: approved, quarantined: [], fileExists: () => true, ...NO_INJECTION };

  it('error 결과도 fail. failures에는 실패 결과의 failure만 (pass 결과는 섞이지 않는다)', () => {
    const r = rule(RULE_ID, { checks: [REFUND_CHECK, RECORD_CHECK] });
    const detail = computeRuleStatusDetail(r, {
      ...base,
      results: [result(RECORD_CHECK, 'pass'), result(REFUND_CHECK, 'error')],
    });
    expect(detail.status).toBe('fail');
    if (detail.status !== 'fail') throw new Error('unreachable');
    expect(detail.failures).toHaveLength(1);
    expect(detail.failures[0].check).toEqual(REFUND_CHECK);
    expect(detail.failures[0].anchor.line).toBe(42);
  });

  it('failure 없는 fail 결과 → "실패 상세 없음" CheckFailure. 추정으로 통과를 만들지 않는다', () => {
    const detail = computeRuleStatusDetail(rule(RULE_ID), {
      ...base,
      results: [{ check: REFUND_CHECK, ruleIds: [RULE_ID], outcome: 'fail' }],
    });
    expect(detail).toEqual({
      status: 'fail',
      failures: [
        {
          check: REFUND_CHECK,
          anchor: { block: 'payment', file: REFUND_CHECK.ref, line: 1 },
          message: NO_FAILURE_DETAIL_MESSAGE,
        },
      ],
    });
  });

  it('skipped만 있으면 not-run (근거 없음). skipped + pass면 pass-unverified', () => {
    const skipped = result(REFUND_CHECK, 'skipped');
    expect(computeRuleStatusDetail(rule(RULE_ID), { ...base, results: [skipped] })).toEqual({
      status: 'unchecked',
      reason: 'not-run',
    });
    expect(
      computeRuleStatusDetail(rule(RULE_ID), { ...base, results: [skipped, result(REFUND_CHECK, 'pass')] }),
    ).toEqual({ status: 'pass-unverified', reason: 'no-injection' });
  });

  it('정적 검사(static)의 ref는 파일이 아니다: 파일 존재를 보지 않고, ruleIds가 비어 있어도 ref로 매핑된다', () => {
    const r = rule('arch.public-entry-only', { kind: 'architecture', checks: [STATIC_CHECK] });
    expect(missingCheckFiles(r, () => false)).toEqual([]);

    const staticFail = result(STATIC_CHECK, 'fail', {
      failure: {
        check: STATIC_CHECK,
        anchor: { block: 'app', file: 'src/app/page.tsx', line: 3 },
        message: 'src/app/page.tsx → src/domains/payment/internal.ts',
      },
    });
    expect(resultsForRule(r, [staticFail, result(REFUND_CHECK, 'pass')])).toEqual([staticFail]);

    const detail = computeRuleStatusDetail(r, {
      ...base,
      approvalStates: new Map([[r.id, 'approved']]),
      fileExists: () => false,
      results: [staticFail],
    });
    expect(detail.status).toBe('fail');
  });

  it('일부만 격리: 격리된 검사의 결과는 빼고 나머지로 판정한다', () => {
    const r = rule(RULE_ID, { checks: [REFUND_CHECK, RECORD_CHECK] });
    const quarantined: Quarantine[] = [{ ref: REFUND_CHECK.ref, passes: 1, runs: 3 }];

    // 격리된 검사는 실패했지만 세지 않는다 → 남은 검사 통과 → 🟡
    expect(
      computeRuleStatusDetail(r, {
        ...base,
        quarantined,
        results: [result(REFUND_CHECK, 'fail'), result(RECORD_CHECK, 'pass')],
      }),
    ).toEqual({ status: 'pass-unverified', reason: 'no-injection' });

    // 남은 검사에 결과가 없으면 not-run
    expect(computeRuleStatusDetail(r, { ...base, quarantined, results: [result(REFUND_CHECK, 'pass')] })).toEqual({
      status: 'unchecked',
      reason: 'not-run',
    });

    // 전부 격리면 quarantined
    expect(
      computeRuleStatusDetail(r, {
        ...base,
        quarantined: [...quarantined, { ref: RECORD_CHECK.ref, passes: 2, runs: 3 }],
        results: [result(REFUND_CHECK, 'pass'), result(RECORD_CHECK, 'pass')],
      }),
    ).toEqual({ status: 'unchecked', reason: 'quarantined' });
  });

  it('다른 규칙의 결과는 섞이지 않는다 (ruleIds도 ref도 안 맞음)', () => {
    const detail = computeRuleStatusDetail(rule(RULE_ID), {
      ...base,
      results: [result(RECORD_CHECK, 'fail', { ruleIds: ['pay.payment-record'] })],
    });
    expect(detail).toEqual({ status: 'unchecked', reason: 'not-run' });
  });
});

describe('fail은 failures 없이는 만들 수 없다', () => {
  it('타입 레벨: 빈 failures는 RuleStatusDetail이 아니다', () => {
    // @ts-expect-error — `failures`는 [CheckFailure, ...CheckFailure[]]. 빈 배열로 🔴를 만들 수 없다
    const detail: RuleStatusDetail = { status: 'fail', failures: [] };
    // @ts-expect-error — failures 없는 fail도 불가
    const detail2: RuleStatusDetail = { status: 'fail' };
    expect(detail.status).toBe('fail');
    expect(detail2.status).toBe('fail');
  });

  it('런타임 가드: failDetail([])은 던진다', () => {
    expect(() => failDetail([])).toThrow(/failures/);
    const ok = failDetail([{ check: REFUND_CHECK, anchor: {}, message: 'x' }]);
    expect(ok.failures).toHaveLength(1);
  });
});

describe('computeRuleStatuses — since · history · commit · checkedAt', () => {
  const approved = approvals('approved');
  const base = {
    approvalStates: approved,
    quarantined: [],
    fileExists: () => true,
    ...NO_INJECTION,
    now: NOW,
    commit: COMMIT,
  };

  it('이전 기록과 status가 같으면 since 유지, 다르면 now. commit · checkedAt은 이번 실행', () => {
    const previous = new Map<RuleId, RuleStatusRecord>([[RULE_ID, record(RULE_ID, 'pass-unverified')]]);

    const [same] = computeRuleStatuses({
      ...base,
      rules: [rule(RULE_ID)],
      results: [result(REFUND_CHECK, 'pass')],
      previous,
    });
    expect(same?.since).toBe(EARLIER);
    expect(same?.commit).toBe(COMMIT);
    expect(same?.checkedAt).toBe(NOW.toISOString());

    const [changed] = computeRuleStatuses({
      ...base,
      rules: [rule(RULE_ID)],
      results: [result(REFUND_CHECK, 'fail')],
      previous,
    });
    expect(changed?.detail.status).toBe('fail');
    expect(changed?.since).toBe(NOW.toISOString());
  });

  it('이전 기록이 없으면 since = now, history = [status]', () => {
    const [first] = computeRuleStatuses({ ...base, rules: [rule(RULE_ID)], results: [], previous: new Map() });
    expect(first).toEqual({
      ruleId: RULE_ID,
      detail: { status: 'unchecked', reason: 'not-run' },
      since: NOW.toISOString(),
      commit: COMMIT,
      checkedAt: NOW.toISOString(),
      history: ['unchecked'],
    });
  });

  it(`history는 이전 + 새 상태, 최근 ${HISTORY_LIMIT}개만`, () => {
    const old: RuleStatus[] = Array.from({ length: HISTORY_LIMIT }, (_, i) => (i % 2 === 0 ? 'fail' : 'unchecked'));
    const previous = new Map<RuleId, RuleStatusRecord>([[RULE_ID, record(RULE_ID, 'unchecked', old)]]);
    const [next] = computeRuleStatuses({
      ...base,
      rules: [rule(RULE_ID)],
      results: [result(REFUND_CHECK, 'pass')],
      previous,
    });
    expect(next?.history).toHaveLength(HISTORY_LIMIT);
    expect(next?.history.at(-1)).toBe('pass-unverified');
    expect(next?.history).toEqual([...old.slice(1), 'pass-unverified']);
  });

  it('입력 rules 순서를 유지한다', () => {
    const records = computeRuleStatuses({
      ...base,
      rules: [rule('pay.b'), rule('pay.a')],
      results: [],
      previous: new Map(),
    });
    expect(records.map((r) => r.ruleId)).toEqual(['pay.b', 'pay.a']);
  });
});

describe('approvalStatesFrom', () => {
  const line = (ruleId: RuleId, action: Approval['action'], at: string): Approval => ({
    ruleId,
    proposalId: 'p-0001',
    action,
    at,
    by: 'dev',
    proposalHash: 'h',
  });

  it('규칙별 마지막 행위가 상태. 기록 없는 규칙은 맵에 없다', () => {
    const states = approvalStatesFrom([
      line('pay.a', 'propose', '2026-10-01T00:00:00.000Z'),
      line('pay.a', 'approve', '2026-10-01T01:00:00.000Z'),
      line('pay.b', 'approve', '2026-10-01T00:00:00.000Z'),
      line('pay.b', 'reject', '2026-10-01T02:00:00.000Z'),
      line('pay.c', 'propose', '2026-10-01T00:00:00.000Z'),
    ]);
    expect(states.get('pay.a')).toBe('approved');
    expect(states.get('pay.b')).toBe('rejected');
    expect(states.get('pay.c')).toBe('provisional');
    expect(states.has('pay.d')).toBe(false);
  });
});
