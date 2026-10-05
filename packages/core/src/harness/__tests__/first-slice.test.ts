import { describe, expect, it } from 'vitest';
import type { RunState, Validity } from '../../types/index.js';
import {
  judgeAgentCannotApprove,
  judgeCompletion,
  judgeInjection,
  judgeIsolation,
  parseIsolationOutput,
  renderTable,
} from '../first-slice.js';

const ISO = `| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | test-writer src/** Read → deny | ✅ | x |
| 6 | test-writer MCP 0 | ✅ | x |
| 6 | implementer MCP 0 | ✅ | x |
| 8 | 틀린 구현 → Stop block ≥ 1 | ✅ | [stop] block (1/2) |
| 10 | injector | ❌ | (deny 없음) |

[isolation-test] 11/12 ✅ · outcomes success · 총비용 $0.06 · wall 24848ms`;

function run(over: Partial<RunState> = {}): RunState {
  const stage = (n: 1 | 2 | 3 | 4 | 5 | 6, result?: unknown) =>
    ({
      stage: n,
      attempt: 1,
      role: null,
      startedAt: 't',
      finishedAt: 't',
      ...(result ? { result } : {}),
    }) as RunState['stages'][number];
  return {
    id: 'r-0001',
    pid: 1,
    status: 'completed',
    stage: 6,
    stages: [
      stage(1),
      stage(2),
      stage(3),
      stage(4),
      stage(5, { stage: 5, injections: 1, caught: 1, weak: false }),
      stage(6),
    ],
    currentRole: null,
    ruleIds: ['pay.refund-window'],
    roles: {} as RunState['roles'],
    costUsd: 0.5,
    limits: { maxBudgetUsd: 3, stopBlockLimit: 5, maxTurns: {} },
    disputes: [],
    startedAt: 't',
    updatedAt: 't',
    ...over,
  };
}

describe('first-slice 판정 (§15.1)', () => {
  it('격리 시험 출력 파싱: 합계 + 항목별(같은 번호는 AND)', () => {
    const s = parseIsolationOutput(ISO);
    expect(s).toMatchObject({ passed: 11, total: 12 });
    expect(s?.items.get(8)).toBe(true);
    expect(s?.items.get(10)).toBe(false);
    expect(s?.items.get(6)).toBe(true);
    expect(parseIsolationOutput('garbage')).toBeUndefined();
  });

  it('① 완주: completed + stages 1~6 전부 finishedAt', () => {
    expect(judgeCompletion(run()).ok).toBe(true);
    expect(judgeCompletion(run({ stages: run().stages.slice(0, 4) }))).toMatchObject({
      ok: false,
      detail: expect.stringContaining('미완 56'),
    });
    expect(judgeCompletion(run({ status: 'failed' })).ok).toBe(false);
    expect(judgeCompletion(undefined).ok).toBe(false);
  });

  it('② ③ 격리 · 종료 조건', () => {
    const [c2, c3] = judgeIsolation(parseIsolationOutput(ISO));
    expect(c2).toMatchObject({ ok: false, detail: '11/12 ✅' });
    expect(c3).toMatchObject({ ok: true });
    const [d2, d3] = judgeIsolation(undefined);
    expect(d2.ok).toBe(false);
    expect(d3.ok).toBe(false);
  });

  it('⑤ 에이전트 승인 불가: Bash 가드 판정 deny가 정본, 세션 거부 로그는 참고, fetch는 401 또는 건너뜀', () => {
    const deny = { allow: false, rule: '네트워크 도구' };
    expect(
      judgeAgentCannotApprove({ guard: deny, sessionDenyLine: '[hook] deny Bash "curl …"', fetchStatus: 401 }).ok,
    ).toBe(true);
    // 모델이 도구를 안 불러 거부 로그가 없어도 가드 판정이 deny면 ✅ — 상세에 "참고"로 남는다
    const quiet = judgeAgentCannotApprove({ guard: deny, fetchStatus: 'skipped' });
    expect(quiet.ok).toBe(true);
    expect(quiet.detail).toContain('거부 로그 없음');
    expect(judgeAgentCannotApprove({ guard: deny, fetchStatus: 200 }).ok).toBe(false);
    expect(judgeAgentCannotApprove({ guard: { allow: true }, sessionDenyLine: 'x', fetchStatus: 401 }).ok).toBe(false);
  });

  it('M7 종료 증거: stage 5 caught ≥ 1 + 최신 주입 valid', () => {
    const v: Validity = {
      id: 'i-0001',
      ruleId: 'pay.refund-window',
      description: '7일 검사 제거',
      commit: 'c',
      at: 't',
      checkFileHashes: {},
      result: 'check-failed',
      valid: true,
    };
    expect(judgeInjection(run(), v).ok).toBe(true);
    expect(judgeInjection(run(), { ...v, result: 'check-passed', valid: false }).ok).toBe(false);
    expect(judgeInjection(run(), undefined).ok).toBe(false);
  });

  it('표 렌더', () => {
    const t = renderTable([judgeCompletion(run())]);
    expect(t).toMatch(/^\| # \| 기준 \| 결과 \| 근거 \|/);
    expect(t).toMatch(/\| ① \| 사람 개입 없이 완주 \| ✅ \|/);
  });
});
