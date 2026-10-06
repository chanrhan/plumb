/**
 * 이슈 #120 "완료 증거" (core): 검토 대기열 처리 — resolve 성공(`resolvedAt` 기록 · `status().reviewQueue` 감소 · `list(true)`에서 빠짐)
 * → 없는 id `ReviewItemNotFoundError` → 이미 처리 `ValidationError` → `by` 비어 있음 `ValidationError` → Store 표면 `reviewQueue.resolve` · `get`.
 * 이슈 #130: resolve가 `resolvedBy` · `note`를 파일에 쓰고 다시 읽히며, 두 필드가 없던 기존 파일(#120 이전 모양)도 그대로 파싱된다.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    // 처리자 · 메모가 함께 적힌다 (#130)
    expect(resolved.resolvedBy).toBe('ui');
    expect(resolved.note).toBe('테스트가 맞다');
    // 다른 필드는 그대로
    expect({ ...resolved, resolvedAt: undefined, resolvedBy: undefined, note: undefined }).toEqual({
      ...dispute,
      resolvedAt: undefined,
      resolvedBy: undefined,
      note: undefined,
    });

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

  it('resolvedBy · note가 파일에 남아 다시 읽힌다. note 없으면 키 자체가 없고, 공백은 다듬는다 (#130)', async () => {
    const { store, storeDir } = t;
    const withNote = await store.reviewQueue.enqueue({ kind: 'interpretation', ruleIds: [], summary: '해석 불일치' });
    const noNote = await store.reviewQueue.enqueue({
      kind: 'run-failed',
      ruleIds: [],
      runId: 'r-0003',
      summary: '실패',
    });
    const blankNote = await store.reviewQueue.enqueue({ kind: 'budget-exceeded', ruleIds: [], summary: '$10.02' });

    await store.reviewQueue.resolve(withNote.id, { by: '  cli ', note: '  규칙 쪽을 고쳤다  ' });
    await store.reviewQueue.resolve(noNote.id, { by: 'ui' });
    await store.reviewQueue.resolve(blankNote.id, { by: 'ui', note: '   ' });

    // 파일 자체에 적혔다 (파서를 거치지 않고 읽는다)
    const raw = JSON.parse(await readFile(join(storeDir, 'review-queue', `${withNote.id}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw.resolvedBy).toBe('cli');
    expect(raw.note).toBe('규칙 쪽을 고쳤다');
    expect(typeof raw.resolvedAt).toBe('string');

    // 다시 읽어도 같다
    expect(await store.reviewQueue.get(withNote.id)).toMatchObject({ resolvedBy: 'cli', note: '규칙 쪽을 고쳤다' });
    const again = await store.reviewQueue.get(noNote.id);
    expect(again?.resolvedBy).toBe('ui');
    expect(again !== undefined && 'note' in again).toBe(false);
    expect((await store.reviewQueue.get(blankNote.id)) ?? {}).not.toHaveProperty('note');
    expect((await store.reviewQueue.list()).map((i) => [i.id, i.resolvedBy, i.note])).toEqual([
      [withNote.id, 'cli', '규칙 쪽을 고쳤다'],
      [noNote.id, 'ui', undefined],
      [blankNote.id, 'ui', undefined],
    ]);
  });

  it('두 필드가 없던 기존 파일(#120 이전 모양)도 파싱된다. 있으면 문자열이어야 한다', async () => {
    const { store, storeDir } = t;
    const dir = join(storeDir, 'review-queue');
    await mkdir(dir, { recursive: true });
    // plumb run이 올린 열린 항목 — resolvedAt · resolvedBy · note 전부 없음
    await writeFile(
      join(dir, 'q-0001.json'),
      JSON.stringify({
        id: 'q-0001',
        kind: 'dispute',
        ruleIds: ['pay.refund-window'],
        runId: 'r-0001',
        summary: '경계값(7일 정각)이 규칙과 다름',
        createdAt: '2026-10-02T05:10:00.000Z',
      }),
    );
    // #120 시절에 처리된 항목 — resolvedAt만 있다
    await writeFile(
      join(dir, 'q-0002.json'),
      JSON.stringify({
        id: 'q-0002',
        kind: 'run-failed',
        ruleIds: [],
        summary: '실행 실패: stopBlockLimit',
        createdAt: '2026-10-02T06:00:00.000Z',
        resolvedAt: '2026-10-02T07:00:00.000Z',
      }),
    );

    const items = await store.reviewQueue.list();
    expect(items.map((i) => [i.id, i.resolvedAt, i.resolvedBy, i.note])).toEqual([
      ['q-0001', undefined, undefined, undefined],
      ['q-0002', '2026-10-02T07:00:00.000Z', undefined, undefined],
    ]);
    expect((await store.reviewQueue.list(true)).map((i) => i.id)).toEqual(['q-0001']);
    expect((await store.status()).reviewQueue).toBe(1);

    // 옛 모양의 열린 항목을 지금 처리하면 두 필드가 붙는다
    const resolved = await store.reviewQueue.resolve('q-0001', { by: 'ui', note: '테스트가 맞다' });
    expect(resolved).toMatchObject({ resolvedBy: 'ui', note: '테스트가 맞다' });
    expect((await store.reviewQueue.get('q-0001'))?.note).toBe('테스트가 맞다');

    // 값이 있는데 문자열이 아니면 거부
    await writeFile(
      join(dir, 'q-0003.json'),
      JSON.stringify({
        id: 'q-0003',
        kind: 'design-change',
        ruleIds: [],
        summary: '블록 경계 변경',
        createdAt: '2026-10-03T01:00:00.000Z',
        resolvedAt: '2026-10-03T02:00:00.000Z',
        resolvedBy: 7,
      }),
    );
    await expect(store.reviewQueue.get('q-0003')).rejects.toBeInstanceOf(ValidationError);
    await writeFile(
      join(dir, 'q-0003.json'),
      JSON.stringify({
        id: 'q-0003',
        kind: 'design-change',
        ruleIds: [],
        summary: '블록 경계 변경',
        createdAt: '2026-10-03T01:00:00.000Z',
        note: ['x'],
      }),
    );
    await expect(store.reviewQueue.get('q-0003')).rejects.toBeInstanceOf(ValidationError);
  });

  it('Store 표면: reviewQueue는 enqueue · get · list · nextId · resolve', () => {
    expect(Object.keys(t.store.reviewQueue).sort()).toEqual(['enqueue', 'get', 'list', 'nextId', 'resolve']);
  });
});
