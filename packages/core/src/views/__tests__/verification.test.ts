/**
 * 테스트/검증 상태 View 생성기 (이슈 #57). 임시 저장소에 코어 API로 규칙 · 승인 · 가짜 `CheckRun` · `rule-status`를 써 넣고
 * `generate()` JSON과 `render()` Markdown을 확인한다. `plumb check`는 돌리지 않는다 — 기록만 읽는다.
 * 마지막 describe는 `examples/testbed`에서 **실제로** `rule propose → approve → plumb check`를 돌린 뒤 생성기를 돌린다.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedAdapter } from '../../adapter/load.js';
import { monorepoAdapterEntry } from '../../adapter/load.js';
import type { Adapter } from '../../adapter/types.js';
import { NOT_RUN_DETAIL, ruleSummary } from '../../checks/run-check.js';
import { createProgram } from '../../cli/program.js';
import { loadConfigFile } from '../../config/load.js';
import { writeDecision } from '../../decisions/store.js';
import { openStore, type Store } from '../../store/index.js';
import type {
  CheckFailure,
  CheckRun,
  PlumbConfig,
  Proposal,
  Rule,
  RuleStatusRecord,
  Validity,
} from '../../types/index.js';
import { PLUMB_OPEN_SCHEME } from '../markdown.js';
import type { ViewContext } from '../types.js';
import {
  COMMON_SECTION_HEADER,
  NO_CHECK_MESSAGE,
  OUT_OF_SCOPE_HEADER,
  VALIDITY_UNKNOWN,
  verificationView,
} from '../verification.js';

const ROLE = { model: 'default', maxTurns: 1, maxBudgetUsd: 0 };

const CONFIG: PlumbConfig = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs',
  roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
  stopBlockLimit: 5,
  blocks: {
    payment: { include: ['src/domains/payment/**'], dependsOn: [], risk: 'high' },
    auth: { include: ['src/domains/auth/**'], dependsOn: [] },
  },
};

const NOW = new Date('2026-10-02T09:00:00.000Z');
const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const PREVIOUS_COMMIT = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
const CHECK_FILE = 'test/acceptance/refund-window.property.spec.ts';

/** 승인되는 규칙 — 인수 테스트 하나, 결정 D-0001 (rules.yaml `decision`) */
const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: CHECK_FILE }],
  decision: 'D-0001',
};

/** 잠정으로 남는 규칙 — 검사 없음, 결정은 `decisions/`의 links.rules로만 연결 */
const RECORD_RULE: Rule = {
  id: 'pay.payment-record',
  block: 'payment',
  kind: 'technical',
  statement: 'THE SYSTEM SHALL 결제 성공 시 Payment 레코드를 남긴다',
  source: 'code:src/domains/payment/index.ts',
  risk: 'normal',
  depends_on: [],
  checks: [],
};

function proposalFor(rule: Rule, id: Proposal['id'], proposedAt: string): Proposal {
  return {
    id,
    ruleId: rule.id,
    changeKind: 'add',
    proposedBy: 'cli',
    proposedAt,
    after: rule,
    requiresPriorApproval: false,
    applied: 'provisional',
  };
}

const REFUND_FAILURE: CheckFailure = {
  check: { kind: 'acceptance', ref: CHECK_FILE },
  anchor: { block: 'payment', file: CHECK_FILE, line: 42 },
  message: 'AssertionError: expected 8 to be less than 8',
  counterexample: '[8]',
  seed: '42',
};

/** 인수 테스트 실패 1(반례 · 시드) + 정적 2 통과 */
const FAILING_RUN: CheckRun = {
  runId: 'c-20261002T085900000Z',
  commit: COMMIT,
  startedAt: '2026-10-02T08:58:00.000Z',
  finishedAt: '2026-10-02T08:59:00.000Z',
  runner: { exitCode: 1, stderrTail: ['Tests  1 failed (1)'] },
  results: [
    {
      check: { kind: 'acceptance', ref: CHECK_FILE },
      ruleIds: [REFUND_RULE.id],
      outcome: 'fail',
      durationSec: 1.2,
      failure: REFUND_FAILURE,
    },
    { check: { kind: 'static', ref: 'depcruise:block-1-public-entry-only' }, ruleIds: [], outcome: 'pass' },
    { check: { kind: 'static', ref: 'depcruise:block-2-no-cycles' }, ruleIds: [], outcome: 'pass' },
  ],
  quarantined: [],
  counts: { junit: 1, static: 2 },
  storeStatus: 'ok',
};

