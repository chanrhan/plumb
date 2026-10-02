/**
 * `plumb check [--json] [--strict] [--filter <pattern>]` (이슈 #47, 기획안 §7.3 · §7.5 · §11, view-verification 3절).
 *
 * 흐름: `--target` → 설정 → 저장소 → 어댑터 로드(`adapter/load.ts`, 테스트는 가짜를 주입) → `runCheck()`(`checks/run-check.ts`) → 표.
 * 표는 view-verification 3.2 형식 — 상단 요약 두 줄 · 블록별 집계 줄 + 규칙 행 · "블록 공통 (필수 검사)" 행 3개 ·
 * **`━━ 검사 범위 밖 ━━` 절(생략 불가)** · 러너 출력 꼬리 5줄 · 규칙 근거가 아닌 testcase(unmapped) 수.
 *
 * `--filter <pattern>`은 **표시**만 거른다 (규칙 ID · 블록, `*` 글롭). 검사는 항상 전부 돌고 전부 기록된다 — 일부만 돌리면 나머지 규칙이
 * `not-run`으로 덮여 이전 결과를 잃기 때문이다. 상단 요약과 "검사 범위 밖"은 필터와 무관하게 전체 값이다 (view-verification 4절).
 *
 * 종료 코드: 0 (기록이 목적 — 기획안 §11 "커밋 시 정적 검사·결과 기록, 차단 없음"). `--strict`(병합 게이트용)면 변조 증거 5 ·
 * 러너 실패(JUnit 결과 없음) 6 · 🔴 있음 4 (이 순서로 첫 것).
 */

import { relative } from 'node:path';
import type { Command } from 'commander';
import { loadAdapter as defaultLoadAdapter } from '../../adapter/load.js';
import {
  anchorText,
  CHECK_KIND_LABEL,
  describeStatusDetail,
  NOT_RUN_DETAIL,
  type RunCheckResult,
  ruleSummary,
  runCheck,
  STATUS_ICON,
  shortCommit,
} from '../../checks/run-check.js';
import {
  type BlockSummary,
  COMMON_BLOCK_ID,
  computeBlockSummaries,
  computeStatusCounts,
} from '../../checks/summary.js';
import type { CommonCheckRow, Rule, RuleStatus, RuleStatusRecord, StatusCounts } from '../../types/index.js';
import {
  type CliContext,
  displayWidth,
  EXIT_OK,
  type OpenedStore,
  openTargetStore,
  padColumn,
  paint,
  runCommand,
  statusLine,
  targetOf,
  writeJson,
} from './shared.js';

/** `--strict`: 🔴 있음 */
export const EXIT_CHECK_FAIL = 4;
/** `--strict`: 보호 저장소 변조 증거 */
export const EXIT_CHECK_TAMPERED = 5;
/** `--strict`: 테스트 러너가 JUnit 결과를 만들지 못함 */
export const EXIT_CHECK_RUNNER = 6;

export const OUT_OF_SCOPE_HEADER = '━━ 검사 범위 밖 ━━';
export const COMMON_SECTION_HEADER = '블록 공통 (필수 검사, 기획안 §12)';
/** 블록 없는 규칙(`block` 비움) 묶음의 표시 이름. 필수 검사 절과 구분한다 */
export const COMMON_RULES_LABEL = '블록 공통 규칙 (block 없음)';
export const RUNNER_TAIL_LINES = 5;

const STATUS_ORDER: readonly RuleStatus[] = ['pass-verified', 'pass-unverified', 'recheck', 'fail', 'unchecked'];
/** 진술 요약 열의 상한. 그 안에서는 가장 긴 행에 맞춘다 — 규칙 ID가 잘리지 않게 */
const SUMMARY_WIDTH_MAX = 90;
const KIND_WIDTH = 12;
const LABEL_WIDTH = 24;
const RIGHT_COLUMN = 76;

export interface CheckOptions {
  json: boolean;
  strict: boolean;
  filter?: string;
}

