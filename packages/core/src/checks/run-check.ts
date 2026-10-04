/**
 * `plumb check` 조립 (이슈 #47, 기획안 §7.3 · §7.5 · §11, view-verification 3절 · 5절).
 *
 * 어댑터로 테스트 · 정적 검사 · 의존성 추출을 돌리고 → JUnit 파싱(#43) → 상태 · 범위 밖 · 공통 행 계산(#46) → `checks/<c-id>.json` ·
 * `rule-status/<ruleId>.json` 기록. 의존은 전부 주입받는다 ({@link RunCheckDeps}) — 코어는 `@plumb/adapter-nextjs`를 import하지 않는다.
 * 정적 검사(`runStaticChecks`)는 `Adapter` 인터페이스 밖이라 `staticRunner`로 따로 받는다 (CLI가 `adapter/load.ts`에서 가져와 넣는다).
 *
 * 순서:
 *   ① `store.status()` — 변조 증거여도 멈추지 않고 `CheckRun.storeStatus`에 적는다. 규칙 · 승인 · 이전 상태 · 규칙별 최신 주입 기록
 *      (`store.injections.latest`, #105)도 여기서 읽는다
 *   ② `adapter.runTests()` + `staticRunner()` + `adapter.extractDependencies()` — 하나가 실패해도 나머지는 계속. 실패 사유는 `runner.stderrTail`
 *   ③ `junitPath`가 있으면 `parseJunit` → `toCheckResults`. 없거나 깨졌으면 `junitMissing`
 *   ④ `computeRuleStatuses` + `computeOutOfScope` + `computeCommonRows` — 전부 통과한 규칙은 최신 주입 기록으로 🟢 · 🟡 · 🟠을 가른다
 *      (검사 파일의 현재 sha256을 `Validity.checkFileHashes`와 비교, §7.4)
 *   ⑤ `CheckRun` 조립 → `store.checks.write`. **JUnit 결과가 있을 때만** `store.ruleStatus.write` — 러너가 죽었으면(`junitPath: null`)
 *      이전 성공 결과를 건드리지 않고 `runner.exitCode` · `stderrTail`만 기록한다 (view-verification 5절 "plumb check 실패")
 *
 * 블록 그래프를 못 얻으면 "규칙 0개 블록" · "미분류 파일"은 0이 아니라 **측정 불가**다 — `OutOfScope`의 두 값에
 * `{ unavailable: 'no-graph' }`를 넣고 사유는 {@link RunCheckResult.graphUnavailable}에 적는다 (#63).
 * 3회 실행 격리(§7.5)는 M10 `--stability` — 지금은 `quarantined: []`.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  Adapter,
  AdapterContext,
  BlockGraph,
  StaticCheckRun,
  StaticRunner,
  TestRunResult,
} from '../adapter/types.js';
import { sha256 } from '../store/fs.js';
import type { Store, StoreStatus } from '../store/index.js';
import type {
  Anchor,
  ApprovalState,
  CheckKindLabel,
  CheckResult,
  CheckRun,
  CheckRunId,
  CommonCheckRow,
  OutOfScope,
  PlumbConfig,
  Rule,
  RuleId,
  RuleStatus,
  RuleStatusDetail,
  RuleStatusRecord,
  Validity,
} from '../types/index.js';
import { computeCommonRows } from './common.js';
import { type JunitCase, type JunitReport, parseJunit } from './junit.js';
import { toCheckResults } from './junit-to-results.js';
import { computeOutOfScope } from './out-of-scope.js';
import { approvalStatesFrom, computeRuleStatuses } from './status.js';

// ---------------------------------------------------------------------------
// 타입 — 정적 검사 결과 · 러너(`StaticCheckRun` · `StaticRunner`)는 `adapter/types.ts`
// ---------------------------------------------------------------------------

export interface RunCheckDeps {
  config: PlumbConfig;
  /** 대상 루트 (`plumb.config.json`이 있는 폴더, 절대 경로). 어댑터 컨텍스트의 `root`는 `resolve(root, config.service)` */
  root: string;
  store: Store;
  adapter: Adapter;
  /** 정적 검사. 없으면 정적 결과 없이 진행한다 (블록 공통 행은 전부 `unchecked`) */
  staticRunner?: StaticRunner;
  /** 기록 시각. 테스트가 바꾼다 */
  now?: () => Date;
  /** 이번 실행의 커밋. 기본 {@link gitHead} (`git rev-parse HEAD`, 실패하면 `'unknown'`) */
  resolveCommit?: (serviceRoot: string) => Promise<string>;
}

