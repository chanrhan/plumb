import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_RULES_YAML,
  initStore,
  readStoreMeta,
  StoreNotInitializedError,
  storeDirectories,
  ValidationError,
} from '../index.js';
import { FIXED_NOW, makeTempStore, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore({ init: false, now: () => FIXED_NOW });
});

afterEach(() => t.cleanup());

describe('initStore', () => {
  it('폴더 · 빈 rules.yaml(rules: []) · meta.json을 만든다', async () => {
    await expect(t.store.rules.list()).rejects.toBeInstanceOf(StoreNotInitializedError);
    await expect(readStoreMeta(t.store.paths)).rejects.toBeInstanceOf(ValidationError);

    const meta = await t.store.init();

    expect(meta).toEqual({ version: 1, project: 'testbed', createdAt: FIXED_NOW.toISOString() });
    for (const dir of storeDirectories(t.store.paths)) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
    expect(await readFile(join(t.storeDir, 'rules.yaml'), 'utf8')).toBe(EMPTY_RULES_YAML);
    expect(EMPTY_RULES_YAML).toBe('version: 1\nrules: []\n');
    expect(JSON.parse(await readFile(join(t.storeDir, 'meta.json'), 'utf8'))).toEqual(meta);
    expect(await readStoreMeta(t.store.paths)).toEqual(meta);
    expect(await t.store.rules.list()).toEqual([]);
  });

  it('이미 있으면 그대로 둔다 (멱등)', async () => {
    const first = await initStore(t.store.paths, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    await writeFile(
      t.store.paths.rules,
      'version: 1\nrules:\n  - id: a.b\n    kind: business\n    statement: s\n    source: plan:X\n    risk: normal\n',
    );

    const second = await initStore(t.store.paths, { now: () => FIXED_NOW });

    expect(second).toEqual(first);
    expect(second.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(await t.store.rules.list()).toHaveLength(1);
  });
});
