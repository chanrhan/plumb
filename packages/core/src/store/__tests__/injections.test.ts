import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Validity } from '../../types/index.js';
import { ValidationError } from '../errors.js';
import { openStore, type Store } from '../index.js';
import { latestInjection, listInjections, nextInjectionId, writeInjection } from '../injections.js';

const base = {
  ruleId: 'pay.refund-window' as const,
  description: '7일 검사 제거',
  anchor: { file: 'src/domains/payment/payment.ts', line: 30, block: 'payment' },
  commit: 'abc1234',
  checkFileHashes: { 'test/acceptance/refund-window.property.spec.ts': 'deadbeef' },
};

describe('store injections', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-inj-'));
    store = openStore({ store: './.plumb-store' }, dir);
    await store.init();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('i-0001부터 · 쓰고 · 목록(시각순) · 최근', async () => {
    expect(await nextInjectionId(store.paths, base.ruleId)).toBe('i-0001');
    const a: Validity = { ...base, id: 'i-0001', at: '2026-10-03T00:00:00.000Z', result: 'check-failed', valid: true };
    const b: Validity = { ...base, id: 'i-0002', at: '2026-10-03T01:00:00.000Z', result: 'check-passed', valid: false };
    await writeInjection(store.paths, a);
    await writeInjection(store.paths, b);
    expect(await nextInjectionId(store.paths, base.ruleId)).toBe('i-0003');
    expect((await listInjections(store.paths, base.ruleId)).map((v) => v.id)).toEqual(['i-0001', 'i-0002']);
    expect((await latestInjection(store.paths, base.ruleId))?.valid).toBe(false);
    expect(await listInjections(store.paths, 'other.rule')).toEqual([]);
  });

  it('result와 valid가 어긋나거나 설명이 없으면 ValidationError', async () => {
    await expect(
      writeInjection(store.paths, { ...base, id: 'i-0001', at: 't', result: 'check-failed', valid: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      writeInjection(store.paths, {
        ...base,
        id: 'i-0001',
        at: 't',
        description: ' ',
        result: 'check-failed',
        valid: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      writeInjection(store.paths, { ...base, id: 'inj-1', at: 't', result: 'check-failed', valid: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
