import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, TestRunResult } from '../../adapter/types.js';
import type { RoleRunResult, RunRoleInput } from '../../harness/run-role.js';
import { openStore, type Store } from '../../store/index.js';
import type { Rule } from '../../types/index.js';
import { InjectionError, injectOnce } from '../inject.js';

const exec = promisify(execFile);
const RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};
const config = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs' as const,
  roles: {
    'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  blocks: { payment: { include: ['src/domains/payment/**'], dependsOn: [] } },
};
const FILE = RULE.checks[0]?.ref ?? '';

function junit(failed: number, passed: number): string {
  const cases = [
    ...Array.from(
      { length: failed },
      (_, i) => `<testcase classname="${FILE}" name="f${i}" time="0"><failure message="x">x</failure></testcase>`,
    ),
    ...Array.from({ length: passed }, (_, i) => `<testcase classname="${FILE}" name="p${i}" time="0"/>`),
  ].join('');
  return `<?xml version="1.0"?><testsuites><testsuite name="${FILE}" file="${FILE}" tests="${failed + passed}" failures="${failed}">${cases}</testsuite></testsuites>`;
}

describe('injectOnce (SDK 가짜 · 실제 git worktree 대신 임시 git 레포)', () => {
  let dir: string;
  let repo: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-inject-'));
    repo = join(dir, 'repo');
    await mkdir(join(repo, 'src', 'domains', 'payment'), { recursive: true });
    await mkdir(join(repo, 'test', 'acceptance'), { recursive: true });
    await writeFile(join(repo, 'src', 'domains', 'payment', 'payment.ts'), 'export const DAYS = 7;\n');
    await writeFile(join(repo, FILE), '// spec\n');
    await exec('git', ['init', '-q'], { cwd: repo });
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo });
    store = openStore(config, dir);
    await store.init();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** createWorktree 대신: 레포 자체를 "worktree"로 쓴다 (서비스 루트 = repo) */
  const fakeWorktree = async () => ({ repoRoot: repo, serviceRoot: repo, commit: 'abc1234def', linkedNodeModules: [] });
  const fakeAdapter = (failed: number, passed: number) =>
    ({
      runTests: async (): Promise<TestRunResult> => {
        const junitPath = join(dir, 'junit.xml');
        await writeFile(junitPath, junit(failed, passed));
        return {
          junitPath,
          exitCode: failed ? 1 : 0,
          output: {
            command: 'vitest',
            startedAt: 't',
            finishedAt: 't',
            exitCode: failed ? 1 : 0,
            tail: [],
            logPath: '',
          },
          tool: { name: 'vitest', version: '3' },
        };
      },
    }) as unknown as Adapter;
  const changing = async (input: RunRoleInput): Promise<RoleRunResult> => {
    await writeFile(
      join(input.options.cwd ?? repo, 'src', 'domains', 'payment', 'payment.ts'),
      'export const DAYS = 700;\n',
    );
    return {
      outcome: 'success',
      ok: true,
      turns: 3,
      costUsd: 0.05,
      permissionDenials: 0,
      durationMs: 1,
      result: {
        subtype: 'success',
        structured_output: {
          description: '7일 창을 700일로 늘려 검사를 무력화',
          file: 'src/domains/payment/payment.ts',
          line: 1,
        },
      },
    } as unknown as RoleRunResult;
  };

  it('검사가 실패하면 유효 ✔(check-failed) — 설명 · 위치 · 커밋 · 검사 파일 해시를 기록, worktree는 보존 옵션에 따라', async () => {
    const r = await injectOnce({
      config,
      root: dir,
      store,
      adapter: fakeAdapter(1, 0),
      rule: RULE,
      runRole: changing,
      createWorktree: fakeWorktree,
      keepWorktree: true,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(r.validity).toMatchObject({
      id: 'i-0001',
      ruleId: RULE.id,
      result: 'check-failed',
      valid: true,
      description: '7일 창을 700일로 늘려 검사를 무력화',
      anchor: { file: 'src/domains/payment/payment.ts', line: 1, block: 'payment' },
      commit: 'abc1234def',
      at: '2026-10-03T00:00:00.000Z',
    });
    expect(Object.keys(r.validity.checkFileHashes)).toEqual([FILE]);
    expect(r.changedFiles).toEqual(['src/domains/payment/payment.ts']);
    expect(r.role).toEqual({ turns: 3, costUsd: 0.05, outcome: 'success' });
    const saved = JSON.parse(await readFile(store.paths.injection(RULE.id, 'i-0001'), 'utf8'));
    expect(saved.valid).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('700'); // 패치 본문은 저장하지 않는다
  });

  it('검사가 통과해 버리면 무효 ✘(check-passed) — 차이 탐색(#91)의 입력', async () => {
    const r = await injectOnce({
      config,
      root: dir,
      store,
      adapter: fakeAdapter(0, 1),
      rule: RULE,
      runRole: changing,
      createWorktree: fakeWorktree,
      keepWorktree: true,
    });
    expect(r.validity).toMatchObject({ result: 'check-passed', valid: false });
  });

  it('injector가 아무것도 바꾸지 않으면 no-change, 인수 테스트가 없으면 no-acceptance-tests', async () => {
    const noop = async (): Promise<RoleRunResult> =>
      ({
        outcome: 'success',
        ok: true,
        turns: 1,
        costUsd: 0,
        permissionDenials: 0,
        durationMs: 1,
      }) as unknown as RoleRunResult;
    await expect(
      injectOnce({
        config,
        root: dir,
        store,
        adapter: fakeAdapter(1, 0),
        rule: RULE,
        runRole: noop,
        createWorktree: fakeWorktree,
        keepWorktree: true,
      }),
    ).rejects.toMatchObject({ code: 'no-change' });
    await expect(
      injectOnce({
        config,
        root: dir,
        store,
        adapter: fakeAdapter(1, 0),
        rule: { ...RULE, checks: [] },
        runRole: noop,
        createWorktree: fakeWorktree,
      }),
    ).rejects.toBeInstanceOf(InjectionError);
  });
});
