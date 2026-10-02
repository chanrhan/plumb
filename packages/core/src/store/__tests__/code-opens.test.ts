/** `store.codeOpens` (이슈 #60) — append · list · summary · count. 이유 없으면 거부, 실패 기록도 남는다 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeOpenReason } from '../../types/index.js';
import { ValidationError } from '../errors.js';
import { openStore, type Store } from '../index.js';

const ROLE = { model: 'default', maxTurns: 1, maxBudgetUsd: 0 };
const CONFIG = {
  service: '.',
  store: './.plumb-store',
  adapter: 'nextjs' as const,
  roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
  stopBlockLimit: 5,
};

let dir: string;
let store: Store;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-code-opens-'));
  clock = new Date('2026-10-02T09:00:00.000Z');
  store = openStore(CONFIG, dir, {
    now: () => {
      clock = new Date(clock.getTime() + 1000);
      return clock;
    },
  });
  await store.init();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const OPENED = { status: 'opened', command: 'code --goto src/a.ts:1' } as const;
const FAILED = { status: 'failed', command: 'code --goto src/a.ts:2', error: '명령을 찾을 수 없다: code' } as const;

describe('store.codeOpens', () => {
  it('없으면 빈 목록 · 0회 · 요약 0', async () => {
    expect(await store.codeOpens.list()).toEqual([]);
    expect(await store.codeOpens.count('architecture')).toBe(0);
    expect(await store.codeOpens.summary()).toEqual({
      total: 0,
      byReason: { 'view-error': 0, 'missing-info': 0, 'debugging-env': 0 },
      byResult: { opened: 0, failed: 0 },
    });
  });

  it('append는 한 줄씩 덧붙이고, item 기본값은 file:line, at은 저장소 시계', async () => {
    const first = await store.codeOpens.append({
      view: 'architecture',
      file: 'src/a.ts',
      line: 1,
      reason: 'view-error',
      result: OPENED,
    });
    const second = await store.codeOpens.append({
      file: 'src/a.ts',
      line: 2,
      reason: 'missing-info',
      note: '왜',
      result: FAILED,
    });

    // init()이 시계를 한 번 썼다 (meta.json) → 첫 기록은 :02
    expect(first).toEqual({
      at: '2026-10-02T09:00:02.000Z',
      view: 'architecture',
      item: 'src/a.ts:1',
      file: 'src/a.ts',
      line: 1,
      reason: 'view-error',
      result: OPENED,
    });
    expect(second).not.toHaveProperty('view');
    expect(second.note).toBe('왜');

    const lines = (await readFile(join(dir, '.plumb-store', 'code-opens.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(first);
    expect(await store.codeOpens.list()).toEqual([first, second]);
  });

  it('이유가 없거나 모르는 값이면 ValidationError, 파일에 아무것도 안 남는다', async () => {
    await expect(
      store.codeOpens.append({ file: 'src/a.ts', reason: 'curious' as CodeOpenReason, result: OPENED }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.codeOpens.append({ file: 'src/a.ts', reason: undefined as unknown as CodeOpenReason, result: OPENED }),
    ).rejects.toThrow(/고르지 않으면 열리지 않는다/);
    expect(await store.codeOpens.list()).toEqual([]);
  });

  it('count는 View · since(생성 시각) 이후만, summary는 이유별 · 결과별', async () => {
    await store.codeOpens.append({ view: 'verification', file: 'a.ts', reason: 'view-error', result: OPENED }); // 09:00:02
    await store.codeOpens.append({ view: 'verification', file: 'b.ts', reason: 'missing-info', result: FAILED }); // 09:00:03
    await store.codeOpens.append({ view: 'architecture', file: 'c.ts', reason: 'missing-info', result: OPENED }); // 09:00:04
    await store.codeOpens.append({ file: 'd.ts', reason: 'debugging-env', result: OPENED }); // view 없음

    expect(await store.codeOpens.count('verification')).toBe(2);
    expect(await store.codeOpens.count('verification', '2026-10-02T09:00:03.000Z')).toBe(1);
    expect(await store.codeOpens.count('architecture')).toBe(1);
    expect(await store.codeOpens.count('flow')).toBe(0);
    expect(await store.codeOpens.summary()).toEqual({
      total: 4,
      byReason: { 'view-error': 1, 'missing-info': 2, 'debugging-env': 1 },
      byResult: { opened: 3, failed: 1 },
    });
  });
});
