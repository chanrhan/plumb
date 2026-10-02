/**
 * #44 — `runTests()`·`runStaticChecks()`를 `examples/testbed`에 **실제로** 돌린다 (모노레포 안이라 가능).
 * 모킹하지 않는다: 결과는 러너가 만든 JUnit XML · depcruise JSON · 가로챈 출력에서만 확인한다 (기획안 §8.3).
 * testbed의 단위 테스트는 repo를 모킹하므로 DB 없이 돈다 (`src/domains/payment/__tests__/payment.unit.test.ts`).
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AdapterContext, type CheckResult, loadConfigFile } from '@plumb/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { EXIT_RUNNER_MISSING, TAIL_LINES } from '../capture.js';
import { nextjsAdapter } from '../index.js';
import { runTests } from '../run-tests.js';
import { type DepcruiseJson, runStaticChecks, toStaticCheckResults } from '../static-checks.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const packageDir = resolve(here, '../..');
const testbedRoot = resolve(here, '../../../../examples/testbed');

/** testbed `.dependency-cruiser.cjs`의 블록 규칙 (#21 다섯 규칙). 그 밖에 `app-thin`이 하나 더 있다 */
const BLOCK_RULES = [
  'block-1-public-entry-only',
  'block-1-public-entry-only-cross-domain',
  'block-2-no-cycles',
  'block-2-declared-direction',
  'prisma-only-in-repo',
];

let ctx: AdapterContext;

beforeAll(async () => {
  const loaded = await loadConfigFile(join(testbedRoot, 'plumb.config.json'));
  ctx = { root: testbedRoot, config: loaded.config };
});

/** 러너가 없는 빈 루트. 이 패키지의 .work/ 아래 (gitignore) — 어댑터는 root 밖을 쓰지 않으므로 로그도 그 안에 생긴다 */
async function emptyTargetRoot(): Promise<string> {
  const workDir = join(packageDir, '.work');
  await mkdir(workDir, { recursive: true });
  return mkdtemp(join(workDir, 'no-runner-'));
}

const RUNNER_TIMEOUT = 120_000;

