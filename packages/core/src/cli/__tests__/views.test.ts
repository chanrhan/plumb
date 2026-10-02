/**
 * `plumb views` (이슈 #60) — 가짜 어댑터 로더와 가짜 생성기 표를 `createProgram({ loadAdapter, viewGenerators })`로 주입한다.
 * 표(View · 결과 · 생성 시각 · 출처 · 파일) · `--json` · 모르는 이름 exit 2 · 실패 하나 exit 1. `check --views`의 요약 한 줄도 여기서.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../adapter/errors.js';
import type { LoadedAdapter } from '../../adapter/load.js';
import type { Adapter, TestRunResult } from '../../adapter/types.js';
import { graph as graphFixture } from '../../checks/__tests__/fixtures.js';
import type { CapturedOutput, View } from '../../types/index.js';
import { makeHeader, source } from '../../views/header.js';
import type { ViewGeneratorMap } from '../../views/registry.js';
import type { ViewGenerator } from '../../views/types.js';
import { createProgram } from '../program.js';

const CONFIG = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs',
  roles: {
    'test-writer': { model: 'default', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'default', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'default', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'default', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  blocks: { payment: { include: ['src/domains/payment/**'], dependsOn: [], risk: 'high' } },
};

const UNIT_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="1" failures="0" errors="0" time="0.01">
  <testsuite name="src/domains/payment/__tests__/payment.unit.test.ts" tests="1" failures="0" errors="0" skipped="0" time="0.01">
    <testcase classname="src/domains/payment/__tests__/payment.unit.test.ts" name="case 1" time="0.001"></testcase>
  </testsuite>
</testsuites>
`;

let dir: string;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-views-cli-'));
  await writeFile(join(dir, 'plumb.config.json'), JSON.stringify(CONFIG, null, 2));
  clock = new Date('2026-10-02T09:00:00.000Z');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function now(): Date {
  clock = new Date(clock.getTime() + 1000);
  return clock;
}

function output(exitCode: number): CapturedOutput {
  return {
    command: 'vitest run',
    startedAt: '2026-10-02T09:00:00.000Z',
    finishedAt: '2026-10-02T09:00:01.000Z',
    exitCode,
    tail: [],
    logPath: join(dir, '.work', 'logs', 'vitest.log'),
  };
}

/** `plumb check`가 돌 수 있을 만큼의 가짜 어댑터. View 생성기는 가짜라 어댑터를 안 쓴다 */
function fakeLoader(): () => Promise<LoadedAdapter> {
  const adapter: Adapter = {
    name: 'nextjs',
    async runTests(): Promise<TestRunResult> {
      const junitPath = join(dir, 'reports', 'junit.xml');
      await mkdir(join(dir, 'reports'), { recursive: true });
      await writeFile(junitPath, UNIT_XML);
      return { junitPath, exitCode: 0, output: output(0), tool: { name: 'vitest', version: '3.2.7' } };
    },
    extractDependencies: async () => graphFixture({ unclassified: [] }),
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
  return async () => ({ adapter });
}

function fakeGenerators(): ViewGeneratorMap {
  const architecture: ViewGenerator<View> = {
    name: 'architecture',
    generate: async (ctx) =>
      ({
        header: makeHeader('architecture', {
          commit: ctx.commit,
          now: ctx.now(),
          sources: [source.parser('dependency-cruiser', '18.5', 'src'), source.git('a1b2c3d4e5f6a7b8c9d0')],
        }),
      }) as unknown as View,
    render: () => '# 아키텍처\n\n```mermaid\nflowchart LR\n  payment --> auth\n```\n',
  };
  const verification: ViewGenerator<View> = {
    name: 'verification',
    generate: async () => {
      throw new Error('JUnit 없음');
    },
    render: () => '',
  };
  return { architecture, verification };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function plumb(...args: string[]): Promise<RunResult> {
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
    loadAdapter: fakeLoader(),
    viewGenerators: fakeGenerators(),
    // git이 없는 임시 폴더: commit은 undefined
  })
    .exitOverride()
    .configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  await program.parseAsync(args, { from: 'user' });
  return { code: exits[0] ?? 0, stdout: out.join(''), stderr: err.join('') };
}

