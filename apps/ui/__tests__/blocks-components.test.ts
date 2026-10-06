/**
 * 이슈 #121 "완료 증거" — `BlockTree` 렌더: `BlocksResponse` 모양의 값만 넣고 `renderToStaticMarkup`으로 그린다.
 * 블록 이름 · 상태 점(최악 상태, 규칙 없으면 ⬜) · 규칙 수 · 클릭 → `/rules?block=<id>` · 맨 아래 "미분류 n" · 그래프 없으면 "블록 아직 없음".
 * JSX 없이 `createElement`로 둔 것은 vitest 설정(`*.test.ts`)을 건드리지 않기 위해서다 (고전 JSX 런타임용 전역 `React`도 여기서만).
 */

import type { BlocksResponse } from '@plumb/core';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, title, children }: { href: string; title?: string; children: unknown }) =>
    createElement('a', { href, title }, children as never),
}));

import { BlockTree, blockHref, blockLineText } from '@/components/blocks/BlockTree';

(globalThis as { React?: typeof React }).React = React;
const { createElement } = React;

const node = (id: string, worstStatus: BlocksResponse['blocks'][number]['worstStatus'], rules: number) => ({
  id,
  level: 'L1' as const,
  kind: 'domain' as const,
  paths: [`src/domains/${id}/**`],
  public: [`src/domains/${id}/index.ts`],
  files: 3,
  declared: true,
  rules,
  worstStatus,
});

const render = (data: BlocksResponse) => renderToStaticMarkup(createElement(BlockTree, { data }));

describe('BlockTree', () => {
  it('블록 이름 · 상태 점 · 규칙 수, 클릭 → /rules?block=<id>, 맨 아래 미분류 n (payment 🟢 1 · auth ⬜ 0 · 미분류 2 ▲)', () => {
    const html = render({
      blocks: [node('payment', 'pass-verified', 1), node('auth', null, 0), node('shipping', 'fail', 3)],
      unclassified: 2,
    });
    expect(html).toContain('href="/rules?block=payment"');
    expect(html).toContain('href="/rules?block=auth"');
    expect(html).toContain('href="/rules?block=shipping"');
    expect(html).toContain('🟢');
    expect(html).toContain('⬜');
    expect(html).toContain('🔴');
    expect(html).toContain('<small>1</small>');
    expect(html).toContain('<small>0</small>');
    expect(html).toContain('<small>3</small>');
    expect(html).toContain('미분류 2 ▲');
    expect(html).not.toContain('블록 아직 없음');
    // 순서는 응답 순서 그대로
    expect(html.indexOf('payment')).toBeLessThan(html.indexOf('auth'));
    expect(html.indexOf('auth')).toBeLessThan(html.indexOf('shipping'));
  });

  it('미분류 0은 항상 보인다 (0이어도 숨기지 않는다). 블록이 없으면 안내 한 줄', () => {
    const html = render({ blocks: [], unclassified: 0 });
    expect(html).toContain('미분류 0');
    expect(html).not.toContain('▲');
    expect(html).toContain('선언된 블록 없음');
  });

  it('그래프 없음(empty: no-graph) → "블록 아직 없음", 미분류 수를 0으로 그리지 않는다', () => {
    const html = render({ blocks: [node('payment', null, 0)], unclassified: 0, empty: 'no-graph' });
    expect(html).toContain('블록 아직 없음');
    expect(html).toContain('plumb views');
    expect(html).not.toContain('미분류 0');
    expect(html).not.toContain('href="/rules?block=payment"');
  });

  it('blockLineText · blockHref — 사이드바 한 줄 글자와 링크', () => {
    expect(blockLineText(node('payment', 'pass-verified', 1))).toBe('payment 🟢 1');
    expect(blockLineText(node('auth', null, 0))).toBe('auth ⬜ 0');
    expect(blockLineText(node('billing', 'recheck', 2))).toBe('billing 🟠 2');
    expect(blockHref('payment')).toBe('/rules?block=payment');
    expect(blockHref('a b')).toBe('/rules?block=a%20b');
  });
});
