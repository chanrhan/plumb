/**
 * 이슈 #120 "완료 증거" — 목록 렌더: `ReviewQueueItem` 픽스처(`plumb run`이 `review-queue/`에 쓰는 모양)만 넣고 `renderToStaticMarkup`으로 그린다.
 * 종류 여섯 라벨 · 요지 · 규칙 링크 `/rules/<id>` · 실행 링크 `/runs?id=` · 생성 시각 · 열린 행의 `[처리]` · 처리된 행의 `처리됨` · 빈 목록 두 가지 ·
 * 필터(기본 열린 것만 · `show=resolved`). JSX 없이 `createElement`로 둔 것은 `runs-components.test.ts`와 같은 이유(vitest 설정을 건드리지 않는다).
 */

import type { ReviewQueueItem } from '@plumb/core';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));

import { QUEUE_KIND_LABEL, queueHeadline, queueTime } from '@/components/queue/format';
import { QueueList } from '@/components/queue/queue-list';
import { ResolveButton } from '@/components/queue/resolve-button';
import { applyReviewQueueFilter, parseResolveBody, parseReviewQueueFilter } from '@/lib/queue';

(globalThis as { React?: typeof React }).React = React;
const { createElement } = React;
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** r-0001의 이의 제기 — 열린 항목 (work-run 2절 "이의 제기가 있을 때 그 줄") */
const DISPUTE: ReviewQueueItem = {
  id: 'q-0001',
  kind: 'dispute',
  ruleIds: ['pay.refund-window'],
  runId: 'r-0001',
  summary: 'refund-window.property.spec.ts 의 경계값(7일 정각)이 규칙과 다름',
  createdAt: '2026-10-02T05:10:00.000Z',
};

/** 처리된 실행 실패 */
const FAILED: ReviewQueueItem = {
  id: 'q-0002',
  kind: 'run-failed',
  ruleIds: ['pay.refund-window', 'pay.payment-record'],
  runId: 'r-0002',
  summary: '실행 실패: stopBlockLimit',
  createdAt: '2026-10-02T06:00:00.000Z',
  resolvedAt: '2026-10-02T07:00:00.000Z',
};

/** 설계 변경 — 실행 · 규칙 없이 결정 기록만 */
const DESIGN: ReviewQueueItem = {
  id: 'q-0003',
  kind: 'design-change',
  ruleIds: [],
  decisionId: 'D-0002',
  summary: '블록 경계 변경: payment → payment · refund',
  createdAt: '2026-10-03T01:00:00.000Z',
};

describe('format', () => {
  it('여섯 종류 전부 라벨이 있다', () => {
    expect(Object.keys(QUEUE_KIND_LABEL).sort()).toEqual(
      ['budget-exceeded', 'design-change', 'dispute', 'interpretation', 'run-failed', 'undetermined-injection'].sort(),
    );
    expect(QUEUE_KIND_LABEL.dispute).toBe('이의 제기');
    expect(QUEUE_KIND_LABEL['undetermined-injection']).toBe('미확정 주입');
  });

  it('머리줄 "⚠ 열린 n건 · 처리됨 n건", 시각은 MM-DD HH:mm', () => {
    expect(queueHeadline([DISPUTE, FAILED, DESIGN])).toBe('⚠ 열린 2건 · 처리됨 1건');
    expect(queueHeadline([])).toBe('⚠ 열린 0건 · 처리됨 0건');
    expect(queueTime('2026-10-02T05:10:00.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(queueTime('not a date')).toBe('not a date');
  });
});

describe('필터 (lib/queue)', () => {
  it('기본은 열린 것만, show=resolved면 전부, 모르는 값은 버린다', () => {
    const all = [DISPUTE, FAILED, DESIGN];
    expect(parseReviewQueueFilter({})).toEqual({});
    expect(parseReviewQueueFilter({ show: 'resolved', id: 'q-0001' })).toEqual({ show: 'resolved', id: 'q-0001' });
    expect(parseReviewQueueFilter({ show: 'everything', id: 'nope' })).toEqual({});
    expect(applyReviewQueueFilter(all, {}).map((i) => i.id)).toEqual(['q-0001', 'q-0003']);
    expect(applyReviewQueueFilter(all, { show: 'resolved' }).map((i) => i.id)).toEqual(['q-0001', 'q-0002', 'q-0003']);
  });

  it('처리 본문: 비어 있어도 되고, by · note는 있으면 문자열', () => {
    expect(parseResolveBody(undefined)).toEqual({});
    expect(parseResolveBody({})).toEqual({});
    expect(parseResolveBody({ by: 'ui', note: 'ok' })).toEqual({ by: 'ui', note: 'ok' });
    expect(parseResolveBody([])).toMatchObject({ status: 400, code: 'invalid-body' });
    expect(parseResolveBody({ by: ' ' })).toMatchObject({ status: 400 });
    expect(parseResolveBody({ note: 3 })).toMatchObject({ status: 400 });
  });
});

describe('QueueList', () => {
  it('전체가 비면 "검토 대기열 아직 없음", 열린 것만 비면 "열린 항목 없음" + 처리됨 보기 링크', () => {
    expect(render(createElement(QueueList, { items: [], totalCount: 0 }))).toContain('검토 대기열 아직 없음');
    const none = render(createElement(QueueList, { items: [], totalCount: 1 }));
    expect(none).toContain('열린 항목 없음');
    expect(none).toContain('href="/queue?show=resolved"');
  });

  it('행: ⚠ id · 종류 · 요지 · 규칙 링크 · 실행 링크 /runs?id= · 생성 시각 · [처리]', () => {
    const html = render(createElement(QueueList, { items: [DISPUTE], totalCount: 1 }));
    expect(html).toContain('⚠ q-0001');
    expect(html).toContain('<td>이의 제기</td>');
    expect(html).toContain('경계값(7일 정각)이 규칙과 다름');
    expect(html).toContain('href="/rules/pay.refund-window"');
    expect(html).toContain('href="/runs?id=r-0001"');
    expect(html).toContain(queueTime(DISPUTE.createdAt));
    expect(html).toContain('>처리</button>');
    expect(html).toContain('data-open="true"');
    expect(html).not.toContain('처리됨');
  });

  it('처리된 행은 [처리] 없이 "처리됨 <시각>", 규칙 여럿은 · 로, 실행 없으면 —, 결정 ID는 규칙 열에', () => {
    const html = render(createElement(QueueList, { items: [FAILED, DESIGN], totalCount: 3 }));
    expect(html).toContain('data-open="false"');
    expect(html).toContain(`처리됨 ${queueTime(FAILED.resolvedAt ?? '')}`);
    expect(html).toContain('href="/rules/pay.refund-window"');
    expect(html).toContain('href="/rules/pay.payment-record"');
    expect(html).toContain(' · ');
    expect(html).toContain('<td>설계 변경</td>');
    expect(html).toContain('D-0002');
    expect(html).toContain('<td>—</td>'); // 설계 변경에는 실행 없음
    // [처리] 버튼은 열린 설계 변경 하나뿐
    expect(html.match(/>처리<\/button>/g)).toHaveLength(1);
  });

  it('ResolveButton 단독 — 활성 버튼, 결과 줄 없음', () => {
    const html = render(createElement(ResolveButton, { id: 'q-0001' }));
    expect(html).toContain('<button type="button">처리</button>');
    expect(html).not.toContain('role="alert"');
  });
});
