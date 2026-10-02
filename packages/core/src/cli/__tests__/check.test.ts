/**
 * `plumb check` (이슈 #47) — 가짜 어댑터를 `createProgram({ loadAdapter })`로 주입하고 표 · `--json` · `--strict`를 확인한다.
 * 표에는 "━━ 검사 범위 밖 ━━" 절이 **항상** 있다 (그래프를 못 얻어도 "측정 불가"로). exit: 0 / `--strict` 🔴 4 · 변조 5 · 러너 실패 6.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../adapter/errors.js';
import type { LoadedAdapter } from '../../adapter/load.js';
import type { Adapter, BlockGraph, StaticCheckRun, TestRunResult } from '../../adapter/types.js';
import { graph as graphFixture } from '../../checks/__tests__/fixtures.js';
import type { CapturedOutput, CheckResult, Proposal, Rule } from '../../types/index.js';
import {
  COMMON_SECTION_HEADER,
  countsText,
  EXIT_CHECK_FAIL,
  EXIT_CHECK_RUNNER,
  EXIT_CHECK_TAMPERED,
  matchesFilter,
  OUT_OF_SCOPE_HEADER,
} from '../commands/check.js';
import { createProgram } from '../program.js';

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

const CONFIG = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs',
  node: '22',
  roles: {
    'test-writer': { model: 'default', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'default', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'default', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'default', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  blocks: {
    payment: { include: ['src/domains/payment/**'], dependsOn: [], risk: 'high' },
    auth: { include: ['src/domains/auth/**'], dependsOn: [] },
  },
};

const ADD_PROPOSAL: Proposal = {
  id: 'p-0001',
  ruleId: REFUND_RULE.id,
  changeKind: 'add',
  proposedBy: 'cli',
  proposedAt: '2026-10-01T05:00:00.000Z',
  after: REFUND_RULE,
  requiresPriorApproval: false,
  applied: 'provisional',
};

/** testbed 첫 실행 모양: 단위 테스트 7개만 (인수 테스트 파일은 아직 없다) */
const UNIT_ONLY_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="7" failures="0" errors="0" time="0.01">
  <testsuite name="src/domains/payment/__tests__/payment.unit.test.ts" tests="7" failures="0" errors="0" skipped="0" time="0.01">
${Array.from({ length: 7 }, (_, i) => `    <testcase classname="src/domains/payment/__tests__/payment.unit.test.ts" name="case ${i + 1}" time="0.001"></testcase>`).join('\n')}
  </testsuite>
</testsuites>
`;

/** 인수 테스트가 실패하는 모양 */
const FAILING_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="1" failures="1" errors="0" time="0.01">
  <testsuite name="test/acceptance/refund-window.property.spec.ts" tests="1" failures="1" errors="0" skipped="0" time="0.01">
    <testcase classname="test/acceptance/refund-window.property.spec.ts" name="7일 초과 거절" time="0.01">
      <failure message="expected 8 to be less than 8" type="AssertionError">
AssertionError: expected 8 to be less than 8
 ❯ test/acceptance/refund-window.property.spec.ts:42:22
      </failure>
    </testcase>
  </testsuite>
</testsuites>
`;

let dir: string;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-check-cli-'));
  await writeFile(join(dir, 'plumb.config.json'), JSON.stringify(CONFIG, null, 2));
  clock = new Date('2026-10-02T09:00:00.000Z');
});

afterEach(() => rm(dir, { recursive: true, force: true }));

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

interface FakeParts {
  xml?: string | null;
  exitCode?: number;
  graph?: () => Promise<BlockGraph>;
  staticResults?: CheckResult[];
}

function staticResult(name: string, outcome: CheckResult['outcome'] = 'pass'): CheckResult {
  return { check: { kind: 'static', ref: `depcruise:${name}` }, ruleIds: [], outcome };
}