const FAIL_RECORD: RuleStatusRecord = {
  ruleId: REFUND_RULE.id,
  detail: { status: 'fail', failures: [REFUND_FAILURE] },
  since: '2026-10-02T08:59:00.000Z',
  commit: COMMIT,
  checkedAt: '2026-10-02T08:59:00.000Z',
  history: ['pass-unverified', 'fail'],
};

/** 인수 테스트까지 전부 통과한 실행 (🟢 · 🟡 행용) */
const PASSING_RUN: CheckRun = {
  ...FAILING_RUN,
  runner: { exitCode: 0, stderrTail: [] },
  results: [{ ...(FAILING_RUN.results[0] as CheckRun['results'][number]), outcome: 'pass', failure: undefined }],
};

const INJECTION_COMMIT = 'b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1';

/** 위반 주입 기록 한 건 (§7.4) — 결과(검사 실패 ✔ / 검사 통과 ✘)만 테스트마다 바꾼다 */
const INJECTION_BASE = {
  id: 'i-0001' as const,
  ruleId: REFUND_RULE.id,
  description: '7일 경계를 8일로 바꿈',
  anchor: { block: 'payment', file: 'src/domains/payment/refund.ts', line: 17 },
  commit: INJECTION_COMMIT,
  at: '2026-10-01T09:00:00.000Z',
  checkFileHashes: { [CHECK_FILE]: 'sha256:deadbeef' },
} satisfies Omit<Validity, 'result' | 'valid'>;

/** 생성기는 어댑터를 부르지 않는다 — 부르면 실패하는 가짜 */
const NEVER_ADAPTER: Adapter = {
  name: 'nextjs',
  async extractDependencies() {
    throw new Error('View 생성기는 어댑터를 부르지 않는다');
  },
  async generateStubs() {
    throw new Error('View 생성기는 어댑터를 부르지 않는다');
  },
  async runTests() {
    throw new Error('View 생성기는 어댑터를 부르지 않는다 — plumb check를 다시 돌리지 않는다');
  },
  async readSchemas() {
    throw new Error('View 생성기는 어댑터를 부르지 않는다');
  },
  async collectTraces() {
    throw new Error('View 생성기는 어댑터를 부르지 않는다');
  },
};

let dir: string;
let store: Store;

function ctxOf(overrides: Partial<ViewContext> = {}): ViewContext {
  return { root: dir, config: CONFIG, store, adapter: NEVER_ADAPTER, commit: COMMIT, now: () => NOW, ...overrides };
}