export interface RunCheckResult {
  /** `checks/<runId>.json`에 쓴 기록 */
  run: CheckRun;
  storeStatus: StoreStatus;
  rules: Rule[];
  approvalStates: Map<RuleId, ApprovalState>;
  /**
   * 규칙별 상태. 정상 경로면 이번 실행의 계산 결과(= `rule-status/`에 쓴 것). 러너가 죽었으면 **이전 기록**(기록 없는 규칙은 빠진다)
   * — {@link RunCheckResult.stale}
   */
  statuses: RuleStatusRecord[];
  /** `statuses`가 이전 실행의 것일 때. `previousCommit`은 이전 기록 중 가장 최근 커밋 (없으면 `null`) */
  stale: { exitCode: number; stderrTail: string[]; previousCommit: string | null } | null;
  outOfScope: OutOfScope;
  /** 블록 그래프를 못 얻은 사유 → `outOfScope`의 "규칙 0개 블록" · "미분류 파일"은 `{ unavailable: 'no-graph' }` */
  graphUnavailable: { reason: string } | null;
  common: CommonCheckRow[];
  /** 어느 규칙의 `checks[]`에도 없는 testcase (단위 테스트 — 규칙 근거 아님, §8.2) */
  unmapped: JunitCase[];
  /** JUnit XML이 없거나 깨짐 → 정적 검사만 반영됐다 */
  junitMissing: boolean;
  /** 테스트 러너가 보고서를 만들지 못했다 (죽음 · 러너 없음 · 어댑터 예외) */
  runnerFailed: boolean;
  testRun: TestRunResult | null;
  staticRun: StaticCheckRun | null;
  graph: BlockGraph | null;
  junitReport: JunitReport | null;
}

// ---------------------------------------------------------------------------
// 표시 문구 — CLI(`cli/commands/check.ts` · `rule.ts`)와 UI(`apps/ui`)가 같은 것을 쓴다
// ---------------------------------------------------------------------------

export const STATUS_ICON: Record<RuleStatus, string> = {
  'pass-verified': '🟢',
  'pass-unverified': '🟡',
  recheck: '🟠',
  fail: '🔴',
  unchecked: '⬜',
};

/** 검사 종류 → 화면 라벨 (view-verification 3.3 "검사 종류") */
export const CHECK_KIND_LABEL: CheckKindLabel = {
  acceptance: '인수 테스트',
  contract: '계약 테스트',
  pbt: 'PBT',
  static: '정적 분석',
  trace: '트레이스',
};

/** ⬜의 사유 (view-verification 3.3 ⬜ 비고 · 5절) */
export const UNCHECKED_REASON_LABEL: Record<Extract<RuleStatusDetail, { status: 'unchecked' }>['reason'], string> = {
  'no-checks': '검사 없음',
  'check-missing': '검사 파일 없음',
  unapproved: '미승인',
  quarantined: '불안정 격리',
  'not-run': '아직 안 돌림',
};

/** 아직 `plumb check`가 돌지 않은 규칙의 기본 상태 */
export const NOT_RUN_DETAIL: RuleStatusDetail = { status: 'unchecked', reason: 'not-run' };

/** `file:line`. 파일이 없으면 블록 또는 빈 문자열 */
export function anchorText(anchor: Anchor | undefined): string {
  if (anchor === undefined) return '';
  if (anchor.file === undefined) return anchor.block ?? '';
  return anchor.line === undefined ? anchor.file : `${anchor.file}:${anchor.line}`;
}

/**
 * 상태의 사유 한 줄 — view-verification 3.3 비고 열 · 2절 와이어프레임 문구.
 * 🔴는 첫 실패의 `file:line`, 🟡은 "유효성 미확인 (주입 기록 없음)", 🟢은 "유효 ✔", 🟠은 "검사 파일 바뀜 → 유효성 무효 · 재주입 대기".
 */
export function describeStatusDetail(detail: RuleStatusDetail): string {
  switch (detail.status) {
    case 'fail': {
      const first = detail.failures[0];
      const where = anchorText(first.anchor);
      return where === '' ? '실패' : `실패 · ${where}`;
    }
    case 'pass-verified':
      return detail.reason === 'static-proof' ? '유효 ✔ (정적 증명)' : '유효 ✔ (주입으로 확인)';
    case 'pass-unverified':
      return detail.reason === 'no-injection' ? '유효성 미확인 (주입 기록 없음)' : '유효성 무효 ✘ (주입이 검사를 통과)';
    case 'recheck':
      return detail.reason === 'check-file-changed'
        ? '검사 파일 바뀜 → 유효성 무효 · 재주입 대기'
        : '해석 불일치 보류 (검토 대기열)';
    case 'unchecked':
      return UNCHECKED_REASON_LABEL[detail.reason];
  }
}

