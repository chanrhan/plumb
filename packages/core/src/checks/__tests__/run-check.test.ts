/**
 * `runCheck()` (이슈 #47) — 어댑터를 가짜로 바꿔 JUnit 픽스처 · 정적 결과 · 블록 그래프를 주입한다.
 * 정상 경로: `checks/c-*.json` · `rule-status/*.json`이 생기고 `status().lastCheck`가 채워진다.
 * 러너 실패(`junitPath: null`): 이전 rule-status가 보존되고 `runner.exitCode` · `stderrTail`만 기록된다.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../adapter/errors.js';
import type { Adapter, BlockGraph, StaticCheckRun, TestRunResult } from '../../adapter/types.js';
import { openStore, type Store } from '../../store/index.js';
import type { CapturedOutput, CheckResult, PlumbConfig, Proposal, Rule } from '../../types/index.js';
import {
  checkRunIdAt,
  describeStatusDetail,
  type RunCheckDeps,
  type RunCheckResult,
  ruleSummary,
  runCheck,
  shortCommit,
} from '../run-check.js';
import { graph as graphFixture } from './fixtures.js';

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

const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
  decision: 'D-0001',
};

const RECORD_RULE: Rule = {
  id: 'pay.payment-record',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 결제가 성공하면 THE SYSTEM SHALL Payment 레코드를 남긴다',
  source: 'plan:PAY-01',
  risk: 'normal',
  depends_on: [],
  checks: [{ kind: 'pbt', ref: 'test/acceptance/payment-record.spec.ts' }],
};

const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

/** 인수 테스트 두 파일(실패 1 · 통과 1) + 단위 테스트 한 파일(testcase 2) — 단위 테스트는 unmapped */
const JUNIT_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="1" errors="0" time="0.05">
  <testsuite name="test/acceptance/refund-window.property.spec.ts" tests="1" failures="1" errors="0" skipped="0" time="0.02">
    <testcase classname="test/acceptance/refund-window.property.spec.ts" name="환불 기한 &gt; 7일을 초과한 환불 요청은 거절된다" time="0.02">
      <failure message="Property failed after 1 test(s)
Seed: 42
Counterexample: [8]
Got error: AssertionError: expected 8 to be less than 8" type="Error">
Error: Property failed after 1 test(s)
Seed: 42
Counterexample: [8]
 ❯ test/acceptance/refund-window.property.spec.ts:42:22
      </failure>
    </testcase>
  </testsuite>
  <testsuite name="test/acceptance/payment-record.spec.ts" tests="1" failures="0" errors="0" skipped="0" time="0.01">
    <testcase classname="test/acceptance/payment-record.spec.ts" name="결제 기록 &gt; Payment 레코드가 남는다" time="0.01"></testcase>
  </testsuite>
  <testsuite name="src/domains/payment/__tests__/payment.unit.test.ts" tests="2" failures="0" errors="0" skipped="0" time="0.02">
    <testcase classname="src/domains/payment/__tests__/payment.unit.test.ts" name="createPayment &gt; PAID" time="0.01"></testcase>
    <testcase classname="src/domains/payment/__tests__/payment.unit.test.ts" name="refund &gt; 8일" time="0.01"></testcase>
  </testsuite>