/** 규칙 2개: 하나 승인(km) · 하나 잠정(12일 체류). 결정 D-0002는 `decisions/`에서 잠정 규칙을 가리킨다 */
async function seedRules(): Promise<void> {
  await store.proposals.write(proposalFor(REFUND_RULE, 'p-0001', '2026-09-30T09:00:00.000Z'));
  const approved = await store.approvals.approve({ ruleId: REFUND_RULE.id, proposalId: 'p-0001', by: 'km' });
  expect(approved.applied).toBe(true);
  await store.proposals.write(proposalFor(RECORD_RULE, 'p-0002', '2026-09-20T09:00:00.000Z'));
  await writeDecision(store.paths, {
    id: 'D-0002',
    title: 'Payment 레코드는 결제 성공 시에만 만든다',
    block: 'payment',
    date: '2026-09-20T09:00:00.000Z',
    decision: '결제 성공 시 Payment 레코드를 남긴다',
    reason: '정산의 근거',
    rejected: '실패 시에도 남기기',
    accepted: '실패 이력은 로그로만 남는다',
    links: { rules: [RECORD_RULE.id], commits: [], events: [] },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-view-verification-'));
  store = openStore(CONFIG, dir, { now: () => NOW });
  await store.init();
});

afterEach(() => rm(dir, { recursive: true, force: true }));

/** 절 머리글부터 다음 `## `까지 */
function section(markdown: string, header: string): string {
  const start = markdown.indexOf(header);
  if (start < 0) throw new Error(`"${header}" 절이 없다:\n${markdown}`);
  const end = markdown.indexOf('\n## ', start);
  return markdown.slice(start, end < 0 ? undefined : end);
}

describe('verificationView.generate — 저장소 기록만 읽는다', () => {
  it('승인 1 + 🔴 CheckRun / 잠정 1 → byStatus · unconfirmed · 체류 · 블록 · 범위 밖 · 출처', async () => {
    await seedRules();
    await store.checks.write(FAILING_RUN);
    await store.ruleStatus.write([FAIL_RECORD]);

    const view = await verificationView.generate(ctxOf());

    expect(view.header).toEqual({
      view: 'verification',
      generatedAt: NOW.toISOString(),
      commit: COMMIT,
      sources: [
        { kind: 'execution', tool: 'plumb check', input: 'checks/c-20261002T085900000Z.json' },
        { kind: 'store', input: 'rule-status/' },
        { kind: 'store', input: 'rules.yaml' },
        { kind: 'store', input: 'proposals/' },
        { kind: 'store', input: 'decisions/' },
      ],
    });
    expect(view.store).toEqual({ status: 'ok' });
    expect(view.lastCheck).toEqual({
      runId: FAILING_RUN.runId,
      commit: COMMIT,
      finishedAt: '2026-10-02T08:59:00.000Z',
    });
    expect(view.staleResult).toBeUndefined();
    expect(view.junitMissing).toBe(false);

    expect(view.summary).toEqual({
      unconfirmed: 1,
      longestPendingDays: 12,
      longestPendingRule: RECORD_RULE.id,
      rules: 2,
      approved: 1,
      byStatus: { 'pass-verified': 0, 'pass-unverified': 0, recheck: 0, fail: 1, unchecked: 1 },
      checks: { junit: 1, static: 2 },
      quarantined: 0,
    });

    // 블록 — payment 하나, 🔴가 먼저
    expect(view.blocks).toHaveLength(1);
    const block = view.blocks[0];
    expect(block).toMatchObject({
      id: 'payment',
      rules: 2,
      approved: 1,
      byStatus: { fail: 1, unchecked: 1 },
      lastCheck: view.lastCheck,
    });
    expect(block?.items.map((row) => row.ruleId)).toEqual([REFUND_RULE.id, RECORD_RULE.id]);

    const [failRow, pendingRow] = block?.items ?? [];
    expect(failRow).toMatchObject({
      ruleId: REFUND_RULE.id,
      block: 'payment',
      kind: 'business',
      summary: ruleSummary(REFUND_RULE),
      statement: REFUND_RULE.statement,
      checks: REFUND_RULE.checks,
      grade: 2,
      detail: FAIL_RECORD.detail,
      approvedAt: NOW.toISOString(),
      approvedBy: 'km',
      decision: 'D-0001',
      lastResult: { commit: COMMIT, finishedAt: '2026-10-02T08:59:00.000Z', durationSec: 1.2 },
      history: ['pass-unverified', 'fail'],
    });
    expect(failRow).not.toHaveProperty('validity');
    expect(failRow).not.toHaveProperty('pendingSince');

    expect(pendingRow).toMatchObject({
      ruleId: RECORD_RULE.id,
      detail: { status: 'unchecked', reason: 'unapproved' },
      decision: 'D-0002',
      pendingSince: '2026-09-20T09:00:00.000Z',
      history: [],
    });
    expect(pendingRow).not.toHaveProperty('grade');
    expect(pendingRow).not.toHaveProperty('approvedAt');

    // 블록 공통 — 최신 CheckRun의 정적 결과로
    expect(view.common.map((row) => [row.index, row.result.status])).toEqual([
      [1, 'pass'],
      [2, 'pass'],
      [3, 'unchecked'],
    ]);

    // 검사 범위 밖 — 블록 그래프 없이 설정 키로
    expect(view.outOfScope).toEqual({
      blocksWithoutRules: ['auth'],
      codeWithoutRules: [],
      rulesWithoutCode: [],
      untestedFlows: { unavailable: 'no-trace' },
      // 이 생성기는 블록 그래프를 읽지 않는다 → 측정 불가 (0이 아니다, #63)
      unclassifiedFiles: { unavailable: 'no-graph' },
      quarantined: [],
    });

    // JSON 정본: undefined 없이 왕복하고 store.views에 쓰인다
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    const markdown = verificationView.render(view);
    await store.views.write('verification', view, markdown);
    // read()는 본문 끝 줄바꿈 하나를 뗀다 (store/views.ts parseViewMarkdown)
    expect(await store.views.read('verification')).toEqual({ view, markdown: markdown.replace(/\n$/, '') });
  });

  it('검사 기록이 없으면 lastCheck 없음 · 승인 규칙은 ⬜ not-run · 잠정 규칙은 ⬜ 미승인 · 검사 0', async () => {
    await seedRules();

    const view = await verificationView.generate(ctxOf({ commit: undefined }));

    expect(view.header).not.toHaveProperty('commit');
    expect(view.header.sources.map((ref) => ref.kind)).toEqual(['store', 'store', 'store', 'store']);
    expect(view).not.toHaveProperty('lastCheck');
    expect(view).not.toHaveProperty('staleResult');
    expect(view).not.toHaveProperty('junitMissing');
    expect(view.summary).toMatchObject({
      unconfirmed: 1,
      rules: 2,
      approved: 1,
      byStatus: { fail: 0, unchecked: 2 },
      checks: { junit: 0, static: 0 },
      quarantined: 0,
    });
    const items = view.blocks[0]?.items ?? [];
    expect(items.find((row) => row.ruleId === REFUND_RULE.id)?.detail).toEqual(NOT_RUN_DETAIL);
    expect(items.find((row) => row.ruleId === RECORD_RULE.id)?.detail).toEqual({
      status: 'unchecked',
      reason: 'unapproved',
    });
    expect(view.common.every((row) => row.result.status === 'unchecked')).toBe(true);
    expect(view.outOfScope.blocksWithoutRules).toEqual(['auth']);
  });

  it('러너가 죽은 CheckRun(exit ≠ 0 · JUnit 없음) → staleResult, rule-status는 이전 결과', async () => {
    await seedRules();
    await store.ruleStatus.write([{ ...FAIL_RECORD, commit: PREVIOUS_COMMIT, checkedAt: '2026-10-01T08:59:00.000Z' }]);
    await store.checks.write({
      ...FAILING_RUN,
      runId: 'c-20261002T090000000Z',
      finishedAt: '2026-10-02T09:00:00.000Z',
      runner: { exitCode: 127, stderrTail: ['[plumb] 러너 없음: node_modules/.bin/vitest'] },
      results: [],
      counts: { junit: 0, static: 0 },
    });

    const view = await verificationView.generate(ctxOf());

    expect(view.staleResult).toEqual({
      exitCode: 127,
      stderrTail: ['[plumb] 러너 없음: node_modules/.bin/vitest'],
      previousCommit: PREVIOUS_COMMIT,
    });
    expect(view.junitMissing).toBe(true);
    expect(view.summary.byStatus).toMatchObject({ fail: 1, unchecked: 1 });
    expect(view.blocks[0]?.items[0]?.lastResult).toMatchObject({ commit: PREVIOUS_COMMIT });
  });

  it('규칙 0개 → 블록 없음, 규칙 0개 블록 = 설정의 모든 블록', async () => {
    const view = await verificationView.generate(ctxOf());
    expect(view.blocks).toEqual([]);
    expect(view.summary).toMatchObject({ rules: 0, approved: 0, unconfirmed: 0 });
    expect(view.outOfScope.blocksWithoutRules).toEqual(['payment', 'auth']);
  });
});

describe('verificationView.render — §6.3 화면을 Markdown으로', () => {
  it('첫 줄 요약 · 블록 표(🔴 file:line 앵커 · 반례 · ⬜ 미승인 체류) · 블록 공통 3행 · 검사 범위 밖 여섯 항목', async () => {
    await seedRules();
    await store.checks.write(FAILING_RUN);
    await store.ruleStatus.write([FAIL_RECORD]);
    const view = await verificationView.generate(ctxOf());

    const markdown = verificationView.render(view);
    const lines = markdown.split('\n');

    expect(lines[0]).toBe(
      '출처: 실행: plumb check (checks/c-20261002T085900000Z.json) · 저장소: rule-status/ · 저장소: rules.yaml · 저장소: proposals/ · 저장소: decisions/',
    );
    expect(lines[2]).toBe(
      '⚠ 미확인 항목 1건 · 최장 12일 (pay.payment-record)  |  보호 저장소 정상 · 마지막 검사 a1b2c3d · 2026-10-02 08:59 UTC',
    );
    expect(lines[3]).toBe(
      '규칙 2 · 승인 1 · 🟢 0 🟡 0 🟠 0 🔴 1 ⬜ 1 · 검사 3 (JUnit 1 · 정적 2) · 격리 0 · 검증된 통과 비율 🟢/(🟢+🟡) —',
    );
    expect(markdown).not.toContain(NO_CHECK_MESSAGE);
    expect(markdown).not.toContain('⚠ 검사 실패');

    // 블록 절
    const block = section(markdown, '## payment');
    expect(block.split('\n')[0]).toBe('## payment — 규칙 2 · 승인 1 · 🔴 1 ⬜ 1  ·  a1b2c3d · 2026-10-02 08:59 UTC');
    expect(block).toContain('| 상태 | 규칙 | 검사 종류 | 사유 / 유효성 | 위치 |');
    const failRow = block.split('\n').find((line) => line.startsWith('| 🔴 ')) ?? '';
    expect(failRow).toContain('`pay.refund-window`');
    expect(failRow).toContain('| 인수 테스트 |');
    expect(failRow).toContain('실패 · test/acceptance/refund-window.property.spec.ts:42');
    expect(failRow).toContain('AssertionError: expected 8 to be less than 8<br>fast-check 반례: [8] · 시드 42');
    expect(failRow).toContain('승인 2026-10-02 (km) · 결정 D-0001');
    expect(failRow).toContain(
      `[test/acceptance/refund-window.property.spec.ts:42](${PLUMB_OPEN_SCHEME}?file=test%2Facceptance%2Frefund-window.property.spec.ts&line=42)`,
    );
    const pendingRow = block.split('\n').find((line) => line.startsWith('| ⬜ ')) ?? '';
    expect(pendingRow).toContain('`pay.payment-record`');
    expect(pendingRow).toContain('| 검사 없음 |');
    expect(pendingRow).toContain('미승인 · ⚠ 12일 체류');
    expect(pendingRow).toContain('결정 D-0002');

    // 블록 공통 3행
    const common = section(markdown, `## ${COMMON_SECTION_HEADER}`);
    expect(common.split('\n')[0]).toBe(`## ${COMMON_SECTION_HEADER} — 🟢 2 ⬜ 1  ·  a1b2c3d · 2026-10-02 08:59 UTC`);
    expect(common).toContain('| 🟢 | (1) 블록은 다른 블록을 선언된 공개 계약으로만 접근 | 정적 분석 | — |  |');
    expect(common).toContain('| 🟢 | (2) 블록 간 의존 방향은 선언된 방향만 (순환 금지) | 정적 분석 | — |  |');
    expect(common).toContain(
      '| ⬜ | (3) 공개 계약의 시그니처 변경은 설계 변경 이벤트 | 정적 분석 | 검사 없음 (M8 — git 공개 진입점 diff) |  |',
    );

    // 검사 범위 밖 — 여섯 항목 전부
    const out = section(markdown, `## ${OUT_OF_SCOPE_HEADER}`);
    expect(out.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      '- 규칙 0개 블록: auth',
      '- 요구사항에 없는 코드: 없음 (규칙 scope 미도입 — 규칙은 블록 전체를 덮는다)',
      '- 코드에 없는 요구사항: 없음',
      '- 테스트가 안 지나간 흐름: 측정 불가 (트레이스 없음)',
      '- 미분류 파일: 측정 불가 (블록 그래프 없음)',
      '- 불안정으로 격리된 검사: 0',
    ]);
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });

  it('🟡 통과 행은 "유효성 미확인 (주입 기록 없음)" + ⚠ 체류 (M7 전의 정상)', async () => {
    await seedRules();
    await store.checks.write({
      ...FAILING_RUN,
      results: [{ ...(FAILING_RUN.results[0] as CheckRun['results'][number]), outcome: 'pass', failure: undefined }],
    });
    await store.ruleStatus.write([
      {
        ...FAIL_RECORD,
        detail: { status: 'pass-unverified', reason: 'no-injection' },
        since: '2026-09-29T09:00:00.000Z',
        history: ['pass-unverified'],
      },
    ]);

    const view = await verificationView.generate(ctxOf());
    const markdown = verificationView.render(view);

    expect(view.blocks[0]?.items.find((row) => row.ruleId === REFUND_RULE.id)).toMatchObject({
      detail: { status: 'pass-unverified', reason: 'no-injection' },
      pendingSince: '2026-09-29T09:00:00.000Z',
    });
    const row = markdown.split('\n').find((line) => line.startsWith('| 🟡 ')) ?? '';
    expect(row).toContain(`${VALIDITY_UNKNOWN} · ⚠ 3일 체류`);
    expect(row).not.toMatch(/→ 검사 (실패 ✔ 유효|통과 ✘ 무효)/);
    expect(markdown).toContain('🟢 0 🟡 1 🟠 0 🔴 0 ⬜ 1');
    expect(markdown).toContain('검증된 통과 비율 🟢/(🟢+🟡) 0/1 (0%)');
    expect(markdown).toContain(OUT_OF_SCOPE_HEADER);
  });

  it('🟢 pass-verified 행: 사유 칸에 "주입 <commit>: <설명> → 검사 실패 ✔ 유효" 줄 (#111)', async () => {
    await seedRules();
    await store.checks.write(PASSING_RUN);
    const validity: Validity = { ...INJECTION_BASE, result: 'check-failed', valid: true };
    await store.ruleStatus.write([
      {
        ...FAIL_RECORD,
        detail: { status: 'pass-verified', reason: 'passed-and-injection-valid', validity },
        since: '2026-10-01T09:00:00.000Z',
        history: ['pass-unverified', 'pass-verified'],
      },
    ]);

    const view = await verificationView.generate(ctxOf());
    const markdown = verificationView.render(view);

    const item = view.blocks[0]?.items.find((row) => row.ruleId === REFUND_RULE.id);
    expect(item).toMatchObject({ detail: { status: 'pass-verified', reason: 'passed-and-injection-valid' }, validity });
    expect(item).not.toHaveProperty('pendingSince');
    const row = markdown.split('\n').find((line) => line.startsWith('| 🟢 ')) ?? '';
    expect(row).toContain('유효 ✔ (주입으로 확인)<br>주입 b2c3d4e: 7일 경계를 8일로 바꿈 → 검사 실패 ✔ 유효');
    expect(row).not.toContain('⚠');
    expect(markdown).toContain('🟢 1 🟡 0 🟠 0 🔴 0 ⬜ 1');
    expect(markdown).toContain('검증된 통과 비율 🟢/(🟢+🟡) 1/1 (100%)');
  });

  it('🟡 injection-invalid 행: 사유 칸에 "주입 <commit>: <설명> → 검사 통과 ✘ 무효" 줄 + ⚠ 체류 (#111)', async () => {
    await seedRules();
    await store.checks.write(PASSING_RUN);
    const validity: Validity = { ...INJECTION_BASE, result: 'check-passed', valid: false };
    await store.ruleStatus.write([
      {
        ...FAIL_RECORD,
        detail: { status: 'pass-unverified', reason: 'injection-invalid', validity },
        since: '2026-10-01T09:00:00.000Z',
        history: ['pass-unverified'],
      },
    ]);

    const view = await verificationView.generate(ctxOf());
    const markdown = verificationView.render(view);

    expect(view.blocks[0]?.items.find((row) => row.ruleId === REFUND_RULE.id)).toMatchObject({
      detail: { status: 'pass-unverified', reason: 'injection-invalid' },
      validity,
      pendingSince: '2026-10-01T09:00:00.000Z',
    });
    const row = markdown.split('\n').find((line) => line.startsWith('| 🟡 ')) ?? '';
    expect(row).toContain(
      '유효성 무효 ✘ (주입이 검사를 통과) · ⚠ 1일 체류<br>주입 b2c3d4e: 7일 경계를 8일로 바꿈 → 검사 통과 ✘ 무효',
    );
    expect(row).not.toContain(VALIDITY_UNKNOWN);
    expect(markdown).toContain('🟢 0 🟡 1 🟠 0 🔴 0 ⬜ 1');
    expect(markdown).toContain('검증된 통과 비율 🟢/(🟢+🟡) 0/1 (0%)');
  });

  it('검사 기록 없음: "마지막 검사 없음" + 5절 문구 + 행마다 (기록 없음) — 검사 범위 밖은 그래도 쓴다', async () => {
    await seedRules();
    const view = await verificationView.generate(ctxOf({ commit: undefined }));
    const markdown = verificationView.render(view);

    expect(markdown.split('\n')[0]).toBe(
      '출처: 저장소: rule-status/ · 저장소: rules.yaml · 저장소: proposals/ · 저장소: decisions/',
    );
    expect(markdown).toContain(
      '⚠ 미확인 항목 1건 · 최장 12일 (pay.payment-record)  |  보호 저장소 정상 · 마지막 검사 없음',
    );
    expect(markdown).toContain(`> ${NO_CHECK_MESSAGE}`);
    expect(markdown).toContain('## payment — 규칙 2 · 승인 1 · ⬜ 2\n');
    expect(markdown).toMatch(/\| ⬜ \| .*`pay\.refund-window`.* \| 인수 테스트 \| 아직 안 돌림 \(기록 없음\)/);
    expect(markdown).toContain(`## ${COMMON_SECTION_HEADER} — ⬜ 3\n`);
    const out = section(markdown, `## ${OUT_OF_SCOPE_HEADER}`);
    expect(out).toContain('- 규칙 0개 블록: auth');
    expect(out).toContain('- 테스트가 안 지나간 흐름: 측정 불가 (트레이스 없음)');
    expect(out).toContain('- 불안정으로 격리된 검사: 검사 없음');
  });

  it('staleResult: 상단에 "⚠ 검사 실패 (exit n) — … 이전 결과(커밋)를 보인다" + 러너 꼬리 + 행마다 (이전 결과 …)', async () => {
    await seedRules();
    await store.ruleStatus.write([{ ...FAIL_RECORD, commit: PREVIOUS_COMMIT, checkedAt: '2026-10-01T08:59:00.000Z' }]);
    await store.checks.write({
      ...FAILING_RUN,
      runId: 'c-20261002T090000000Z',
      finishedAt: '2026-10-02T09:00:00.000Z',
      runner: { exitCode: 127, stderrTail: ['[plumb] 러너 없음: node_modules/.bin/vitest'] },
      results: [],
      counts: { junit: 0, static: 0 },
    });
    const view = await verificationView.generate(ctxOf());
    const markdown = verificationView.render(view);

    expect(markdown).toContain(
      '> ⚠ 검사 실패 (exit 127) — JUnit 결과 없음. rule-status는 그대로 두고 이전 결과(0f1e2d3)를 보인다',
    );
    expect(markdown).toContain('```text\n[plumb] 러너 없음: node_modules/.bin/vitest\n```');
    expect(markdown).toMatch(
      /\| 🔴 \| .*실패 · test\/acceptance\/refund-window\.property\.spec\.ts:42 \(이전 결과 0f1e2d3\)/,
    );
    expect(markdown).not.toContain('JUnit 결과 없음 — 리포터 설정 확인');
    expect(markdown).toContain(`## ${OUT_OF_SCOPE_HEADER}`);
  });

  it('규칙 0개: "규칙 없음" 안내 + 블록 공통 + 검사 범위 밖(규칙 0개 블록 = 모든 블록)', async () => {
    const view = await verificationView.generate(ctxOf({ commit: undefined }));
    const markdown = verificationView.render(view);
    expect(markdown).toContain('규칙 없음 — `plumb rule propose --file <json>` → `plumb approve <id>`로 규칙을 만든다');
    expect(markdown).toContain(`## ${COMMON_SECTION_HEADER}`);
    expect(markdown).toContain('- 규칙 0개 블록: payment, auth');
  });
});