describe('runTests(): testbed에서 Vitest를 JUnit 리포터로 실행', () => {
  it(
    '단위 테스트 7개가 JUnit XML에 잡히고 exit 0, 출력 꼬리와 전체 로그가 남는다',
    async () => {
      const result = await runTests(ctx, {});

      expect(result.exitCode).toBe(0);
      expect(result.output.exitCode).toBe(0);
      expect(result.junitPath).toBe(join(testbedRoot, 'reports', 'junit.xml'));

      const xml = await readFile(result.junitPath as string, 'utf8');
      const testcases = xml.match(/<testcase\b/g) ?? [];
      expect(testcases).toHaveLength(7);
      expect(xml).toMatch(/<testsuites[^>]*\btests="7"[^>]*\bfailures="0"/);

      // 명령: 대상 레포의 바이너리를 직접. pnpm·npx가 아니다
      expect(result.output.command).toMatch(
        /^node_modules\/\.bin\/vitest run --reporter=default --reporter=junit --outputFile=/,
      );
      expect(result.output.command).not.toMatch(/\b(pnpm|npx)\b/);

      // 꼬리: 20줄 이하, Vitest 요약이 들어 있다
      expect(result.output.tail.length).toBeGreaterThan(0);
      expect(result.output.tail.length).toBeLessThanOrEqual(TAIL_LINES);
      expect(result.output.tail.join('\n')).toMatch(/Tests\s+7 passed/);

      // 전체 로그: <work>/logs/<시각>-vitest.log, 꼬리의 모든 줄을 담고 있다
      expect(result.output.logPath).toMatch(/\.work\/logs\/\d{4}-\d{2}-\d{2}T[\d-]+Z-vitest\.log$/);
      expect(result.output.logPath.startsWith(join(testbedRoot, '.work', 'logs'))).toBe(true);
      const log = await readFile(result.output.logPath, 'utf8');
      expect(log.startsWith(`$ ${result.output.command}\n`)).toBe(true);
      for (const line of result.output.tail) expect(log).toContain(line);
      expect(log).toContain('# exit: 0');

      expect(Date.parse(result.output.startedAt)).toBeLessThanOrEqual(Date.parse(result.output.finishedAt));

      // 도구 정보는 대상 레포의 package.json에서
      const vitestPkg = JSON.parse(await readFile(join(testbedRoot, 'node_modules/vitest/package.json'), 'utf8'));
      expect(result.tool).toEqual({ name: 'vitest', version: vitestPkg.version });
    },
    RUNNER_TIMEOUT,
  );

  it(
    'scope로 테스트 파일을 좁힌다 — 안 맞는 패턴이면 testcase 0개',
    async () => {
      const result = await runTests(ctx, { scope: ['__no_such_test_file__'] });

      // testbed vitest.config: passWithNoTests → exit 0, XML은 생긴다
      expect(result.exitCode).toBe(0);
      expect(result.output.command).toMatch(/ __no_such_test_file__$/);
      expect(result.junitPath).not.toBeNull();
      const xml = await readFile(result.junitPath as string, 'utf8');
      expect(xml.match(/<testcase\b/g) ?? []).toHaveLength(0);
    },
    RUNNER_TIMEOUT,
  );

  it('nextjsAdapter.runTests가 이 구현이다', () => {
    expect(nextjsAdapter.runTests).toBe(runTests);
  });

  it('러너가 없는 루트: npx로 폴백하지 않고 junitPath null · exit 127 · "러너 없음" 꼬리 · 로그 파일', async () => {
    const emptyRoot = await emptyTargetRoot();
    try {
      const result = await runTests({ root: emptyRoot, config: ctx.config }, {});

      expect(result.junitPath).toBeNull();
      expect(result.exitCode).toBe(EXIT_RUNNER_MISSING);
      expect(result.output.tail.join('\n')).toContain('러너 없음');
      expect(result.output.tail.join('\n')).toContain('node_modules/.bin/vitest');
      expect(result.tool).toEqual({ name: 'vitest', version: 'unknown' });
      expect(result.output.logPath.startsWith(join(emptyRoot, '.work', 'logs'))).toBe(true);
      await expect(stat(result.output.logPath)).resolves.toBeTruthy();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('runStaticChecks(): testbed에서 depcruise를 돌려 규칙별 CheckResult', () => {
  it(
    '위반 0건 — 규칙마다 pass 결과 하나씩, JSON 경로를 돌려준다',
    async () => {
      const run = await runStaticChecks(ctx);

      expect(run.output.exitCode).toBe(0);
      expect(run.output.command).toMatch(
        /^node_modules\/\.bin\/depcruise src --config \.dependency-cruiser\.cjs --output-type json --output-to /,
      );
      expect(run.graphJsonPath).toBe(join(testbedRoot, 'reports', 'depcruise.json'));
      expect(run.tool.name).toBe('depcruise');
      expect(run.tool.version).toMatch(/^\d+\.\d+\.\d+/);

      const json = JSON.parse(await readFile(run.graphJsonPath as string, 'utf8')) as DepcruiseJson;
      expect(json.summary.violations).toEqual([]);
      expect(Array.isArray(json.modules)).toBe(true);
      const configuredRules = (json.summary.ruleSetUsed?.forbidden ?? []).map((rule) => rule.name);
      expect(configuredRules).toEqual(expect.arrayContaining(BLOCK_RULES));

      // 규칙 하나 = 결과 하나. 전부 pass, ruleIds는 비어 있다(#46이 매핑), kind는 static(1등급)
      expect(run.results.map((r) => r.check.ref)).toEqual(configuredRules.map((name) => `depcruise:${name}`));
      for (const result of run.results) {
        expect(result.check.kind).toBe('static');
        expect(result.ruleIds).toEqual([]);
        expect(result.outcome).toBe('pass');
        expect(result.failure).toBeUndefined();
      }
      for (const name of BLOCK_RULES) {
        expect(run.results.find((r) => r.check.ref === `depcruise:${name}`)?.outcome).toBe('pass');
      }

      expect(run.output.logPath).toMatch(/\.work\/logs\/.+-depcruise\.log$/);
      await expect(stat(run.output.logPath)).resolves.toBeTruthy();
    },
    RUNNER_TIMEOUT,
  );

  it(
    '음성: src/app/에서 도메인 내부 파일을 import하면 block-1-public-entry-only가 fail (from 파일 · line 1 · from → to)',
    async () => {
      const violationFile = join(testbedRoot, 'src', 'app', '__plumb_violation__.ts');
      await writeFile(violationFile, "import '../domains/payment/repo';\n", 'utf8');
      try {
        const run = await runStaticChecks(ctx);

        const byRef = new Map(run.results.map((r) => [r.check.ref, r]));
        const block1 = byRef.get('depcruise:block-1-public-entry-only') as CheckResult;
        expect(block1.outcome).toBe('fail');
        expect(block1.failure).toEqual({
          check: { kind: 'static', ref: 'depcruise:block-1-public-entry-only' },
          anchor: { file: 'src/app/__plumb_violation__.ts', line: 1 },
          message: 'src/app/__plumb_violation__.ts → src/domains/payment/repo.ts (block-1-public-entry-only)',
        });

        // 같은 import는 app-thin도 어긴다. 나머지 블록 규칙은 그대로 pass — 위반 없는 규칙을 추정으로 fail로 만들지 않는다
        expect(byRef.get('depcruise:app-thin')?.outcome).toBe('fail');
        for (const name of BLOCK_RULES.filter((n) => n !== 'block-1-public-entry-only')) {
          expect(byRef.get(`depcruise:${name}`)?.outcome, name).toBe('pass');
        }

        const json = JSON.parse(await readFile(run.graphJsonPath as string, 'utf8')) as DepcruiseJson;
        expect(json.summary.violations.length).toBeGreaterThanOrEqual(1);
      } finally {
        await rm(violationFile, { force: true });
      }
    },
    RUNNER_TIMEOUT,
  );

  it('러너가 없는 루트: results 비어 있음 · graphJsonPath null · exit 127', async () => {
    const emptyRoot = await emptyTargetRoot();
    try {
      const run = await runStaticChecks({ root: emptyRoot, config: ctx.config });
      expect(run.results).toEqual([]);
      expect(run.graphJsonPath).toBeNull();
      expect(run.output.exitCode).toBe(EXIT_RUNNER_MISSING);
      expect(run.output.tail.join('\n')).toContain('러너 없음');
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('toStaticCheckResults(): depcruise JSON → 규칙별 묶기 (픽스처)', () => {
  const ruleSetUsed = { forbidden: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const violation = (from: string, to: string, name: string, severity = 'error') => ({
    type: 'dependency',
    from,
    to,
    rule: { name, severity },
  });

  it('위반이 여럿이면 첫 것이 failure, 나머지는 message에 개수. 위반 없는 규칙은 pass', () => {
    const results = toStaticCheckResults({
      summary: {
        ruleSetUsed,
        violations: [violation('x.ts', 'y.ts', 'a'), violation('p.ts', 'q.ts', 'a'), violation('m.ts', 'n.ts', 'a')],
      },
    });

    expect(results.map((r) => [r.check.ref, r.outcome])).toEqual([
      ['depcruise:a', 'fail'],
      ['depcruise:b', 'pass'],
      ['depcruise:c', 'pass'],
    ]);
    expect(results[0]?.failure).toEqual({
      check: { kind: 'static', ref: 'depcruise:a' },
      anchor: { file: 'x.ts', line: 1 },
      message: 'x.ts → y.ts (a) 외 2건',
    });
  });

  it('severity ignore는 세지 않고, 규칙 집합에 없는 이름의 위반도 한 행으로 센다. 순환은 경로를 붙인다', () => {
    const results = toStaticCheckResults({
      summary: {
        ruleSetUsed,
        violations: [
          violation('x.ts', 'y.ts', 'a', 'ignore'),
          { ...violation('u.ts', 'v.ts', 'zzz'), type: 'cycle', cycle: [{ name: 'v.ts' }, { name: 'u.ts' }] },
        ],
      },
    });

    expect(results.map((r) => [r.check.ref, r.outcome])).toEqual([
      ['depcruise:a', 'pass'],
      ['depcruise:b', 'pass'],
      ['depcruise:c', 'pass'],
      ['depcruise:zzz', 'fail'],
    ]);
    expect(results[3]?.failure?.message).toBe('u.ts → v.ts (zzz) 순환: v.ts → u.ts');
  });

  it('규칙 집합도 위반도 없으면 결과 0개 (추정으로 만들지 않는다)', () => {
    expect(toStaticCheckResults({ summary: { violations: [] } })).toEqual([]);
  });
});