// ---------------------------------------------------------------------------
// 계산 보조
// ---------------------------------------------------------------------------

/** `*` 글롭 또는 부분 문자열. 규칙 ID와 블록 어느 쪽이든 맞으면 보인다 */
export function matchesFilter(rule: Pick<Rule, 'id' | 'block'>, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern.trim() === '') return true;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const exact = new RegExp(`^${source}$`);
  const targets = [rule.id, rule.block ?? ''];
  return targets.some((target) => exact.test(target) || target.includes(pattern));
}

/** 상태 집계를 `🟢 5 🟡 2 …`로. `all`이면 0도 보인다 (상단 요약), 아니면 0은 뺀다 (블록 줄) */
export function countsText(counts: StatusCounts, all = false): string {
  return STATUS_ORDER.filter((status) => all || counts[status] > 0)
    .map((status) => `${STATUS_ICON[status]} ${counts[status]}`)
    .join(' ');
}

/** `2026-10-02T09:00:01.000Z` → `2026-10-02 09:00 UTC` */
export function timeText(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
}

function commitTime(result: RunCheckResult): string {
  return `${shortCommit(result.run.commit)} · ${timeText(result.run.finishedAt)}`;
}

/** 왼쪽 텍스트 뒤에 오른쪽 열(커밋 · 시각)을 붙인다. 왼쪽이 길면 두 칸만 띄운다 */
function withRight(left: string, right: string): string {
  const gap = Math.max(2, RIGHT_COLUMN - displayWidth(left));
  return `${left}${' '.repeat(gap)}${right}`;
}

function commonIcon(row: CommonCheckRow): string {
  switch (row.result.status) {
    case 'pass':
      return STATUS_ICON['pass-verified'];
    case 'fail':
      return STATUS_ICON.fail;
    case 'events':
      return row.result.count === row.result.withDecision ? STATUS_ICON['pass-verified'] : STATUS_ICON.fail;
    case 'unchecked':
      return STATUS_ICON.unchecked;
  }
}

/** 필수 검사 행의 사유 열 */
export function describeCommonRow(row: CommonCheckRow): string {
  switch (row.result.status) {
    case 'pass':
      return '—';
    case 'fail': {
      const first = row.result.violations[0];
      return `위반 ${row.result.violations.length}건 · ${first.from.file}:${first.from.line} → ${first.to || '?'}`;
    }
    case 'events':
      return `이벤트 ${row.result.count} · 사유 기록 ${row.result.withDecision}`;
    case 'unchecked':
      return row.index === 3 ? '검사 없음 (M8 — git 공개 진입점 diff)' : '검사 없음 (정적 결과 없음)';
  }
}

function commonCounts(rows: CommonCheckRow[]): string {
  const counts = computeStatusCounts(
    rows.map((row) => {
      const icon = commonIcon(row);
      const status: RuleStatus =
        icon === STATUS_ICON.fail ? 'fail' : icon === STATUS_ICON['pass-verified'] ? 'pass-verified' : 'unchecked';
      return { detail: { status } as RuleStatusRecord['detail'] };
    }),
  );
  return countsText(counts);
}