// ---------------------------------------------------------------------------
// testbed 실제: rule propose → approve → plumb check → 생성기
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL('.', import.meta.url));
const testbedRoot = resolve(here, '../../../../../examples/testbed');
const TESTBED_TIMEOUT = 180_000;

/** testbed에 남는 산출물 — 끝나면 지운다 (전부 gitignore) */
async function cleanTestbed(): Promise<void> {
  await rm(join(testbedRoot, '.plumb-store'), { recursive: true, force: true });
  await rm(join(testbedRoot, 'reports', 'junit.xml'), { force: true });
  await rm(join(testbedRoot, 'reports', 'depcruise.json'), { force: true });
}

/**
 * 실제 어댑터. `loadAdapter()`는 `register()`가 core **dist**의 등록소에 등록하므로 src에서 돌리는 테스트에서는 못 쓴다 —
 * 어댑터 dist 모듈에서 `nextjsAdapter` · `runStaticChecks`를 직접 꺼낸다 (`pnpm --filter @plumb/adapter-nextjs build` 뒤)
 */
async function realLoader(): Promise<LoadedAdapter> {
  const entry = monorepoAdapterEntry('@plumb/adapter-nextjs');
  const mod = (await import(pathToFileURL(entry).href)) as Partial<
    Record<'nextjsAdapter' | 'runStaticChecks', unknown>
  >;
  if (
    typeof mod.runStaticChecks !== 'function' ||
    typeof mod.nextjsAdapter !== 'object' ||
    mod.nextjsAdapter === null
  ) {
    throw new Error(`${entry}에 nextjsAdapter · runStaticChecks가 없다 — pnpm --filter @plumb/adapter-nextjs build`);
  }
  return { adapter: mod.nextjsAdapter as Adapter, staticRunner: mod.runStaticChecks as LoadedAdapter['staticRunner'] };
}