</testsuites>
`;

const PASSING_JUNIT_XML = JUNIT_XML.replace(/<failure[\s\S]*?<\/failure>/, '').replace('failures="1"', 'failures="0"');

let dir: string;
let store: Store;
let clock: Date;

function now(): Date {
  clock = new Date(clock.getTime() + 1000);
  return clock;
}

function output(exitCode: number, tail: string[]): CapturedOutput {
  return {
    command: 'node_modules/.bin/vitest run --reporter=junit',
    startedAt: '2026-10-02T09:00:00.000Z',
    finishedAt: '2026-10-02T09:00:01.000Z',
    exitCode,
    tail,
    logPath: join(dir, '.work', 'logs', 'vitest.log'),
  };
}

async function junitRun(xml: string, exitCode: number): Promise<TestRunResult> {
  const junitPath = join(dir, 'reports', 'junit.xml');
  await mkdir(join(dir, 'reports'), { recursive: true });
  await writeFile(junitPath, xml);
  return {
    junitPath,
    exitCode,
    output: output(exitCode, ['Tests  3 passed | 1 failed']),
    tool: { name: 'vitest', version: '3.2.7' },
  };
}

function deadRun(): TestRunResult {
  return {
    junitPath: null,
    exitCode: 127,
    output: output(127, ['[plumb] 러너 없음: node_modules/.bin/vitest']),
    tool: { name: 'vitest', version: 'unknown' },
  };
}

function staticResult(name: string, outcome: CheckResult['outcome'] = 'pass'): CheckResult {
  return { check: { kind: 'static', ref: `depcruise:${name}` }, ruleIds: [], outcome };
}

function staticRun(results: CheckResult[] = []): StaticCheckRun {
  return {
    results:
      results.length > 0
        ? results
        : [
            staticResult('block-1-public-entry-only'),
            staticResult('block-2-no-cycles'),
            staticResult('prisma-only-in-repo'),
          ],
    output: output(0, ['depcruise done']),
    graphJsonPath: join(dir, 'reports', 'depcruise.json'),
    tool: { name: 'dependency-cruiser', version: '18.5.0' },
  };
}

function fakeAdapter(parts: {
  runTests: () => Promise<TestRunResult>;
  extractDependencies?: () => Promise<BlockGraph>;
}): Adapter {
  return {
    name: 'nextjs',
    runTests: parts.runTests,
    extractDependencies: parts.extractDependencies ?? (async () => graphFixture()),
    async generateStubs() {
      throw new NotImplementedError('generateStubs', 'M4');
    },
    async readSchemas() {
      throw new NotImplementedError('readSchemas', 'M8');
    },
    async collectTraces() {
      throw new NotImplementedError('collectTraces', 'M8');
    },
  };
}

function deps(adapter: Adapter, overrides: Partial<RunCheckDeps> = {}): RunCheckDeps {
  return {
    config: CONFIG,
    root: dir,
    store,
    adapter,
    staticRunner: async () => staticRun(),
    now,
    resolveCommit: async () => COMMIT,
    ...overrides,
  };
}

async function approveRules(rules: Rule[]): Promise<void> {
  for (const [index, rule] of rules.entries()) {
    const proposal: Proposal = {
      id: `p-000${index + 1}`,
      ruleId: rule.id,
      changeKind: 'add',
      proposedBy: 'cli',
      proposedAt: '2026-10-01T00:00:00.000Z',
      after: rule,
      requiresPriorApproval: false,
      applied: 'provisional',
    };
    await store.proposals.write(proposal);
    await store.approvals.approve({ ruleId: rule.id, proposalId: proposal.id, by: 'test' });
  }
}

async function touchCheckFiles(rules: Rule[]): Promise<void> {
  for (const rule of rules) {
    for (const check of rule.checks) {
      if (check.kind === 'static') continue;
      await mkdir(join(dir, check.ref, '..'), { recursive: true });
      await writeFile(join(dir, check.ref), '// acceptance test\n');
    }
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-run-check-'));
  clock = new Date('2026-10-02T09:00:00.000Z');
  store = openStore(CONFIG, dir, { now });
  await store.init();
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe('runCheck — 정상 경로', () => {
  it('JUnit + 정적 + 그래프 → checks/c-*.json · rule-status/*.json이 생기고 status().lastCheck가 채워진다', async () => {
    await approveRules([REFUND_RULE, RECORD_RULE]);
    await touchCheckFiles([REFUND_RULE, RECORD_RULE]);
    const adapter = fakeAdapter({ runTests: () => junitRun(JUNIT_XML, 1) });

    const result = await runCheck(deps(adapter));

    // 기록 파일
    expect(await readdir(store.paths.checksDir)).toEqual([`${result.run.runId}.json`]);
    expect((await readdir(store.paths.ruleStatusDir)).sort()).toEqual([
      'pay.payment-record.json',
      'pay.refund-window.json',
    ]);
    expect(JSON.parse(await readFile(store.paths.check(result.run.runId), 'utf8'))).toEqual(result.run);

    // CheckRun
    expect(result.run.runId).toBe(checkRunIdAt(new Date(result.run.finishedAt)));
    expect(result.run.runId).toMatch(/^c-\d{8}T\d{9}Z$/);
    expect(result.run.commit).toBe(COMMIT);
    expect(result.run.runner.exitCode).toBe(1);
    expect(result.run.runner.stderrTail).toContain('Tests  3 passed | 1 failed');
    expect(result.run.counts).toEqual({ junit: 4, static: 3 });
    expect(result.run.quarantined).toEqual([]);
    expect(result.run.storeStatus).toBe('ok');
    expect(result.run.results).toHaveLength(2 + 3);
    expect(result.run.startedAt < result.run.finishedAt).toBe(true);

    // 상태 — 🔴는 실패 testcase에서만, 통과는 🟡 (M7 전)
    const refund = await store.ruleStatus.get(REFUND_RULE.id);
    expect(refund?.detail).toEqual({
      status: 'fail',
      failures: [
        {
          check: REFUND_RULE.checks[0],
          anchor: { file: 'test/acceptance/refund-window.property.spec.ts', line: 42 },
          message: expect.stringContaining('Property failed after 1 test(s)'),
          counterexample: '[8]',
          seed: '42',
        },
      ],
    });
    expect(refund).toMatchObject({ commit: COMMIT, checkedAt: result.run.finishedAt, history: ['fail'] });
    expect((await store.ruleStatus.get(RECORD_RULE.id))?.detail).toEqual({
      status: 'pass-unverified',
      reason: 'no-injection',
    });
    expect(result.statuses.map((record) => record.ruleId)).toEqual([REFUND_RULE.id, RECORD_RULE.id]); // rules.yaml 순서
    expect(result.stale).toBeNull();
    expect(result.junitMissing).toBe(false);
    expect(result.runnerFailed).toBe(false);

    // unmapped = 단위 테스트 2개 (규칙 근거 아님)
    expect(result.unmapped.map((testcase) => testcase.file)).toEqual([
      'src/domains/payment/__tests__/payment.unit.test.ts',
      'src/domains/payment/__tests__/payment.unit.test.ts',
    ]);

    // 범위 밖 · 공통 행
    expect(result.graphUnavailable).toBeNull();
    expect(result.outOfScope.blocksWithoutRules).toEqual(['auth']);
    expect(result.outOfScope.unclassifiedFiles).toBe(2);
    expect(result.outOfScope.rulesWithoutCode).toEqual([]);
    expect(result.outOfScope.untestedFlows).toEqual({ unavailable: 'no-trace' });
    expect(result.common.map((row) => [row.index, row.result.status])).toEqual([
      [1, 'pass'],
      [2, 'pass'],
      [3, 'unchecked'],
    ]);

    // 저장소 상단 바
    const status = await store.status();
    expect(status.lastCheck).toEqual({
      runId: result.run.runId,
      commit: COMMIT,
      finishedAt: result.run.finishedAt,
    });
  });

  it('검사 파일이 레포에 없으면 ⬜ check-missing, 범위 밖 "코드에 없는 요구사항"에 오른다 (testbed 첫 실행 모양)', async () => {
    await approveRules([REFUND_RULE]);
    const result = await runCheck(deps(fakeAdapter({ runTests: () => junitRun(PASSING_JUNIT_XML, 0) })));

    expect((await store.ruleStatus.get(REFUND_RULE.id))?.detail).toEqual({
      status: 'unchecked',
      reason: 'check-missing',
    });
    expect(result.outOfScope.rulesWithoutCode).toEqual([{ ruleId: REFUND_RULE.id, reason: 'check-missing' }]);
    expect(result.outOfScope.blocksWithoutRules).toEqual(['auth']);
  });

  it('두 번째 실행은 since를 유지하고 history를 쌓는다. 러너 exit 0이어도 변조 저장소는 storeStatus에 적힌다', async () => {
    await approveRules([REFUND_RULE]);
    await touchCheckFiles([REFUND_RULE]);
    const adapter = fakeAdapter({ runTests: () => junitRun(JUNIT_XML, 1) });
    const first = await runCheck(deps(adapter));
    const second = await runCheck(deps(adapter));

    const record = await store.ruleStatus.get(REFUND_RULE.id);
    expect(record?.since).toBe(first.statuses[0]?.since);
    expect(record?.history).toEqual(['fail', 'fail']);
    expect(record?.checkedAt).toBe(second.run.finishedAt);
    expect((await store.checks.list()).map((run) => run.runId)).toEqual([first.run.runId, second.run.runId]);

    await writeFile(store.paths.rules, (await readFile(store.paths.rules, 'utf8')).replace('7일', '30일'));
    const third = await runCheck(deps(adapter));
    expect(third.storeStatus.status).toBe('tampered');
    expect(third.run.storeStatus).toBe('tampered');
  });
});

describe('runCheck — 러너 실패 · 부분 실패', () => {
  it('junitPath: null → 이전 rule-status 보존, CheckRun에 runner.exitCode · stderrTail만, stale에 이전 커밋', async () => {
    await approveRules([REFUND_RULE, RECORD_RULE]);
    await touchCheckFiles([REFUND_RULE, RECORD_RULE]);
    const ok = await runCheck(deps(fakeAdapter({ runTests: () => junitRun(JUNIT_XML, 1) })));
    const before = await Promise.all(
      [REFUND_RULE, RECORD_RULE].map((rule) => readFile(store.paths.ruleStatus(rule.id), 'utf8')),
    );

    const dead = await runCheck(
      deps(fakeAdapter({ runTests: async () => deadRun() }), { resolveCommit: async () => 'b'.repeat(40) }),
    );

    // 이전 결과는 그대로
    const after = await Promise.all(
      [REFUND_RULE, RECORD_RULE].map((rule) => readFile(store.paths.ruleStatus(rule.id), 'utf8')),
    );
    expect(after).toEqual(before);
    expect(dead.statuses).toEqual(ok.statuses);
    expect(dead.stale).toEqual({
      exitCode: 127,
      stderrTail: expect.arrayContaining(['[plumb] 러너 없음: node_modules/.bin/vitest']),
      previousCommit: COMMIT,
    });
    expect(dead.junitMissing).toBe(true);
    expect(dead.runnerFailed).toBe(true);
    expect(dead.unmapped).toEqual([]);

    // 실패도 기록이다 — checks/에는 쌓인다
    expect(dead.run.runner.exitCode).toBe(127);
    expect(dead.run.runner.stderrTail?.some((line) => line.includes('JUnit 결과 없음'))).toBe(true);
    expect(dead.run.counts).toEqual({ junit: 0, static: 3 });
    expect(dead.run.results.every((result) => result.check.kind === 'static')).toBe(true);
    expect((await store.checks.list()).map((run) => run.runId)).toEqual([ok.run.runId, dead.run.runId]);
    expect((await store.status()).lastCheck?.runId).toBe(dead.run.runId);
  });

  it('어댑터가 던져도(runTests · extractDependencies) 기록은 남고 범위 밖 두 항목은 측정 불가', async () => {
    await approveRules([REFUND_RULE]);
    const adapter = fakeAdapter({
      runTests: async () => {
        throw new Error('vitest spawn ENOENT');
      },
      extractDependencies: async () => {
        throw new Error('dependency-cruiser가 대상에 설치되어 있지 않다');
      },
    });
    const result = await runCheck(
      deps(adapter, {
        staticRunner: async () => {
          throw new Error('depcruise 없음');
        },
      }),
    );

    expect(result.testRun).toBeNull();
    expect(result.staticRun).toBeNull();
    expect(result.graph).toBeNull();
    expect(result.runnerFailed).toBe(true);
    expect(result.run.runner.exitCode).toBe(-1);
    expect(result.run.runner.stderrTail).toEqual([
      '[plumb] 테스트 러너 실행 실패: vitest spawn ENOENT',
      '[plumb] 정적 검사 실행 실패: depcruise 없음',
      '[plumb] 블록 그래프 없음 — "규칙 0개 블록" · "미분류 파일"은 측정 불가: dependency-cruiser가 대상에 설치되어 있지 않다',
    ]);
    expect(result.graphUnavailable).toEqual({ reason: 'dependency-cruiser가 대상에 설치되어 있지 않다' });
    // 블록 그래프 없음 → 파서에서 나오는 두 값은 측정 불가 (0이 아니다, #63)
    expect(result.outOfScope).toMatchObject({
      blocksWithoutRules: { unavailable: 'no-graph' },
      unclassifiedFiles: { unavailable: 'no-graph' },
      quarantined: [],
    });
    expect(result.common.every((row) => row.result.status === 'unchecked')).toBe(true);
    expect(result.statuses).toEqual([]); // 이전 기록 없음
    expect(await readdir(store.paths.ruleStatusDir)).toEqual([]);
    expect(await readdir(store.paths.checksDir)).toEqual([`${result.run.runId}.json`]);
  });

  it('깨진 JUnit XML → junitMissing, rule-status는 쓰지 않는다', async () => {
    await approveRules([REFUND_RULE]);
    const result = await runCheck(deps(fakeAdapter({ runTests: () => junitRun('<testsuites><testsuite>', 0) })));
    expect(result.junitMissing).toBe(true);
    expect(result.junitReport).toBeNull();
    expect(result.run.runner.stderrTail?.some((line) => line.includes('JUnit 결과를 읽을 수 없다'))).toBe(true);
    expect(await readdir(store.paths.ruleStatusDir)).toEqual([]);
  });

  it('staticRunner가 없으면 정적 결과 없이 진행한다 (공통 행 전부 unchecked)', async () => {
    await approveRules([REFUND_RULE]);
    const result = await runCheck(
      deps(fakeAdapter({ runTests: () => junitRun(PASSING_JUNIT_XML, 0) }), { staticRunner: undefined }),
    );
    expect(result.run.counts).toEqual({ junit: 4, static: 0 });
    expect(result.common.every((row) => row.result.status === 'unchecked')).toBe(true);
  });

  it('git이 없는 폴더에서 기본 resolveCommit은 unknown', async () => {
    await approveRules([REFUND_RULE]);
    const result = await runCheck(
      deps(fakeAdapter({ runTests: () => junitRun(PASSING_JUNIT_XML, 0) }), { resolveCommit: undefined }),
    );
    expect(result.run.commit).toMatch(/^(unknown|[0-9a-f]{40})$/);
  });
});

describe('표시 문구', () => {
  it('describeStatusDetail — view-verification 3.3 비고 · 와이어프레임 문구', () => {
    expect(
      describeStatusDetail({
        status: 'fail',
        failures: [
          {
            check: REFUND_RULE.checks[0] ?? { kind: 'acceptance', ref: 'x' },
            anchor: { file: 't.spec.ts', line: 42 },
            message: 'm',
          },
        ],
      }),
    ).toBe('실패 · t.spec.ts:42');
    expect(describeStatusDetail({ status: 'pass-unverified', reason: 'no-injection' })).toBe(
      '유효성 미확인 (주입 기록 없음)',
    );
    expect(describeStatusDetail({ status: 'pass-verified', reason: 'static-proof' })).toBe('유효 ✔ (정적 증명)');
    expect(describeStatusDetail({ status: 'recheck', reason: 'check-file-changed' })).toBe(
      '검사 파일 바뀜 → 유효성 무효 · 재주입 대기',
    );
    expect(describeStatusDetail({ status: 'unchecked', reason: 'check-missing' })).toBe('검사 파일 없음');
    expect(describeStatusDetail({ status: 'unchecked', reason: 'not-run' })).toBe('아직 안 돌림');
  });

  it('ruleSummary는 summary, 없으면 statement 앞 30자. shortCommit은 7자리', () => {
    expect(ruleSummary({ statement: 'short', summary: '요약' })).toBe('요약');
    expect(ruleSummary({ statement: 'short' })).toBe('short');
    expect(ruleSummary(REFUND_RULE)).toBe(`${[...REFUND_RULE.statement].slice(0, 30).join('')}…`);
    expect(shortCommit(COMMIT)).toBe('a1b2c3d');
    expect(shortCommit('unknown')).toBe('unknown');
    expect(checkRunIdAt(new Date('2026-10-02T09:00:01.000Z'))).toBe('c-20261002T090001000Z');
  });
});

/** 타입만 확인 — 결과 모양이 CLI · UI가 기대하는 필드를 가진다 */
function _shape(result: RunCheckResult): string[] {
  const blocks = result.outOfScope.blocksWithoutRules;
  return [
    result.run.runId,
    ...result.statuses.map((record) => record.ruleId),
    ...('unavailable' in blocks ? [] : blocks),
  ];
}
void _shape;