export function exitCodeOf(result: RunCheckResult, strict: boolean): number {
  if (!strict) return EXIT_OK;
  if (result.storeStatus.status === 'tampered') return EXIT_CHECK_TAMPERED;
  if (result.runnerFailed) return EXIT_CHECK_RUNNER;
  if (result.statuses.some((record) => record.detail.status === 'fail')) return EXIT_CHECK_FAIL;
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// 표
// ---------------------------------------------------------------------------

interface RenderInput {
  ctx: CliContext;
  opened: OpenedStore;
  result: RunCheckResult;
  pattern: string | undefined;
}

/** 규칙 행의 첫 열 `요약 (id)` */
function ruleLabel(rule: Rule): string {
  return `${ruleSummary(rule)} (${rule.id})`;
}

/** 필수 검사 행의 첫 열 `(n) 제목` */
function commonLabel(row: CommonCheckRow): string {
  return `(${row.index}) ${row.title}`;
}

/** 요약 열 폭: 보이는 규칙 행과 필수 검사 행 중 가장 긴 것 (상한 {@link SUMMARY_WIDTH_MAX}) */
function summaryWidth(rules: Rule[], common: CommonCheckRow[]): number {
  const widths = [
    ...rules.map((rule) => displayWidth(ruleLabel(rule))),
    ...common.map((row) => displayWidth(commonLabel(row))),
  ];
  return Math.min(SUMMARY_WIDTH_MAX, Math.max(20, ...widths));
}

function ruleLines(rule: Rule, record: RuleStatusRecord | undefined, stale: boolean, width: number): string[] {
  const detail = record?.detail ?? NOT_RUN_DETAIL;
  const icon = STATUS_ICON[detail.status];
  const kind = rule.checks[0] === undefined ? '검사 없음' : CHECK_KIND_LABEL[rule.checks[0].kind];
  let reason = describeStatusDetail(detail);
  if (record === undefined) reason = `${reason} (기록 없음)`;
  else if (stale) reason = `${reason} (이전 결과 ${shortCommit(record.commit)})`;
  const lines = [`  ${icon} ${padColumn(ruleLabel(rule), width)}  ${padColumn(kind, KIND_WIDTH)}  ${reason}`];
  if (detail.status === 'fail') {
    for (const failure of detail.failures) {
      const where = anchorText(failure.anchor);
      lines.push(`       ${where === '' ? '' : `${where}  `}${failure.message.split(/\r?\n/)[0] ?? ''}`);
      if (failure.counterexample !== undefined || failure.seed !== undefined) {
        lines.push(
          `       fast-check 반례: ${failure.counterexample ?? '—'}${failure.seed === undefined ? '' : ` · 시드 ${failure.seed}`}`,
        );
      }
    }
  }
  return lines;
}

function blockLines(
  block: BlockSummary,
  rules: Rule[],
  byRule: Map<string, RuleStatusRecord>,
  input: RenderInput,
  width: number,
) {
  const label = block.id === COMMON_BLOCK_ID ? COMMON_RULES_LABEL : block.id;
  const head = `${label} — 규칙 ${block.rules} · 승인 ${block.approved}${
    block.rules > 0 ? ` · ${countsText(block.byStatus) || '(상태 기록 없음)'}` : ''
  }`;
  const lines = [withRight(head, commitTime(input.result))];
  for (const rule of rules) lines.push(...ruleLines(rule, byRule.get(rule.id), input.result.stale !== null, width));
  return lines;
}

function outOfScopeLines(result: RunCheckResult): string[] {
  const out = result.outOfScope;
  const unavailable = result.graphUnavailable;
  const row = (label: string, value: string) => `  ${padColumn(`${label}:`, LABEL_WIDTH)} ${value}`;
  const blocks =
    unavailable !== null
      ? `측정 불가 (블록 그래프 없음 — ${unavailable.reason})`
      : out.blocksWithoutRules.length === 0
        ? '없음'
        : out.blocksWithoutRules.join(', ');
  const code =
    out.codeWithoutRules.length === 0
      ? '없음 (규칙 scope 미도입 — 규칙은 블록 전체를 덮는다)'
      : out.codeWithoutRules.map((item) => `${item.path} (파일 ${item.files})`).join(' · ');
  const rulesWithoutCode =
    out.rulesWithoutCode.length === 0
      ? '없음'
      : out.rulesWithoutCode
          .map((item) => `${item.ruleId} (${item.reason === 'check-missing' ? '검사 파일 없음' : 'scope 글롭 매칭 0'})`)
          .join(' · ');
  const flows =
    'unavailable' in out.untestedFlows
      ? out.untestedFlows.unavailable === 'no-trace'
        ? '측정 불가 (트레이스 없음)'
        : '측정 불가 (정적 그래프 없음)'
      : `${out.untestedFlows.count}개 / 진입점 ${out.untestedFlows.total} (${out.untestedFlows.mode})`;
  const unclassified = unavailable !== null ? '측정 불가 (블록 그래프 없음)' : `${out.unclassifiedFiles}개`;
  const quarantined =
    out.quarantined.length === 0
      ? '0'
      : `${out.quarantined.length} — ${out.quarantined
          .map((item) => `${item.ref} (${item.runs}회 중 ${item.passes}회 통과)`)
          .join(' · ')}`;
  return [
    withRight(OUT_OF_SCOPE_HEADER, commitTime(result)),
    row('규칙 0개 블록', blocks),
    row('요구사항에 없는 코드', code),
    row('코드에 없는 요구사항', rulesWithoutCode),
    row('테스트가 안 지나간 흐름', flows),
    row('미분류 파일', unclassified),
    row('불안정으로 격리된 검사', quarantined),
  ];
}

export function renderCheck(input: RenderInput): string {
  const { ctx, opened, result, pattern } = input;
  const { storeStatus, run, rules, statuses, approvalStates } = result;
  const byRule = new Map(statuses.map((record) => [record.ruleId, record]));
  const lines: string[] = [];

  // 상단 요약 (전체 값 — 필터와 무관)
  lines.push(`${statusLine(ctx, storeStatus)} · 마지막 검사 ${commitTime(result)}`);
  const counts = computeStatusCounts(statuses);
  const approved = rules.filter((rule) => approvalStates.get(rule.id) === 'approved').length;
  lines.push(
    `규칙 ${rules.length} · 승인 ${approved} · ${countsText(counts, true)} · 검사 ${run.counts.junit + run.counts.static} (JUnit ${run.counts.junit} · 정적 ${run.counts.static}) · 격리 ${run.quarantined.length}`,
  );
  if (result.stale !== null) {
    const previous =
      result.stale.previousCommit === null
        ? '이전 결과 없음'
        : `이전 결과(${shortCommit(result.stale.previousCommit)})를 보인다`;
    lines.push(
      paint(
        ctx,
        'red',
        `⚠ 검사 실패 (exit ${result.stale.exitCode}) — JUnit 결과 없음. rule-status는 그대로 두고 ${previous} (러너 출력은 아래)`,
      ),
    );
  }
  lines.push('');

  // 블록별
  const visible = rules.filter((rule) => matchesFilter(rule, pattern));
  const width = summaryWidth(visible, result.common);
  if (rules.length === 0) {
    lines.push('규칙 없음 — `plumb rule propose --file <json>` → `plumb approve <id>`로 규칙을 만든다', '');
  } else if (visible.length === 0) {
    lines.push(`필터 "${pattern ?? ''}"에 맞는 규칙 없음 (규칙 ${rules.length})`, '');
  } else {
    for (const block of computeBlockSummaries({ rules: visible, statuses, approvalStates })) {
      const own = visible.filter((rule) => (rule.block ?? COMMON_BLOCK_ID) === block.id);
      lines.push(...blockLines(block, own, byRule, input, width), '');
    }
  }

  // 블록 공통 — 필수 검사 (1)(2)(3)
  lines.push(withRight(`${COMMON_SECTION_HEADER} — ${commonCounts(result.common)}`, commitTime(result)));
  for (const row of result.common) {
    lines.push(
      `  ${commonIcon(row)} ${padColumn(commonLabel(row), width)}  ${padColumn(CHECK_KIND_LABEL.static, KIND_WIDTH)}  ${describeCommonRow(row)}`,
    );
  }
  lines.push('');

  // 검사 범위 밖 — 생략 불가
  lines.push(...outOfScopeLines(result), '');

  // 러너 출력 꼬리 · unmapped · 기록 위치
  const tail = (run.runner.stderrTail ?? []).slice(-RUNNER_TAIL_LINES);
  lines.push(`러너 출력 (마지막 ${RUNNER_TAIL_LINES}줄${tail.length === 0 ? ' — 없음' : ''}):`);
  for (const line of tail) lines.push(`  ${line}`);
  if (result.junitMissing) {
    lines.push('JUnit 결과 없음 — 리포터 설정 확인 (`vitest --reporter=junit`). 정적 검사만 반영');
  } else {
    lines.push(
      `단위 테스트 ${result.unmapped.length}개 — 규칙 근거 아님 (어느 규칙의 checks[]에도 없는 testcase · unmapped)`,
    );
  }
  const base = ctx.cwd ?? process.cwd();
  const checkPath = relative(base, opened.store.paths.check(run.runId));
  lines.push(
    result.stale === null
      ? `기록: ${checkPath} · rule-status/ ${statuses.length}개 갱신`
      : `기록: ${checkPath} (rule-status/는 보존)`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

export async function checkCommand(ctx: CliContext, opened: OpenedStore, options: CheckOptions): Promise<number> {
  const { config, loaded, store } = opened;
  const load = ctx.loadAdapter ?? defaultLoadAdapter;
  const { adapter, staticRunner } = await load(config.adapter);

  const result = await runCheck({
    config,
    root: loaded.root,
    store,
    adapter,
    ...(staticRunner === undefined ? {} : { staticRunner }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });
  const code = exitCodeOf(result, options.strict);

  if (options.json) {
    const visible = result.rules.filter((rule) => matchesFilter(rule, options.filter));
    const byRule = new Map(result.statuses.map((record) => [record.ruleId, record]));
    writeJson(ctx, {
      run: result.run,
      store: {
        status: result.storeStatus.status,
        unconfirmed: result.storeStatus.unconfirmed,
        longestPendingDays: result.storeStatus.longestPendingDays,
      },
      summary: {
        rules: result.rules.length,
        approved: result.rules.filter((rule) => result.approvalStates.get(rule.id) === 'approved').length,
        byStatus: computeStatusCounts(result.statuses),
        checks: result.run.counts,
        quarantined: result.run.quarantined.length,
      },
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      blocks: computeBlockSummaries({
        rules: visible,
        statuses: result.statuses,
        approvalStates: result.approvalStates,
      }).map((block) => ({
        ...block,
        items: visible
          .filter((rule) => (rule.block ?? COMMON_BLOCK_ID) === block.id)
          .map((rule) => {
            const record = byRule.get(rule.id);
            return {
              ruleId: rule.id,
              ...(rule.block === undefined ? {} : { block: rule.block }),
              kind: rule.kind,
              summary: ruleSummary(rule),
              statement: rule.statement,
              checks: rule.checks,
              detail: record?.detail ?? NOT_RUN_DETAIL,
              ...(record === undefined
                ? {}
                : { since: record.since, commit: record.commit, checkedAt: record.checkedAt, history: record.history }),
            };
          }),
      })),
      common: result.common,
      outOfScope: result.outOfScope,
      graphUnavailable: result.graphUnavailable,
      unmapped: {
        count: result.unmapped.length,
        cases: result.unmapped.map((testcase) => ({ id: testcase.id, file: testcase.file ?? null })),
      },
      junitMissing: result.junitMissing,
      runnerFailed: result.runnerFailed,
      stale: result.stale,
      exitCode: code,
    });
  } else {
    ctx.stdout.write(renderCheck({ ctx, opened, result, pattern: options.filter }));
  }
  return code;
}

export function registerCheckCommand(program: Command, ctx: CliContext): Command {
  return program
    .command('check')
    .description('전체 검사를 돌려 규칙별 상태를 기록한다 (M5)')
    .option('--json', '기계용 JSON 출력', false)
    .option('--strict', '병합 게이트용: 변조 증거 exit 5 · 러너 실패 6 · 🔴 있음 4', false)
    .option('--filter <pattern>', '표시할 규칙 (규칙 ID · 블록, * 글롭). 검사와 기록은 항상 전부')
    .action(async (options: CheckOptions, command: Command) => {
      await runCommand(ctx, async () => checkCommand(ctx, await openTargetStore(ctx, targetOf(command)), options));
    });
}