/** 진술 요약: `summary`, 없으면 statement 앞 30자 (view-verification 3.3 "진술 요약") */
export function ruleSummary(rule: Pick<Rule, 'summary' | 'statement'>): string {
  if (rule.summary !== undefined && rule.summary.length > 0) return rule.summary;
  const chars = [...rule.statement];
  return chars.length <= 30 ? rule.statement : `${chars.slice(0, 30).join('')}…`;
}

/** 7자리 축약 커밋. `unknown`은 그대로 */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{12,}$/.test(commit) ? commit.slice(0, 7) : commit;
}

// ---------------------------------------------------------------------------
// 보조
// ---------------------------------------------------------------------------

/** `c-<ISO 시각 압축>` — `2026-10-02T09:00:01.000Z` → `c-20261002T090001000Z` (`store/checks.ts` `CHECK_RUN_ID_PATTERN`) */
export function checkRunIdAt(date: Date): CheckRunId {
  return `c-${date.toISOString().replace(/[-:.]/g, '')}`;
}

/**
 * `git rev-parse HEAD`. git이 없거나 레포가 아니면 `'unknown'` — 추정으로 커밋을 만들지 않는다.
 * `execFile`은 호출 시점에만 건드린다 (모듈 로드 시점에 `node:child_process`를 부분 모킹한 테스트가 깨지지 않게)
 */
