/**
 * 블록 공통 필수 검사 세 행 (기획안 §12, view-verification 3.2 "블록 공통 절", views.ts `CommonCheckRow`).
 *
 * dependency-cruiser 결과(`CheckResult.check.kind === 'static'`, `ref: 'depcruise:<규칙 이름>'`)를 규칙 이름 접두어로 매핑한다:
 * - (1) 블록은 다른 블록을 선언된 공개 계약으로만 접근 ← `depcruise:block-1-*`
 * - (2) 블록 간 의존 방향은 선언된 방향만 (순환 금지) ← `depcruise:block-2-*`
 * - (3) 공개 계약의 시그니처 변경은 설계 변경 이벤트 ← git 공개 진입점 diff + 설계 변경 이벤트 (M8). 지금은 `unchecked`
 *
 * 한 행에 결과가 하나도 없으면 `unchecked`, 하나라도 fail · error면 `fail`(위반 목록), 아니면 `pass`.
 * 위반의 `to` · `fromBlock` · `toBlock`은 `CheckFailure`에 없어서 메시지의 `from → to`에서 읽는다. 못 읽으면 빈 문자열
 * (`CheckFailure`에 대상 필드를 두려면 어댑터가 채워 `checks/*.json`에 저장돼야 한다 — M10 후보, #63).
 */

import type { CheckResult, CommonCheckRow, StaticCheckResult, StaticViolation } from '../types/index.js';

export const DEPCRUISE_REF_PREFIX = 'depcruise:';

export const COMMON_CHECK_TITLES: Record<CommonCheckRow['index'], string> = {
  1: '블록은 다른 블록을 선언된 공개 계약으로만 접근',
  2: '블록 간 의존 방향은 선언된 방향만 (순환 금지)',
  3: '공개 계약의 시그니처 변경은 설계 변경 이벤트',
};

/** dependency-cruiser 규칙 이름 접두어 → 필수 검사 번호 */
const RULE_PREFIX_OF_INDEX: Record<1 | 2, string> = { 1: 'block-1-', 2: 'block-2-' };

/** `depcruise:<이름>` → `<이름>`. 접두어가 없으면 그대로 */
export function depcruiseRuleName(ref: string): string {
  return ref.startsWith(DEPCRUISE_REF_PREFIX) ? ref.slice(DEPCRUISE_REF_PREFIX.length) : ref;
}

/** 이 정적 결과가 필수 검사 (1) 또는 (2)에 속하는가. 아니면 `null` (prisma-only-in-repo 같은 프로젝트 규칙) */
export function commonCheckIndexOf(result: CheckResult): 1 | 2 | null {
  if (result.check.kind !== 'static') return null;
  const name = depcruiseRuleName(result.check.ref);
  if (name.startsWith(RULE_PREFIX_OF_INDEX[1])) return 1;
  if (name.startsWith(RULE_PREFIX_OF_INDEX[2])) return 2;
  return null;
}

/** 메시지에서 `from → to`의 오른쪽. 어댑터(#44)가 위반의 `to`를 메시지에 넣는 관례에 기댄다 */
function targetFromMessage(message: string): string {
  const match = /(?:→|->)\s*(\S+)/.exec(message);
  return match?.[1] ?? '';
}

export function toStaticViolation(result: CheckResult): StaticViolation {
  const failure = result.failure;
  const anchor = failure?.anchor ?? {};
  return {
    rule: depcruiseRuleName(result.check.ref),
    from: { ...anchor, file: anchor.file ?? '', line: anchor.line ?? 1 },
    to: failure === undefined ? '' : targetFromMessage(failure.message),
    fromBlock: anchor.block ?? '',
    toBlock: '',
  };
}

function staticResultOf(results: CheckResult[]): StaticCheckResult {
  if (results.length === 0) return { status: 'unchecked' };
  const [first, ...rest] = results
    .filter((result) => result.outcome === 'fail' || result.outcome === 'error')
    .map(toStaticViolation);
  if (first !== undefined) return { status: 'fail', violations: [first, ...rest] };
  return { status: 'pass', violations: [] };
}

/** 필수 검사 (1)(2)(3) 행. 정적 결과만 넘겨도 되고 전체 결과를 넘겨도 된다 (정적이 아닌 것은 무시) */
export function computeCommonRows(staticResults: CheckResult[]): CommonCheckRow[] {
  const grouped: Record<1 | 2, CheckResult[]> = { 1: [], 2: [] };
  for (const result of staticResults) {
    const index = commonCheckIndexOf(result);
    if (index !== null) grouped[index].push(result);
  }
  const rows: CommonCheckRow[] = ([1, 2] as const).map((index) => {
    const result = staticResultOf(grouped[index]);
    const first = result.status === 'fail' ? result.violations[0] : undefined;
    return {
      index,
      title: COMMON_CHECK_TITLES[index],
      result,
      ...(first === undefined ? {} : { anchor: first.from }),
    };
  });
  rows.push({ index: 3, title: COMMON_CHECK_TITLES[3], result: { status: 'unchecked' } });
  return rows;
}
