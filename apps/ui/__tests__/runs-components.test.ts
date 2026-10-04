/**
 * 이슈 #89 "완료 증거" — 컴포넌트 렌더: 상태 파일 픽스처(`RunState`)만 넣고 `renderToStaticMarkup`으로 그린다.
 * 단계 ✔ ● 빈칸 · "2회차" · 이의 제기 ⚠ n건 · 역할별 사용량 · 예산 · 출력 꼬리 / "아직 실행 출력 없음" · 종료 줄 네 가지 · 빈 목록 ·
 * 새 실행 패널(승인 0개 비활성 · 진행 중 비활성 · 상한 없음). 목 데이터가 아니라 `plumb run`이 쓰는 모양의 상태 파일이다.
 * JSX 없이 `createElement`로 둔 것은 vitest 설정(`*.test.ts`)을 건드리지 않기 위해서다 (고전 JSX 런타임용 전역 `React`도 여기서만).
 */

import type { RunState, RunSummary } from '@plumb/core';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 클라이언트 컴포넌트가 쓰는 Next 훅 · 링크 — 정적 렌더에는 라우터가 없다
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));

import { limitsText, NewRunPanel } from '@/components/runs/new-run-panel';
import { OutputTail } from '@/components/runs/output-tail';
import { budgetText, RoleUsage } from '@/components/runs/role-usage';
import { outcomeText, RunDetail } from '@/components/runs/run-detail';
import { RunList } from '@/components/runs/run-list';
import { StageTrack, stageRows } from '@/components/runs/stage-track';

// tsconfig의 `jsx: preserve` 때문에 vitest(esbuild)는 컴포넌트의 JSX를 고전 런타임(`React.createElement`)으로 바꾼다 — 전역 React를 둔다
(globalThis as { React?: typeof React }).React = React;
const { createElement } = React;

const usage = { turns: 0, stopBlocks: 0, consecutiveStopBlocks: 0, costUsd: null };

/** 단계 ③ 진행 중 — 와이어프레임의 r-0003 */
const RUNNING: RunState = {
  id: 'r-0003',
  pid: 4812,
  status: 'running',
  stage: 3,
  stages: [
    {
      stage: 1,
      attempt: 1,
      role: null,
      startedAt: '2026-10-02T05:01:00.000Z',
      finishedAt: '2026-10-02T05:01:00.100Z',
      result: { stage: 1, approvedAt: { 'pay.refund-window': '2026-10-02T05:01:00.000Z' } },
    },
    {
      stage: 2,
      attempt: 1,
      role: 'test-writer',
      startedAt: '2026-10-02T05:03:00.000Z',
      finishedAt: '2026-10-02T05:07:00.000Z',
      result: { stage: 2, tests: { total: 1, passed: 0, failed: 1 }, allFailed: true },
    },
    { stage: 3, attempt: 1, role: 'implementer', startedAt: '2026-10-02T05:07:00.000Z' },
  ],
  currentRole: 'implementer',
  ruleIds: ['pay.refund-window'],
  roles: {
    'test-writer': { ...usage, turns: 5, stopBlocks: 1 },
    implementer: { ...usage, turns: 7, stopBlocks: 2, consecutiveStopBlocks: 2 },
    injector: usage,
    'rule-drafter': usage,
  },
  costUsd: 3.2,
  limits: { maxBudgetUsd: 10, stopBlockLimit: 5, maxTurns: { 'test-writer': 40, implementer: 40, injector: 40 } },
  disputes: [],
  startedAt: '2026-10-02T05:01:00.000Z',
  updatedAt: '2026-10-02T05:15:00.000Z',
  capturedOutput: {
    command: 'pnpm vitest run --reporter=junit',
    startedAt: '2026-10-02T05:14:58.000Z',
    finishedAt: '2026-10-02T05:15:02.000Z',
    exitCode: 1,
    tail: [
      'FAIL test/acceptance/refund-window.property.spec.ts',
      '  ✗ rejects refund after 7 days',
      'Tests  1 failed · 1 total',
    ],
    logPath: '/store/runs/r-0003/output.log',
  },
};

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const markOf = (html: string, stage: number) => {
  const m = new RegExp(`data-stage="${stage}" data-kind="([a-z]+)"`).exec(html);
  return m?.[1];
};

