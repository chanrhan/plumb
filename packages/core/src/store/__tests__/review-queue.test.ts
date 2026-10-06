/**
 * 이슈 #120 "완료 증거" (core): 검토 대기열 처리 — resolve 성공(`resolvedAt` 기록 · `status().reviewQueue` 감소 · `list(true)`에서 빠짐)
 * → 없는 id `ReviewItemNotFoundError` → 이미 처리 `ValidationError` → `by` 비어 있음 `ValidationError` → Store 표면 `reviewQueue.resolve` · `get`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewItemNotFoundError, ValidationError } from '../index.js';
import { FIXED_NOW, makeTempStore, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

describe('store.reviewQueue.resolve (#120)', () => {
  it('처리 성공: resolvedAt을 쓰고, 미처리 목록과 status().reviewQueue에서 빠진다', async () => {
    const { store } = t;
    const dispute = await store.reviewQueue.enqueue({
      kind: 'dispute',
      ruleIds: ['pay.refund-window'],
      runId: 'r-0001',
      summary: 'refund-window.property.spec.ts 의 경계값(7일 정각)이 규칙과 다름',
    });
    const failed = await store.reviewQueue.enqueue({
      kind: 'run-failed',
      ruleIds: ['pay.refund-window'],
      runId: 'r-0002',
      summary: '실행 실패: stopBlockLimit',
    });
    expect((await store.status()).reviewQueue).toBe(2);

    const resolved = await store.reviewQueue.resolve(dispute.id, { by: 'ui', note: '테스트가 맞다' });
    expect(resolved.id).toBe('q-0001');
    expect(resolved.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 저장소 시계(tickingClock)로 찍힌다 — FIXED_NOW 이후
    expect(Date.parse(resolved.resolvedAt ?? '')).toBeGreaterThan(FIXED_NOW.getTime());
    // 다른 필드는 그대로
    expect({ ...resolved, resolvedAt: undefined }).toEqual({ ...dispute, resolvedAt: undefined });

    // 파일에 남았다 — 다시 읽어도 같다
    expect(await store.reviewQueue.get(dispute.id)).toEqual(resolved);
    expect((await store.reviewQueue.list(true)).map((i) => i.id)).toEqual([failed.id]);
    expect((await store.reviewQueue.list()).map((i) => i.id)).toEqual([dispute.id, failed.id]);
    expect((await store.status()).reviewQueue).toBe(1);
  });

  it('없는 id → ReviewItemNotFoundError (꼴이 아닌 id도)', async () => {
    await expect(t.store.reviewQueue.resolve('q-9999', { by: 'ui' })).rejects.toBeInstanceOf(ReviewItemNotFoundError);
    await expect(t.store.reviewQueue.resolve('nope' as never, { by: 'ui' })).rejects.toBeInstanceOf(
      ReviewItemNotFoundError,
    );
    await expect(t.store.reviewQueue.resolve('../etc' as never, { by: 'ui' })).rejects.toBeInstanceOf(
      ReviewItemNotFoundError,
    );
    expect(await t.store.reviewQueue.get('q-9999')).toBeUndefined();
  });

  it('이미 처리된 항목 → ValidationError, 첫 resolvedAt은 그대로', async () => {
    const item = await t.store.reviewQueue.enqueue({
      kind: 'budget-exceeded',
      ruleIds: [],
      summary: '$10.02 / $10.00',
    });
    const first = await t.store.reviewQueue.resolve(item.id, { by: 'ui' });
    await expect(t.store.reviewQueue.resolve(item.id, { by: 'ui' })).rejects.toBeInstanceOf(ValidationError);
    expect((await t.store.reviewQueue.get(item.id))?.resolvedAt).toBe(first.resolvedAt);
    expect((await t.store.status()).reviewQueue).toBe(0);
  });

  it('by가 비어 있으면 ValidationError, 아무것도 쓰지 않는다', async () => {
    const item = await t.store.reviewQueue.enqueue({ kind: 'design-change', ruleIds: [], summary: '블록 경계 변경' });
    await expect(t.store.reviewQueue.resolve(item.id, { by: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.reviewQueue.resolve(item.id, { by: '  ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.reviewQueue.resolve(item.id, { by: 'ui', note: 1 as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await t.store.reviewQueue.get(item.id))?.resolvedAt).toBeUndefined();
    expect((await t.store.status()).reviewQueue).toBe(1);
  });

  it('Store 표면: reviewQueue는 enqueue · get · list · nextId · resolve', () => {
    expect(Object.keys(t.store.reviewQueue).sort()).toEqual(['enqueue', 'get', 'list', 'nextId', 'resolve']);
  });
});
