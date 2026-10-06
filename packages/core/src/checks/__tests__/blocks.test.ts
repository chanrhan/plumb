/**
 * 이슈 #121 "완료 증거": 블록 트리 응답 — worstStatus 우선순위(🔴 > 🟠 > 🟡 > 🟢 > ⬜, README 2절 · STATUS_SEVERITY와 같다) · 규칙 없는 블록 `null` · 그래프 없음(`no-graph`) ·
 * 규칙에만 있는 블록 · `paths` · `public` · `files`의 출처(그래프 → config).
 */

import { describe, expect, it } from 'vitest';
import type { BlockConfig } from '../../types/index.js';
import { computeBlocksResponse, worstOfCounts } from '../blocks.js';
import { emptyStatusCounts, STATUS_SEVERITY } from '../summary.js';
import { block, graph, record, rule } from './fixtures.js';

const CONFIG_BLOCKS: Record<string, BlockConfig> = {
  payment: { include: ['src/domains/payment/**'], public: ['index.ts'], risk: 'high' },
  auth: { include: ['src/domains/auth/**'] },
};

const view = () => {
  const g = graph();
  return { blocks: g.blocks, unclassified: g.unclassified };
};

describe('worstOfCounts', () => {
  it('🔴 > 🟠 > 🟡 > 🟢 > ⬜ — 검증 View 블록 머리글 집계(STATUS_SEVERITY)와 같은 순위', () => {
    expect(STATUS_SEVERITY['pass-verified']).toBeGreaterThan(STATUS_SEVERITY.unchecked);
    expect(worstOfCounts(emptyStatusCounts())).toBeNull();
    expect(worstOfCounts({ ...emptyStatusCounts(), unchecked: 2 })).toBe('unchecked');
    expect(worstOfCounts({ ...emptyStatusCounts(), 'pass-verified': 2, unchecked: 1 })).toBe('pass-verified');
    expect(worstOfCounts({ ...emptyStatusCounts(), 'pass-verified': 1, 'pass-unverified': 1 })).toBe('pass-unverified');
    expect(worstOfCounts({ ...emptyStatusCounts(), 'pass-unverified': 1, recheck: 1 })).toBe('recheck');
    expect(worstOfCounts({ ...emptyStatusCounts(), recheck: 3, fail: 1, 'pass-verified': 9 })).toBe('fail');
  });
});