async function plumbTestbed(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const program = createProgram({
    exit: (code) => exits.push(code),
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    cwd: testbedRoot,
    env: { USER: 'tester' },
    loadAdapter: realLoader,
  })
    .exitOverride()
    .configureOutput({ writeOut: (str) => out.push(str), writeErr: (str) => err.push(str) });
  await program.parseAsync(['--target', testbedRoot, ...args], { from: 'user' });
  return { code: exits.at(-1) ?? 0, stdout: out.join(''), stderr: err.join('') };
}

describe('testbed 실제: rule propose → approve → plumb check → 검증 View', () => {
  beforeAll(cleanTestbed);
  afterAll(cleanTestbed);

  it(
    'payment — 규칙 1 · 승인 1 · ⬜ 1 (검사 파일 없음) · 규칙 0개 블록: auth',
    async () => {
      const proposalFile = join(testbedRoot, 'plumb', 'proposals', 'pay.refund-window.json');
      const proposed = await plumbTestbed('rule', 'propose', '--file', proposalFile);
      expect(proposed.stderr).toBe('');
      expect(proposed.code).toBe(0);
      const approved = await plumbTestbed('approve', 'pay.refund-window', '--by', 'tester');
      expect(approved.stderr).toBe('');
      expect(approved.code).toBe(0);
      const checked = await plumbTestbed('check');
      expect(checked.stderr).toBe('');
      expect(checked.code).toBe(0);
      expect(checked.stdout).toContain('payment — 규칙 1 · 승인 1 · ⬜ 1');

      // 생성기 — 검사를 다시 돌리지 않는다 (어댑터는 부르면 실패하는 가짜)
      const loaded = await loadConfigFile(join(testbedRoot, 'plumb.config.json'));
      const testbedStore = openStore(loaded.config, testbedRoot);
      const latest = await testbedStore.checks.latest();
      expect(latest).not.toBeNull();
      const view = await verificationView.generate({
        root: testbedRoot,
        config: loaded.config,
        store: testbedStore,
        adapter: NEVER_ADAPTER,
        commit: latest?.commit,
        now: () => new Date(),
      });
      const markdown = verificationView.render(view);

      expect(view.summary).toMatchObject({
        unconfirmed: 0,
        rules: 1,
        approved: 1,
        byStatus: { fail: 0, unchecked: 1 },
        quarantined: 0,
      });
      expect(view.summary.checks.junit).toBeGreaterThan(0);
      expect(view.summary.checks.static).toBeGreaterThan(0);
      expect(view.blocks[0]?.items[0]).toMatchObject({
        ruleId: 'pay.refund-window',
        detail: { status: 'unchecked', reason: 'check-missing' },
        approvedBy: 'tester',
        decision: 'D-0001',
        checkFilesMissing: [CHECK_FILE],
      });
      expect(view.common.map((row) => row.result.status)).toEqual(['pass', 'pass', 'unchecked']);
      expect(view.outOfScope.blocksWithoutRules).toEqual(['auth']);
      expect(view.outOfScope.rulesWithoutCode).toEqual([{ ruleId: 'pay.refund-window', reason: 'check-missing' }]);

      expect(markdown).toContain('payment — 규칙 1 · 승인 1 · ⬜ 1');
      expect(markdown).toMatch(
        /\| ⬜ \| .*`pay\.refund-window`.* \| 인수 테스트 \| 검사 파일 없음<br>승인 \d{4}-\d{2}-\d{2} \(tester\) · 결정 D-0001 \| test\/acceptance\/refund-window\.property\.spec\.ts \(파일 없음\) \|/,
      );
      expect(markdown).toContain('규칙 0개 블록: auth');
      expect(markdown).toContain('코드에 없는 요구사항: pay.refund-window (검사 파일 없음)');
      expect(markdown).toContain(OUT_OF_SCOPE_HEADER);

      // PR 본문에 붙일 전문 — 경로를 주면 그곳에 쓴다 (CI에서는 쓰지 않는다)
      const outPath = process.env.PLUMB_VERIFICATION_MD;
      if (outPath !== undefined && outPath.length > 0) await writeFile(outPath, markdown);
    },
    TESTBED_TIMEOUT,
  );
});