export function gitHead(root: string): Promise<string> {
  return new Promise((resolveHead) => {
    try {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: root }, (error, stdout) => {
        const sha = typeof stdout === 'string' ? stdout.trim() : '';
        resolveHead(error === null && /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown');
      });
    } catch {
      resolveHead('unknown');
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 러너 꼬리에 적는 사유 줄. 어댑터 `capture.ts`의 `[plumb] …` 관례와 같은 접두어 */
function note(text: string): string {
  return `[plumb] ${text}`;
}

async function settle<T>(task: () => Promise<T>): Promise<{ value: T; error: null } | { value: null; error: string }> {
  try {
    return { value: await task(), error: null };
  } catch (error) {
    return { value: null, error: errorMessage(error) };
  }
}

/** 이전 기록 중 가장 최근 `checkedAt`의 커밋 */
function latestCommitOf(records: Iterable<RuleStatusRecord>): string | null {
  let latest: RuleStatusRecord | null = null;
  for (const record of records) {
    if (latest === null || record.checkedAt.localeCompare(latest.checkedAt) > 0) latest = record;
  }
  return latest === null ? null : latest.commit;
}

/** 블록 그래프가 없을 때의 범위 밖 — 두 항목은 빈 값이고 호출자가 "측정 불가"로 그린다 */
/** 블록 그래프 없음 — 파서에서 나오는 두 값은 측정 불가 (§12. 0이라고 쓰지 않는다) */
function outOfScopeWithoutGraph(statuses: RuleStatusRecord[]): OutOfScope {
  return {
    blocksWithoutRules: { unavailable: 'no-graph' },
    codeWithoutRules: [],
    rulesWithoutCode: statuses
      .filter((record) => record.detail.status === 'unchecked' && record.detail.reason === 'check-missing')
      .map((record) => ({ ruleId: record.ruleId, reason: 'check-missing' as const })),
    untestedFlows: { unavailable: 'no-trace' },
    unclassifiedFiles: { unavailable: 'no-graph' },
    quarantined: [],
  };
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export async function runCheck(deps: RunCheckDeps): Promise<RunCheckResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const serviceRoot = resolve(deps.root, deps.config.service);
  const ctx: AdapterContext = { root: serviceRoot, config: deps.config };
  const notes: string[] = [];

  // ① 저장소 — 변조여도 계속 (경보는 CheckRun.storeStatus와 표 상단)
  const storeStatus = await deps.store.status();
  const rules = await deps.store.rules.list();
  const approvals = (await Promise.all(rules.map((rule) => deps.store.approvals.history(rule.id)))).flat();
  const approvalStates = approvalStatesFrom(approvals);
  const previousRecords = await deps.store.ruleStatus.list();
  const previous = new Map(previousRecords.map((record) => [record.ruleId, record]));
  const validity = new Map<RuleId, Validity>();
  for (const rule of rules) {
    const latest = await deps.store.injections.latest(rule.id);
    if (latest !== undefined) validity.set(rule.id, latest);
  }

  // ② 실행 — 셋 중 무엇이 실패해도 나머지는 계속
  const tests = await settle(() => deps.adapter.runTests(ctx, {}));
  if (tests.error !== null) notes.push(note(`테스트 러너 실행 실패: ${tests.error}`));
  const testRun = tests.value;

  let staticRun: StaticCheckRun | null = null;
  if (deps.staticRunner !== undefined) {
    const statics = await settle(() => (deps.staticRunner as StaticRunner)(ctx));
    if (statics.error !== null) notes.push(note(`정적 검사 실행 실패: ${statics.error}`));
    staticRun = statics.value;
  } else {
    notes.push(note('정적 검사 러너 없음 — 블록 공통 필수 검사는 unchecked'));
  }
  if (staticRun !== null && staticRun.graphJsonPath === null) {
    notes.push(note('정적 검사 결과 JSON 없음 — 블록 공통 필수 검사는 unchecked'));
  }

  const graphResult = await settle(() => deps.adapter.extractDependencies(ctx));
  const graph = graphResult.value;
  const graphUnavailable = graphResult.error === null ? null : { reason: graphResult.error };
  if (graphUnavailable !== null) {
    notes.push(note(`블록 그래프 없음 — "규칙 0개 블록" · "미분류 파일"은 측정 불가: ${graphUnavailable.reason}`));
  }

  // ③ JUnit
  let junitReport: JunitReport | null = null;
  let junitResults: CheckResult[] = [];
  let unmapped: JunitCase[] = [];
  if (testRun !== null && testRun.junitPath !== null) {
    try {
      junitReport = parseJunit(await readFile(testRun.junitPath, 'utf8'), { root: serviceRoot });
      const mapped = toCheckResults(junitReport, rules, { root: serviceRoot });
      junitResults = mapped.results;
      unmapped = mapped.unmapped;
    } catch (error) {
      junitReport = null;
      notes.push(note(`JUnit 결과를 읽을 수 없다 (${testRun.junitPath}): ${errorMessage(error)}`));
    }
  } else if (testRun !== null) {
    notes.push(note(`JUnit 결과 없음 — 러너 exit ${testRun.exitCode}. 리포터 설정 확인 (vitest --reporter=junit)`));
  }
  const junitMissing = junitReport === null;
  const runnerFailed = testRun === null || testRun.junitPath === null;
  const staticResults = staticRun?.results ?? [];
  const results = [...junitResults, ...staticResults];

  // ④ 계산
  const commit = await (deps.resolveCommit ?? gitHead)(serviceRoot);
  const checkedAt = now();
  const fileExists = (relPath: string) => existsSync(resolve(serviceRoot, relPath));
  // injector(`run/inject.ts`)와 같은 방식 — utf8 문자열의 sha256. 읽을 수 없으면 undefined (→ 기록과 다름)
  const fileHash = (relPath: string): string | undefined => {
    try {
      return sha256(readFileSync(resolve(serviceRoot, relPath), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const computed = junitMissing
    ? null
    : computeRuleStatuses({
        rules,
        approvalStates,
        results,
        quarantined: [],
        previous,
        fileExists,
        validity,
        fileHash,
        now: checkedAt,
        commit,
      });
  const statuses =
    computed ?? rules.flatMap((rule) => (previous.has(rule.id) ? [previous.get(rule.id) as RuleStatusRecord] : []));
  const common = computeCommonRows(staticResults);
  const outOfScope =
    graph === null ? outOfScopeWithoutGraph(statuses) : computeOutOfScope({ rules, graph, statuses, quarantined: [] });

  // ⑤ 기록
  const stderrTail = [...notes, ...(testRun?.output.tail ?? [])];
  const run: CheckRun = {
    runId: checkRunIdAt(checkedAt),
    commit,
    startedAt: startedAt.toISOString(),
    finishedAt: checkedAt.toISOString(),
    runner: {
      exitCode: testRun?.exitCode ?? -1,
      ...(stderrTail.length > 0 ? { stderrTail } : {}),
    },
    results,
    quarantined: [],
    counts: { junit: junitReport?.totals.tests ?? 0, static: staticResults.length },
    storeStatus: storeStatus.status,
  };
  await deps.store.checks.write(run);
  if (computed !== null) await deps.store.ruleStatus.write(computed);

  return {
    run,
    storeStatus,
    rules,
    approvalStates,
    statuses,
    stale:
      computed === null
        ? { exitCode: run.runner.exitCode, stderrTail, previousCommit: latestCommitOf(previousRecords) }
        : null,
    outOfScope,
    graphUnavailable,
    common,
    unmapped,
    junitMissing,
    runnerFailed,
    testRun,
    staticRun,
    graph,
    junitReport,
  };
}