describe('StageTrack — ✔ ● 빈칸', () => {
  it('stage 3 진행 중: ① ✔ · ② ✔ 🔴 1/1 실패 · ③ ● · ④⑤⑥ 빈칸', () => {
    expect(stageRows(RUNNING).map((r) => r.kind)).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending']);
    const html = render(createElement(StageTrack, { state: RUNNING }));
    expect(html).toContain('① 승인');
    expect(html).toContain('🔴 1/1 실패');
    expect(html).toContain('⑤ 위반 주입'); // 자리만
    expect(html).toContain('⑥ View 갱신');
    expect(markOf(html, 1)).toBe('done');
    expect(markOf(html, 3)).toBe('active');
    expect(markOf(html, 6)).toBe('pending');
    expect(html).not.toContain('회차');
  });

  it('⑤에서 ②로 되돌아간 기록(attempt 2)은 가장 최근 항목으로 그리고 "2회차"를 붙인다', () => {
    const state: RunState = {
      ...RUNNING,
      stage: 2,
      currentRole: 'test-writer',
      stages: [
        ...RUNNING.stages.map((s) => ({ ...s, finishedAt: s.finishedAt ?? '2026-10-02T05:20:00.000Z' })),
        {
          stage: 4,
          attempt: 1,
          role: null,
          startedAt: '2026-10-02T05:20:00.000Z',
          finishedAt: '2026-10-02T05:21:00.000Z',
        },
        {
          stage: 5,
          attempt: 1,
          role: 'injector',
          startedAt: '2026-10-02T05:21:00.000Z',
          finishedAt: '2026-10-02T05:25:00.000Z',
          result: { stage: 5, injections: 1, caught: 0, weak: true },
        },
        { stage: 2, attempt: 2, role: 'test-writer', startedAt: '2026-10-02T05:25:00.000Z' },
      ],
    };
    const html = render(createElement(StageTrack, { state }));
    expect(markOf(html, 2)).toBe('active');
    expect(html).toContain('2회차');
    expect(html).toContain('주입 1건 · 잡힘 0건 · 약함 → ②');
    expect(markOf(html, 3)).toBe('done'); // 1회차 ③은 끝난 기록 그대로
  });

  it('끝난 실행의 멈춘 단계는 "● 멈춤"', () => {
    const state: RunState = { ...RUNNING, status: 'failed', finishedAt: '2026-10-02T05:31:00.000Z' };
    const html = render(createElement(StageTrack, { state }));
    expect(markOf(html, 3)).toBe('stopped');
    expect(html).toContain('● 멈춤');
  });
});

describe('RoleUsage · 예산', () => {
  it('현재 역할 implementer · 반복 7 / 40 · 차단 2 / 5, injector는 —, 예산 $3.20 / $10.00 32%', () => {
    const html = render(createElement(RoleUsage, { state: RUNNING }));
    expect(html).toContain('현재 역할 <strong>implementer</strong>');
    expect(html).toContain('반복 7 / 40');
    expect(html).toContain('종료 차단 2 / 5');
    expect(html).toContain('<td>injector</td><td>—</td><td>—</td>');
    expect(html).toContain('<td>test-writer</td><td>5 / 40</td><td>1 / 5</td>');
    expect(budgetText(RUNNING)).toBe('예산 $3.20 (추정) / $10.00 ▓▓▓░░░░░░░ 32%');
    expect(html).not.toContain('rule-drafter'); // 사용량 없는 네 번째 역할은 숨긴다
  });

  it('costUsd null → "예산 — / $10.00 (비용 정보 없음)" (0으로 보이지 않는다)', () => {
    expect(budgetText({ ...RUNNING, costUsd: null })).toBe('예산 — / $10.00 (비용 정보 없음)');
    expect(budgetText({ ...RUNNING, costUsd: null })).not.toContain('$0.00');
  });
});

describe('OutputTail', () => {
  it('가로챈 출력 꼬리 + 시각 · exit code', () => {
    const html = render(createElement(OutputTail, { output: RUNNING.capturedOutput }));
    expect(html).toContain('│ FAIL test/acceptance/refund-window.property.spec.ts');
    expect(html).toContain('· exit 1');
    expect(html).toContain('pnpm vitest run --reporter=junit');
  });

  it('없으면 "아직 실행 출력 없음"', () => {
    expect(render(createElement(OutputTail, { output: undefined }))).toContain('아직 실행 출력 없음');
  });
});