/** 가짜 어댑터 + 정적 러너. `xml: null`이면 러너가 죽은 것 (`junitPath: null`) */
function fakeLoader(parts: FakeParts = {}): () => Promise<LoadedAdapter> {
  const xml = parts.xml === undefined ? UNIT_ONLY_XML : parts.xml;
  const adapter: Adapter = {
    name: 'nextjs',
    async runTests(): Promise<TestRunResult> {
      if (xml === null) {
        return {
          junitPath: null,
          exitCode: 127,
          output: output(127, ['[plumb] 러너 없음: node_modules/.bin/vitest']),
          tool: { name: 'vitest', version: 'unknown' },
        };
      }
      const junitPath = join(dir, 'reports', 'junit.xml');
      await mkdir(join(dir, 'reports'), { recursive: true });
      await writeFile(junitPath, xml);
      const exitCode = parts.exitCode ?? 0;
      return {
        junitPath,
        exitCode,
        output: output(exitCode, ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'Tests  7 passed (7)']),
        tool: { name: 'vitest', version: '3.2.7' },
      };
    },
    extractDependencies: parts.graph ?? (async () => graphFixture({ unclassified: [] })),
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
  const staticRunner = async (): Promise<StaticCheckRun> => ({
    results: parts.staticResults ?? [
      staticResult('block-1-public-entry-only'),
      staticResult('block-1-public-entry-only-cross-domain'),
      staticResult('block-2-no-cycles'),
      staticResult('block-2-declared-direction'),
      staticResult('prisma-only-in-repo'),
      staticResult('app-thin'),
    ],
    output: output(0, []),
    graphJsonPath: join(dir, 'reports', 'depcruise.json'),
    tool: { name: 'dependency-cruiser', version: '18.5.0' },
  });
  return async () => ({ adapter, staticRunner });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function plumb(loader: () => Promise<LoadedAdapter>, ...args: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const program = createProgram({
    exit: (code) => exits.push(code),
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    cwd: dir,
    env: { USER: 'tester' },
    now,
    loadAdapter: loader,
  })
    .exitOverride()
    .configureOutput({
      writeOut: (str) => out.push(str),
      writeErr: (str) => err.push(str),
    });
  await program.parseAsync(['--target', dir, ...args], { from: 'user' });
  return { code: exits.at(-1) ?? 0, stdout: out.join(''), stderr: err.join('') };
}

async function proposeAndApprove(loader: () => Promise<LoadedAdapter>): Promise<void> {
  await mkdir(join(dir, 'plumb', 'proposals'), { recursive: true });
  const file = join(dir, 'plumb', 'proposals', 'pay.refund-window.json');
  await writeFile(file, JSON.stringify(ADD_PROPOSAL, null, 2));
  expect((await plumb(loader, 'rule', 'propose', '--file', file)).code).toBe(0);
  expect((await plumb(loader, 'approve', 'pay.refund-window', '--by', 'test')).code).toBe(0);
}

async function touchCheckFile(): Promise<void> {
  await mkdir(join(dir, 'test', 'acceptance'), { recursive: true });
  await writeFile(join(dir, 'test', 'acceptance', 'refund-window.property.spec.ts'), '// spec\n');
}

/** 절 머리글부터 다음 빈 줄까지 */
function section(stdout: string, header: string): string {
  const start = stdout.indexOf(header);
  if (start < 0) throw new Error(`"${header}" 절이 없다:\n${stdout}`);
  const end = stdout.indexOf('\n\n', start);
  return stdout.slice(start, end < 0 ? undefined : end);
}

describe('plumb check — 표 (view-verification 3.2)', () => {
  it('testbed 첫 실행 모양: payment 블록 줄 · ⬜ 검사 파일 없음 · 공통 행 3개 · 검사 범위 밖 · 러너 꼬리 5줄 · unmapped 7', async () => {
    const loader = fakeLoader();
    await proposeAndApprove(loader);

    const r = await plumb(loader, 'check');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n');

    // 상단 요약
    expect(lines[0]).toMatch(
      /^보호 저장소 정상 · 미확인 0건 · 마지막 검사 (unknown|[0-9a-f]{7}) · 2026-10-02 \d{2}:\d{2} UTC$/,
    );
    expect(lines[1]).toBe('규칙 1 · 승인 1 · 🟢 0 🟡 0 🟠 0 🔴 0 ⬜ 1 · 검사 13 (JUnit 7 · 정적 6) · 격리 0');

    // 블록 줄 + 규칙 행
    expect(r.stdout).toContain('payment — 규칙 1 · 승인 1 · ⬜ 1');
    const ruleLine = lines.find((line) => line.includes('(pay.refund-window)'));
    expect(ruleLine).toMatch(/^ {2}⬜ .*\(pay\.refund-window\)\s+인수 테스트\s+검사 파일 없음$/);

    // 블록 공통 — depcruise pass 2 + (3) 미구현 1
    const common = section(r.stdout, COMMON_SECTION_HEADER);
    expect(common.split('\n')[0]).toContain(`${COMMON_SECTION_HEADER} — 🟢 2 ⬜ 1`);
    expect(common).toMatch(/^ {2}🟢 \(1\) 블록은 다른 블록을 선언된 공개 계약으로만 접근\s+정적 분석\s+—$/m);
    expect(common).toMatch(/^ {2}🟢 \(2\) 블록 간 의존 방향은 선언된 방향만 \(순환 금지\)\s+정적 분석\s+—$/m);
    expect(common).toMatch(/^ {2}⬜ \(3\) 공개 계약의 시그니처 변경은 설계 변경 이벤트\s+정적 분석\s+검사 없음 \(M8/m);

    // 검사 범위 밖 — 여섯 항목 전부
    const out = section(r.stdout, OUT_OF_SCOPE_HEADER);
    expect(out).toMatch(/규칙 0개 블록:\s+auth$/m);
    expect(out).toMatch(/요구사항에 없는 코드:\s+없음 \(규칙 scope 미도입/m);
    expect(out).toMatch(/코드에 없는 요구사항:\s+pay\.refund-window \(검사 파일 없음\)$/m);
    expect(out).toMatch(/테스트가 안 지나간 흐름:\s+측정 불가 \(트레이스 없음\)$/m);
    expect(out).toMatch(/미분류 파일:\s+0개$/m);
    expect(out).toMatch(/불안정으로 격리된 검사:\s+0$/m);

    // 러너 꼬리 5줄 (6줄 중 마지막 5) · unmapped
    const tailStart = lines.indexOf('러너 출력 (마지막 5줄):');
    expect(tailStart).toBeGreaterThan(0);
    expect(lines.slice(tailStart + 1, tailStart + 6)).toEqual([
      '  line 2',
      '  line 3',
      '  line 4',
      '  line 5',
      '  Tests  7 passed (7)',
    ]);
    expect(r.stdout).toContain('단위 테스트 7개 — 규칙 근거 아님');
    expect(r.stdout).toMatch(/기록: \.plumb-store\/checks\/c-\d{8}T\d{9}Z\.json · rule-status\/ 1개 갱신/);

    // 파일
    const checks = await readdir(join(dir, '.plumb-store', 'checks'));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/^c-\d{8}T\d{9}Z\.json$/);
    expect(await readdir(join(dir, '.plumb-store', 'rule-status'))).toEqual(['pay.refund-window.json']);
    const record = JSON.parse(
      await readFile(join(dir, '.plumb-store', 'rule-status', 'pay.refund-window.json'), 'utf8'),
    );
    expect(record.detail).toEqual({ status: 'unchecked', reason: 'check-missing' });

    // rule list · show가 같은 기록을 읽는다
    const listed = await plumb(loader, 'rule', 'list');
    const row = listed.stdout.split('\n').find((line) => line.startsWith('pay.refund-window')) ?? '';
    expect(row).toContain('⬜ 검사 파일 없음');
    const shown = await plumb(loader, 'rule', 'show', 'pay.refund-window');
    expect(shown.stdout).toMatch(/상태: ⬜ 검사 파일 없음 · (unknown|[0-9a-f]{7}) · 2026-10-02T/);
    const shownJson = JSON.parse((await plumb(loader, 'rule', 'show', 'pay.refund-window', '--json')).stdout);
    expect(shownJson.status).toEqual({ status: 'unchecked', reason: 'check-missing' });
    expect(shownJson.statusAt.checkedAt).toMatch(/^2026-10-02T/);
  });

  it('규칙 0개여도 표는 나오고 "검사 범위 밖"은 그린다 — 규칙 0개 블록 = 모든 블록', async () => {
    const r = await plumb(fakeLoader(), 'check');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('규칙 없음');
    expect(section(r.stdout, OUT_OF_SCOPE_HEADER)).toMatch(/규칙 0개 블록:\s+payment, auth$/m);
    expect(r.stdout).toContain(COMMON_SECTION_HEADER);
  });

  it('블록 그래프를 못 얻으면 "규칙 0개 블록" · "미분류 파일"은 0이 아니라 측정 불가, 절은 그대로 있다', async () => {
    const loader = fakeLoader({
      graph: async () => {
        throw new Error('dependency-cruiser가 대상에 설치되어 있지 않다');
      },
    });
    await proposeAndApprove(loader);
    const r = await plumb(loader, 'check');
    expect(r.code).toBe(0);
    const out = section(r.stdout, OUT_OF_SCOPE_HEADER);
    expect(out).toMatch(
      /규칙 0개 블록:\s+측정 불가 \(블록 그래프 없음 — dependency-cruiser가 대상에 설치되어 있지 않다\)$/m,
    );
    expect(out).toMatch(/미분류 파일:\s+측정 불가 \(블록 그래프 없음\)$/m);
    expect(out).toMatch(/코드에 없는 요구사항:\s+pay\.refund-window \(검사 파일 없음\)$/m);
  });

  it('--filter는 표시만 거른다 — 맞는 규칙이 없어도 상단 요약 · 범위 밖은 전체 값, 기록은 전부', async () => {
    const loader = fakeLoader();
    await proposeAndApprove(loader);
    const r = await plumb(loader, 'check', '--filter', 'auth.*');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('필터 "auth.*"에 맞는 규칙 없음 (규칙 1)');
    expect(r.stdout).toContain('규칙 1 · 승인 1 ·');
    expect(r.stdout).toContain(OUT_OF_SCOPE_HEADER);
    expect(await readdir(join(dir, '.plumb-store', 'rule-status'))).toEqual(['pay.refund-window.json']);

    const byBlock = await plumb(loader, 'check', '--filter', 'payment');
    expect(byBlock.stdout).toContain('payment — 규칙 1 · 승인 1 · ⬜ 1');

    expect(matchesFilter(REFUND_RULE, 'pay.*')).toBe(true);
    expect(matchesFilter(REFUND_RULE, 'refund')).toBe(true);
    expect(matchesFilter(REFUND_RULE, 'auth')).toBe(false);
    expect(matchesFilter(REFUND_RULE, undefined)).toBe(true);
    expect(countsText({ 'pass-verified': 0, 'pass-unverified': 2, recheck: 0, fail: 1, unchecked: 0 })).toBe(
      '🟡 2 🔴 1',
    );
  });
});

describe('plumb check --json', () => {
  it('run · summary · blocks[].items[].detail · common · outOfScope · unmapped · exitCode', async () => {
    const loader = fakeLoader();
    await proposeAndApprove(loader);
    const r = await plumb(loader, 'check', '--json');
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.run.runId).toMatch(/^c-\d{8}T\d{9}Z$/);
    expect(json.run.counts).toEqual({ junit: 7, static: 6 });
    expect(json.run.storeStatus).toBe('ok');
    expect(json.store.status).toBe('ok');
    expect(json.summary).toEqual({
      rules: 1,
      approved: 1,
      byStatus: { 'pass-verified': 0, 'pass-unverified': 0, recheck: 0, fail: 0, unchecked: 1 },
      checks: { junit: 7, static: 6 },
      quarantined: 0,
    });
    expect(json.blocks).toHaveLength(1);
    expect(json.blocks[0]).toMatchObject({ id: 'payment', rules: 1, approved: 1 });
    expect(json.blocks[0].items[0]).toMatchObject({
      ruleId: 'pay.refund-window',
      block: 'payment',
      detail: { status: 'unchecked', reason: 'check-missing' },
      history: ['unchecked'],
    });
    expect(
      json.common.map((row: { index: number; result: { status: string } }) => [row.index, row.result.status]),
    ).toEqual([
      [1, 'pass'],
      [2, 'pass'],
      [3, 'unchecked'],
    ]);
    expect(json.outOfScope).toEqual({
      blocksWithoutRules: ['auth'],
      codeWithoutRules: [],
      rulesWithoutCode: [{ ruleId: 'pay.refund-window', reason: 'check-missing' }],
      untestedFlows: { unavailable: 'no-trace' },
      unclassifiedFiles: 0,
      quarantined: [],
    });
    expect(json.graphUnavailable).toBeNull();
    expect(json.unmapped.count).toBe(7);
    expect(json.unmapped.cases[0].file).toBe('src/domains/payment/__tests__/payment.unit.test.ts');
    expect(json).toMatchObject({ junitMissing: false, runnerFailed: false, stale: null, exitCode: 0 });
  });
});

describe('plumb check --strict', () => {
  it('🔴 있음 → exit 4 (--strict 없으면 0). 규칙 행에 file:line과 메시지', async () => {
    const loader = fakeLoader({ xml: FAILING_XML, exitCode: 1 });
    await proposeAndApprove(loader);
    await touchCheckFile();

    const plain = await plumb(loader, 'check');
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('payment — 규칙 1 · 승인 1 · 🔴 1');
    expect(plain.stdout).toMatch(
      /🔴 .*\(pay\.refund-window\)\s+인수 테스트\s+실패 · test\/acceptance\/refund-window\.property\.spec\.ts:42/,
    );
    expect(plain.stdout).toContain('test/acceptance/refund-window.property.spec.ts:42  expected 8 to be less than 8');

    const strict = await plumb(loader, 'check', '--strict');
    expect(strict.code).toBe(EXIT_CHECK_FAIL);
    expect(EXIT_CHECK_FAIL).toBe(4);

    const json = JSON.parse((await plumb(loader, 'check', '--strict', '--json')).stdout);
    expect(json.exitCode).toBe(4);
    expect(json.blocks[0].items[0].detail.status).toBe('fail');

    // rule list에도 🔴와 위치
    const listed = await plumb(loader, 'rule', 'list');
    expect(listed.stdout.split('\n').find((line) => line.startsWith('pay.refund-window'))).toContain('🔴 실패 · test/');
    const shown = await plumb(loader, 'rule', 'show', 'pay.refund-window');
    expect(shown.stdout).toContain(
      '실패: test/acceptance/refund-window.property.spec.ts:42  expected 8 to be less than 8',
    );
    expect(shown.stdout).toMatch(/acceptance test\/acceptance\/refund-window\.property\.spec\.ts · fail · /);
  });

  it('러너 실패(junitPath null) → exit 6, 이전 rule-status 보존 + "이전 결과" 표시', async () => {
    const ok = fakeLoader({ xml: FAILING_XML, exitCode: 1 });
    await proposeAndApprove(ok);
    await touchCheckFile();
    expect((await plumb(ok, 'check')).code).toBe(0);
    const before = await readFile(join(dir, '.plumb-store', 'rule-status', 'pay.refund-window.json'), 'utf8');

    const dead = fakeLoader({ xml: null });
    const r = await plumb(dead, 'check', '--strict');
    expect(r.code).toBe(EXIT_CHECK_RUNNER);
    expect(EXIT_CHECK_RUNNER).toBe(6);
    expect(r.stdout).toContain('⚠ 검사 실패 (exit 127) — JUnit 결과 없음');
    expect(r.stdout).toMatch(/🔴 .*\(pay\.refund-window\).*\(이전 결과 (unknown|[0-9a-f]{7})\)/);
    expect(r.stdout).toContain('[plumb] 러너 없음: node_modules/.bin/vitest');
    expect(r.stdout).toContain('JUnit 결과 없음 — 리포터 설정 확인');
    expect(r.stdout).toContain(OUT_OF_SCOPE_HEADER);
    expect(r.stdout).toMatch(/\(rule-status\/는 보존\)/);
    expect(await readFile(join(dir, '.plumb-store', 'rule-status', 'pay.refund-window.json'), 'utf8')).toBe(before);
    expect(await readdir(join(dir, '.plumb-store', 'checks'))).toHaveLength(2);

    expect((await plumb(dead, 'check')).code).toBe(0);
  });

  it('변조 증거 → exit 5 (🔴 · 러너 실패보다 먼저)', async () => {
    const loader = fakeLoader({ xml: null });
    await proposeAndApprove(loader);
    const rulesPath = join(dir, '.plumb-store', 'rules.yaml');
    await writeFile(rulesPath, (await readFile(rulesPath, 'utf8')).replace('7일', '30일'));

    const r = await plumb(loader, 'check', '--strict');
    expect(r.code).toBe(EXIT_CHECK_TAMPERED);
    expect(EXIT_CHECK_TAMPERED).toBe(5);
    expect(r.stdout.split('\n')[0]).toContain('⚠ 변조 증거');
    const json = JSON.parse((await plumb(loader, 'check', '--json')).stdout);
    expect(json.run.storeStatus).toBe('tampered');
    expect(json.exitCode).toBe(0);
  });

  it('어댑터를 로드할 수 없으면 exit 1과 메시지', async () => {
    const r = await plumb(async () => {
      throw new Error('어댑터 "nextjs"(@plumb/adapter-nextjs)을(를) 로드할 수 없다 — 먼저 빌드');
    }, 'check');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('로드할 수 없다');
  });
});