describe('computeBlocksResponse', () => {
  it('config 블록 순서 · 규칙 수 · 최악 상태 점 · 미분류 수 (testbed 모양: payment 🟢 1 · auth ⬜ 0 · 미분류 2)', () => {
    const response = computeBlocksResponse({
      config: { blocks: CONFIG_BLOCKS },
      rules: [rule('pay.a', { block: 'payment' })],
      statuses: [record('pay.a', 'pass-verified')],
      graph: view(),
    });

    expect(response.empty).toBeUndefined();
    expect(response.unclassified).toBe(2);
    expect(response.blocks.map((b) => [b.id, b.worstStatus, b.rules])).toEqual([
      ['payment', 'pass-verified', 1],
      ['auth', null, 0],
    ]);
    // paths · public · files는 그래프(파서)에서, declared · risk는 config에서
    expect(response.blocks[0]).toMatchObject({
      level: 'L1',
      kind: 'domain',
      paths: ['src/domains/payment/**'],
      public: ['src/domains/payment/index.ts'],
      files: 3,
      declared: true,
      risk: 'high',
    });
    expect(response.blocks[1]?.risk).toBeUndefined();
  });

  it('상태 점은 블록 규칙들의 최악: 🟢 둘 + ⬜ 하나 → 🟢, 🟡 + 🔴 → 🔴, 🟡 + 🟠 → 🟠', () => {
    const response = computeBlocksResponse({
      config: { blocks: { ...CONFIG_BLOCKS, billing: { include: ['src/domains/billing/**'] } } },
      rules: [
        rule('pay.a', { block: 'payment' }),
        rule('pay.b', { block: 'payment' }),
        rule('pay.c', { block: 'payment' }),
        rule('auth.a', { block: 'auth' }),
        rule('auth.b', { block: 'auth' }),
        rule('bill.a', { block: 'billing' }),
        rule('bill.b', { block: 'billing' }),
      ],
      statuses: [
        record('pay.a', 'pass-verified'),
        record('pay.b', 'pass-verified'),
        record('pay.c', 'unchecked'),
        record('auth.a', 'pass-unverified'),
        record('auth.b', 'fail'),
        record('bill.a', 'pass-unverified'),
        record('bill.b', 'recheck'),
      ],
      graph: view(),
    });
    expect(response.blocks.map((b) => [b.id, b.worstStatus, b.rules])).toEqual([
      ['payment', 'pass-verified', 3],
      ['auth', 'fail', 2],
      ['billing', 'recheck', 2],
    ]);
  });

  it('규칙은 있지만 상태 기록이 없는 블록도 null (화면은 ⬜). 상태 기록이 없는 규칙은 규칙 수에만 들어간다', () => {
    const response = computeBlocksResponse({
      config: { blocks: CONFIG_BLOCKS },
      rules: [rule('pay.a', { block: 'payment' }), rule('pay.b', { block: 'payment' })],
      statuses: [record('pay.b', 'pass-unverified')],
      graph: view(),
    });
    const [payment, auth] = response.blocks;
    expect(payment).toMatchObject({ id: 'payment', rules: 2, worstStatus: 'pass-unverified' });
    expect(auth).toMatchObject({ id: 'auth', rules: 0, worstStatus: null });

    const noRecords = computeBlocksResponse({
      config: { blocks: CONFIG_BLOCKS },
      rules: [rule('pay.a', { block: 'payment' })],
      statuses: [],
      graph: view(),
    });
    expect(noRecords.blocks[0]).toMatchObject({ id: 'payment', rules: 1, worstStatus: null });
  });

  it('규칙에만 있는 블록은 config 블록 뒤에 ID 순으로, declared: false. 블록 없는 규칙(common)은 블록이 아니다', () => {
    const response = computeBlocksResponse({
      config: { blocks: CONFIG_BLOCKS },
      rules: [
        rule('ship.a', { block: 'shipping' }),
        rule('inv.a', { block: 'inventory' }),
        rule('common.x', { block: undefined }),
        rule('lib.a', { block: 'lib' }),
      ],
      statuses: [record('ship.a', 'fail'), record('common.x', 'fail')],
      graph: view(),
    });
    expect(response.blocks.map((b) => b.id)).toEqual(['payment', 'auth', 'inventory', 'lib', 'shipping']);
    // 그래프에 없는 블록: 경로 · 공개 진입점은 비어 있고 파일 수 0. 그래프에 있는 블록(lib)은 그래프 값
    expect(response.blocks[4]).toMatchObject({
      id: 'shipping',
      declared: false,
      paths: [],
      public: ['index.ts'],
      files: 0,
      rules: 1,
      worstStatus: 'fail',
    });
    expect(response.blocks[3]).toMatchObject({ id: 'lib', declared: false, files: 3, paths: ['src/domains/lib/**'] });
    expect(response.blocks.some((b) => b.id === 'common')).toBe(false);
  });

  it('그래프 없음 → empty: no-graph, 미분류는 0이 아니라 측정 불가. 블록은 config · 규칙에서 — paths · public은 config 값', () => {
    const response = computeBlocksResponse({
      config: { blocks: CONFIG_BLOCKS },
      rules: [rule('pay.a', { block: 'payment' })],
      statuses: [record('pay.a', 'recheck')],
      graph: null,
    });
    expect(response.empty).toBe('no-graph');
    expect(response.unclassified).toBe(0);
    expect(response.blocks.map((b) => [b.id, b.worstStatus, b.rules])).toEqual([
      ['payment', 'recheck', 1],
      ['auth', null, 0],
    ]);
    expect(response.blocks[0]).toMatchObject({
      paths: ['src/domains/payment/**'],
      public: ['index.ts'],
      files: 0,
      declared: true,
    });
    expect(response.blocks[1]).toMatchObject({ paths: ['src/domains/auth/**'], public: ['index.ts'] });
  });

  it('config에 blocks가 없고 규칙도 없으면 빈 목록. 그래프가 있으면 미분류 수는 그대로', () => {
    const empty = computeBlocksResponse({ config: {}, rules: [], statuses: [], graph: view() });
    expect(empty).toEqual({ blocks: [], unclassified: 2 });

    const none = computeBlocksResponse({ config: {}, rules: [], statuses: [], graph: null });
    expect(none).toEqual({ blocks: [], unclassified: 0, empty: 'no-graph' });
  });

  it('그래프 노드의 label · shared · risk를 옮긴다 (config risk가 우선)', () => {
    const g = view();
    g.blocks = [
      ...g.blocks.filter((b) => b.id !== 'auth'),
      { ...block('auth', 'domain'), label: '인증', shared: true, risk: 'normal' },
    ];
    const response = computeBlocksResponse({
      config: { blocks: { auth: { include: ['x/**'], risk: 'high' }, payment: { include: ['y/**'] } } },
      rules: [],
      statuses: [],
      graph: g,
    });
    expect(response.blocks[0]).toMatchObject({ id: 'auth', label: '인증', shared: true, risk: 'high' });
    expect(response.blocks[1]?.label).toBeUndefined();
  });
});