describe('RunDetail — 전체 조립', () => {
  const props = { id: RUNNING.id, ruleStatus: { 'pay.refund-window': 'fail' as const } };

  it('진행 중: 머리(id · pid) · 대상 규칙 링크 🔴 · 이의 제기 없음 · 종료 — · [중단]', () => {
    const html = render(createElement(RunDetail, { ...props, initial: RUNNING }));
    expect(html).toContain('r-0003');
    expect(html).toContain('pid 4812');
    expect(html).toContain('href="/rules/pay.refund-window"');
    expect(html).toContain('🔴');
    expect(html).toContain('이의 제기: 없음');
    expect(html).toContain('종료: — (진행 중)');
    expect(html).toContain('>중단</button>');
    expect(html).toContain('마지막 갱신 —'); // 시계는 effect에서만 — 정적 렌더는 결정적
  });

  it('이의 제기 1건 → "⚠ 1건" + 시각 · implementer → test-writer · 재검토 중 · 요지', () => {
    const state: RunState = {
      ...RUNNING,
      disputes: [
        {
          id: 'd-0001',
          at: '2026-10-02T05:10:00.000Z',
          by: 'implementer',
          reviewer: 'test-writer',
          summary: 'refund-window.property.spec.ts 의 경계값(7일 정각)이 규칙과 다름',
          file: '.work/implementer/disputes/d-0001.md',
          status: 'reviewing',
        },
      ],
    };
    const html = render(createElement(RunDetail, { ...props, initial: state }));
    expect(html).toContain('이의 제기: ⚠ 1건');
    expect(html).toContain('implementer → test-writer 재검토 중');
    expect(html).toContain('경계값(7일 정각)이 규칙과 다름');
    expect(html).not.toContain('이의 제기: 없음');
  });

  it('검토 대기열에 올라간 이의 제기는 "검토 대기열에 올라감" + 재검토(참고용)', () => {
    const state: RunState = {
      ...RUNNING,
      disputes: [
        {
          id: 'd-0002',
          at: '2026-10-02T05:10:00.000Z',
          by: 'implementer',
          reviewer: 'test-writer',
          summary: '요지',
          file: 'x.md',
          status: 'queued',
          advisory: { by: 'test-writer', at: '2026-10-02T05:12:00.000Z', verdict: 'ambiguous' },
          queueItemId: 'q-0001',
        },
      ],
    };
    const html = render(createElement(RunDetail, { ...props, initial: state }));
    expect(html).toContain('검토 대기열에 올라감');
    expect(html).toContain('재검토(참고용): ambiguous');
  });

  it('종료 줄 네 가지 (실패 · 예산 초과는 → 검토 대기열), 끝나면 [중단] 없음', () => {
    const finishedAt = '2026-10-02T05:31:00.000Z';
    const done = (outcome: RunState['outcome'], status: RunState['status']): RunState => ({
      ...RUNNING,
      status,
      finishedAt,
      currentRole: null,
      ...(outcome === undefined ? {} : { outcome }),
    });
    expect(outcomeText(done({ status: 'completed', finishedAt }, 'completed'))).toMatch(
      /^종료: 완료 \d\d:\d\d \(30분\)$/,
    );
    expect(
      outcomeText(
        done(
          { status: 'failed', finishedAt, reason: 'stopBlockLimit', role: 'implementer', queueItemId: 'q-0001' },
          'failed',
        ),
      ),
    ).toContain('실패');
    expect(
      outcomeText(
        done(
          { status: 'failed', finishedAt, reason: 'stopBlockLimit', role: 'implementer', queueItemId: 'q-0001' },
          'failed',
        ),
      ),
    ).toContain('(stopBlockLimit) · implementer → 검토 대기열 q-0001');
    expect(
      outcomeText(
        done(
          { status: 'budget-exceeded', finishedAt, costUsd: 10.02, maxBudgetUsd: 10, queueItemId: 'q-0002' },
          'budget-exceeded',
        ),
      ),
    ).toContain('예산 초과');
    expect(
      outcomeText(
        done(
          { status: 'budget-exceeded', finishedAt, costUsd: 10.02, maxBudgetUsd: 10, queueItemId: 'q-0002' },
          'budget-exceeded',
        ),
      ),
    ).toContain('$10.02 / $10.00 → 검토 대기열 q-0002');
    expect(outcomeText(done({ status: 'aborted', finishedAt, by: 'user', signal: 'SIGTERM' }, 'aborted'))).toContain(
      '중단',
    );
    expect(outcomeText(done({ status: 'aborted', finishedAt, by: 'user', signal: 'SIGTERM' }, 'aborted'))).toContain(
      '사용자 (SIGTERM)',
    );

    const html = render(
      createElement(RunDetail, { ...props, initial: done({ status: 'completed', finishedAt }, 'completed') }),
    );
    expect(html).not.toContain('>중단</button>');
    expect(html).toContain('종료: 완료');
  });

  it('spawn 직후(단계 ② 전): ① ✔ · ② 빈칸 · 역할 — · 비용 정보 없음 · 아직 실행 출력 없음', () => {
    const fresh: RunState = {
      ...RUNNING,
      stage: 1,
      stages: [],
      currentRole: null,
      roles: { 'test-writer': usage, implementer: usage, injector: usage, 'rule-drafter': usage },
      costUsd: null,
      capturedOutput: undefined,
    };
    const html = render(createElement(RunDetail, { ...props, initial: fresh }));
    expect(markOf(html, 1)).toBe('active'); // 아직 기록이 없으면 현재 단계 ①이 ●
    expect(markOf(html, 2)).toBe('pending');
    expect(html).toContain('현재 역할 <strong>—</strong>');
    expect(html).toContain('비용 정보 없음');
    expect(html).toContain('아직 실행 출력 없음');
  });

  it('첫 상태를 못 읽었으면(찢긴 파일) "진행 파일을 읽는 중…"', () => {
    const html = render(createElement(RunDetail, { ...props, initial: null }));
    expect(html).toContain('진행 파일을 읽는 중');
  });
});

