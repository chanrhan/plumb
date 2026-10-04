import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReviewQueueItem, Validity } from '../../types/index.js';
import { DIFF_TARGETS_FILE, hasDiffTargets, judgeDiffSearch, recordDiffSearch, runDiffSearch } from '../diff-search.js';

const TESTBED = join(
  dirname(createRequire(import.meta.url).resolve('../../../package.json')),
  '..',
  '..',
  'examples',
  'testbed',
);

describe('judgeDiffSearch', () => {
  it('차이 > 0 → weak-check, 0 → undetermined, 입력 0 → undetermined', () => {
    expect(judgeDiffSearch({ inputs: 100, differing: 7 }).verdict).toBe('weak-check');
    expect(judgeDiffSearch({ inputs: 100, differing: 0 }).verdict).toBe('undetermined');
    expect(judgeDiffSearch({ inputs: 0, differing: 0 })).toMatchObject({
      verdict: 'undetermined',
      reason: expect.stringContaining('입력을 만들지'),
    });
  });
});

describe('runDiffSearch — 실제 자식 프로세스 · 서비스의 fast-check · 고정 시드', () => {
  let dir: string;
  let original: string;
  let injected: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-diff-'));
    original = join(dir, 'original');
    injected = join(dir, 'injected');
    const req = createRequire(join(TESTBED, 'package.json'));
    const fcRoot = dirname(req.resolve('fast-check/package.json'));
    const tsxRoot = dirname(req.resolve('tsx/package.json'));
    for (const root of [original, injected]) {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'plumb'), { recursive: true });
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await symlink(fcRoot, join(root, 'node_modules', 'fast-check'), 'dir');
      await symlink(tsxRoot, join(root, 'node_modules', 'tsx'), 'dir');
      await writeFile(join(root, 'package.json'), '{"type":"module"}');
    }
    // 원본: 7일 초과 거절. 위반: 경계를 8일로 (검사가 7일+1ms만 본다면 통과해 버리는 종류)
    const DAY = 24 * 60 * 60 * 1000;
    await writeFile(
      join(original, 'src', 'window.ts'),
      `export function isRefundable(paidAt: number, requestedAt: number): boolean { return requestedAt - paidAt <= ${7 * DAY}; }\n`,
    );
    await writeFile(
      join(injected, 'src', 'window.ts'),
      `export function isRefundable(paidAt: number, requestedAt: number): boolean { return requestedAt - paidAt <= ${8 * DAY}; }\n`,
    );
    await writeFile(
      join(original, DIFF_TARGETS_FILE),
      `import fc from 'fast-check';\nconst DAY = ${DAY};\nexport default {\n  'pay.refund-window': { module: 'src/window.ts', export: 'isRefundable', arbitrary: fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 10 * DAY })) },\n  'x.same': { module: 'src/window.ts', export: 'isRefundable', arbitrary: fc.tuple(fc.constant(0), fc.integer({ min: 0, max: DAY })) },\n};\n`,
    );
    // 위반 쪽에도 대상 정의가 있지만(다르게) 드라이버는 원본 것을 쓴다
    await writeFile(join(injected, DIFF_TARGETS_FILE), 'export default {};\n');
  }, 30_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('7~8일 사이 입력에서 출력이 갈린다 · 같은 시드면 같은 결과 · 대상 정의는 원본에서', async () => {
    const a = await runDiffSearch({
      originalRoot: original,
      injectedRoot: injected,
      ruleId: 'pay.refund-window',
      numRuns: 200,
      seed: 42,
    });
    expect(a.inputs).toBe(200);
    expect(a.differing).toBeGreaterThan(0);
    expect(a.examples[0]).toMatchObject({ original: 'false', injected: 'true' });
    const b = await runDiffSearch({
      originalRoot: original,
      injectedRoot: injected,
      ruleId: 'pay.refund-window',
      numRuns: 200,
      seed: 42,
    });
    expect(b.differing).toBe(a.differing);
    expect(await hasDiffTargets(original)).toBe(true);
    expect(await hasDiffTargets(dir)).toBe(false);
  }, 60_000);

  it('입력 공간이 차이를 못 보면 differing 0 → undetermined', async () => {
    const out = await runDiffSearch({
      originalRoot: original,
      injectedRoot: injected,
      ruleId: 'x.same',
      numRuns: 50,
      seed: 1,
    });
    expect(out.differing).toBe(0);
    expect(judgeDiffSearch(out).verdict).toBe('undetermined');
  }, 60_000);
});

describe('recordDiffSearch', () => {
  const validity: Validity & { valid: false } = {
    id: 'i-0001',
    ruleId: 'pay.refund-window',
    description: '경계를 8일로',
    commit: 'abc',
    at: 't',
    checkFileHashes: {},
    result: 'check-passed',
    valid: false,
  };
  function fakeStore() {
    const written: unknown[] = [];
    const items: ReviewQueueItem[] = [];
    const store = {
      paths: { injection: () => join(tmpdir(), 'plumb-diff-record', 'i.json') },
      reviewQueue: {
        enqueue: async (input: Omit<ReviewQueueItem, 'id' | 'createdAt'>) => {
          const item = { ...input, id: 'q-0001', createdAt: 't' } as ReviewQueueItem;
          items.push(item);
          return item;
        },
      },
    } as never;
    return { store, written, items };
  }
  it('weak-check는 대기열 없이 diffSearch만, undetermined는 대기열 undetermined-injection + queueItemId', async () => {
    await mkdir(join(tmpdir(), 'plumb-diff-record'), { recursive: true });
    const a = fakeStore();
    const weak = await recordDiffSearch({
      store: a.store,
      validity,
      runId: 'r-0001',
      out: { inputs: 100, differing: 3, examples: [], seed: 1 },
    });
    expect(weak.diffSearch).toEqual({ runId: 'r-0001', inputs: 100, differingOutputs: 3, verdict: 'weak-check' });
    expect(a.items).toHaveLength(0);
    const b = fakeStore();
    const und = await recordDiffSearch({
      store: b.store,
      validity,
      runId: 'r-0001',
      out: { inputs: 100, differing: 0, examples: [], seed: 1 },
    });
    expect(und.diffSearch).toMatchObject({ verdict: 'undetermined', queueItemId: 'q-0001' });
    expect(b.items[0]).toMatchObject({
      kind: 'undetermined-injection',
      ruleIds: ['pay.refund-window'],
      runId: 'r-0001',
    });
    await rm(join(tmpdir(), 'plumb-diff-record'), { recursive: true, force: true });
  });
});