describe('plumb views', () => {
  it('표: 생성됨 · 실패 · 아직 없음 — 하나가 실패해 exit 1, 파일은 생성된 View만', async () => {
    const result = await plumb('views');

    expect(result.code).toBe(1);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toMatch(/^View\s+결과\s+생성 시각\s+출처\s+파일/);
    expect(result.stdout).toMatch(
      /^architecture\s+생성됨\s+2026-10-02T09:00:0\d\.000Z\s+2\s+\.plumb-store\/views\/architecture\.json · \.plumb-store\/views\/architecture\.md/m,
    );
    // 결과 열은 60칸에서 잘리고(…), 전문은 요약 아래 사유 줄에
    expect(result.stdout).toMatch(/^verification\s+실패\(생성\): View verification: 생성 실패/m);
    expect(result.stdout).toMatch(/^changelog\s+아직 없음/m);
    expect(result.stdout).toMatch(/^flow\s+아직 없음/m);
    expect(result.stdout).toContain('View 갱신: 1 생성 · 1 실패 · 4 아직 없음');
    expect(result.stdout).toContain('  verification: View verification: 생성 실패 — JUnit 없음');

    expect((await readdir(join(dir, '.plumb-store', 'views'))).sort()).toEqual([
      'architecture.json',
      'architecture.md',
    ]);
  });

  it('이름을 주면 그것만 · --json은 cause 없이 메시지만 · 전부 성공이면 exit 0', async () => {
    const result = await plumb('views', 'architecture', 'changelog', '--json');

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as {
      commit?: string;
      views: Array<Record<string, unknown>>;
      exitCode: number;
    };
    expect(body.exitCode).toBe(0);
    expect(body).not.toHaveProperty('commit');
    expect(body.views).toHaveLength(2);
    expect(body.views[0]).toMatchObject({ name: 'architecture', ok: true, sources: 2 });
    expect(body.views[0]).not.toHaveProperty('commit');
    expect(body.views[1]).toEqual({ name: 'changelog', skipped: 'not-implemented' });
  });

  it('--json 실패 행은 stage · error만 (Error 객체 없음)', async () => {
    const result = await plumb('views', 'verification', '--json');
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as { views: Array<Record<string, unknown>> };
    expect(body.views[0]).toEqual({
      name: 'verification',
      ok: false,
      stage: 'generate',
      error: 'View verification: 생성 실패 — JUnit 없음',
    });
  });

  it('모르는 이름 → stderr 한 줄 + exit 2, 저장소도 열지 않는다', async () => {
    const result = await plumb('views', 'architecture', 'nope');
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      'plumb views: 모르는 View 이름 "nope" — architecture · flow · changelog · verification · dependencies · contract 중 하나\n',
    );
    expect(result.stdout).toBe('');
    await expect(readdir(join(dir, '.plumb-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('plumb check --views: 검사 표 뒤에 View 갱신 요약 한 줄, 검사 종료 코드는 그대로 0', async () => {
    const result = await plumb('check', '--views');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('━━ 검사 범위 밖 ━━');
    expect(result.stdout).toMatch(
      /\nView 갱신: 1 생성 · 1 실패 · 4 아직 없음 \(architecture\)\n {2}verification: View verification: 생성 실패 — JUnit 없음\n$/,
    );
    expect((await readdir(join(dir, '.plumb-store', 'views'))).sort()).toEqual([
      'architecture.json',
      'architecture.md',
    ]);
  });

  it('plumb check --views --json: views 배열이 들어간다', async () => {
    const result = await plumb('check', '--views', '--json');
    const body = JSON.parse(result.stdout) as { views: Array<Record<string, unknown>> };
    expect(body.views.map((v) => v.name)).toEqual([
      'architecture',
      'flow',
      'changelog',
      'verification',
      'dependencies',
      'contract',
    ]);
    expect(body.views[3]).toEqual({
      name: 'verification',
      ok: false,
      stage: 'generate',
      error: 'View verification: 생성 실패 — JUnit 없음',
    });
  });
});