describe('RunList', () => {
  it('빈 목록 → "실행 아직 없음"', () => {
    expect(render(createElement(RunList, { initial: [] }))).toContain('실행 아직 없음');
  });

  it('행: ID 링크 · 상태 라벨 · 단계 ①~⑥, 선택 행은 aria-current', () => {
    const runs: RunSummary[] = [
      {
        id: 'r-0003',
        status: 'running',
        stage: 3,
        startedAt: '2026-10-02T05:03:00.000Z',
        ruleIds: ['pay.refund-window'],
      },
      {
        id: 'r-0002',
        status: 'completed',
        stage: 4,
        startedAt: '2026-10-01T01:00:00.000Z',
        finishedAt: '2026-10-01T01:30:00.000Z',
        ruleIds: ['pay.refund-window'],
      },
      { id: 'r-0001', status: 'budget-exceeded', stage: 3, startedAt: '2026-10-01T00:00:00.000Z', ruleIds: [] },
    ];
    const html = render(createElement(RunList, { initial: runs, selectedId: 'r-0003' }));
    expect(html).toContain('href="/runs?id=r-0003"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('<td>진행중</td><td>③</td>');
    expect(html).toContain('<td>완료</td><td>④</td>');
    expect(html).toContain('<td>예산초과</td><td>③</td>');
  });
});

describe('NewRunPanel', () => {
  const limits = { maxBudgetUsd: 10, stopBlockLimit: 5, maxTurns: { 'test-writer': 40 as number } };
  const rules = [
    { id: 'pay.refund-window' as const, status: 'fail' as const, approval: 'approved' as const },
    { id: 'auth.logout-inval' as const, status: 'unchecked' as const, approval: 'provisional' as const },
  ];

  it('승인된 규칙이 있으면 버튼 활성 (패널은 닫혀 있다)', () => {
    const html = render(createElement(NewRunPanel, { rules, limits }));
    expect(html).toContain('▶ 새 실행');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('규칙 선택');
  });

  it('승인된 규칙 0개 → 비활성 + 안내, 규칙 0개 → "규칙이 없습니다", 진행 중 → "r-0003 이 진행 중"', () => {
    const none = render(createElement(NewRunPanel, { rules: [rules[1] as (typeof rules)[number]], limits }));
    expect(none).toContain('disabled=""');
    expect(none).toContain('승인된 규칙이 없습니다. /rules 에서 승인하세요');

    expect(render(createElement(NewRunPanel, { rules: [], limits }))).toContain('규칙이 없습니다');

    const busy = render(createElement(NewRunPanel, { rules, limits, activeRunId: 'r-0003' }));
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('r-0003 이 진행 중');
  });

  it('상한 줄: 예산 · maxTurns · stopBlockLimit, run.maxBudgetUsd 없으면 "상한 없음 (…)"', () => {
    expect(limitsText(limits)).toBe('예산 상한 $10.00 · 역할별 maxTurns test-writer 40 · stopBlockLimit 5');
    expect(limitsText({ stopBlockLimit: 5, maxTurns: {} })).toBe(
      '상한 없음 (plumb.config.json 에 run.maxBudgetUsd 를 적으세요) · 역할별 maxTurns — · stopBlockLimit 5',
    );
  });
});
