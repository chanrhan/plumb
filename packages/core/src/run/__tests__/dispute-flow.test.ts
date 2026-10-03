import { describe, expect, it } from 'vitest';
import {
  parseReviewOutput,
  REVIEW_OUTPUT_SCHEMA,
  TEST_WRITER_REVIEW_TOOLS,
  testWriterReviewOptions,
} from '../../harness/roles/test-writer.js';
import type { RoleRunResult, RunRoleInput } from '../../harness/run-role.js';
import type { Dispute, ReviewQueueItem, Rule } from '../../types/index.js';
import { handleDisputes } from '../dispute-flow.js';

const RULE: Rule = {
  id: 'pay.refund-window',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};
const roles = {
  'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
  implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
  injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
  'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
};
const dispute: Dispute = {
  id: 'd-boundary',
  at: 't',
  by: 'implementer',
  reviewer: 'test-writer',
  summary: '7일 경계 해석이 테스트와 규칙에서 다르다',
  file: '/w/.work/implementer/disputes/d-boundary.md',
  status: 'reviewing',
};

function fakeQueue() {
  const items: ReviewQueueItem[] = [];
  return {
    items,
    store: {
      reviewQueue: {
        enqueue: async (input: Omit<ReviewQueueItem, 'id' | 'createdAt'>) => {
          const item = {
            ...input,
            id: `q-${String(items.length + 1).padStart(4, '0')}`,
            createdAt: 't',
          } as ReviewQueueItem;
          items.push(item);
          return item;
        },
      },
    } as never,
  };
}
const roleResult = (structured: unknown, answer = ''): RoleRunResult =>
  ({
    outcome: 'success',
    ok: true,
    turns: 2,
    costUsd: 0.02,
    permissionDenials: 0,
    durationMs: 1,
    result: { subtype: 'success', structured_output: structured } as never,
    answer,
  }) as unknown as RoleRunResult;

describe('testWriterReviewOptions', () => {
  it('읽기 전용 도구 · src/** 가드 · 구조화 출력 · 짧은 턴, 공통부 고정값 유지', async () => {
    const opts = testWriterReviewOptions({
      config: { roles },
      rule: RULE,
      dispute: { summary: 's', body: 'b' },
      cwd: '/w',
    });
    expect(opts.tools).toEqual([...TEST_WRITER_REVIEW_TOOLS]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash', 'mcp__*', 'Agent']));
    expect(opts.outputFormat).toEqual({ type: 'json_schema', schema: REVIEW_OUTPUT_SCHEMA });
    expect(opts.maxTurns).toBe(8);
    expect(opts.strictMcpConfig).toBe(true);
    const guard = opts.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!guard) throw new Error('guard 없음');
    const base = {
      session_id: 's',
      transcript_path: '/t',
      cwd: '/w',
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'u',
    };
    expect(
      await guard({ ...base, tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'u', {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(
      await guard({ ...base, tool_name: 'Read', tool_input: { file_path: 'test/acceptance/a.spec.ts' } }, 'u', {
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    expect((opts.systemPrompt as { prompt: string }).prompt).toMatch(/advisory/);
  });
});

describe('parseReviewOutput', () => {
  it('유효한 판정은 그대로, 모양이 어긋나면 ambiguous', () => {
    expect(parseReviewOutput({ verdict: 'test-wrong', reason: '경계', evidenceInput: '정확히 7일' })).toEqual({
      verdict: 'test-wrong',
      reason: '경계',
      evidenceInput: '정확히 7일',
    });
    expect(parseReviewOutput({ verdict: 'test-correct', reason: '' })).toEqual({
      verdict: 'test-correct',
      reason: '(근거 없음)',
    });
    expect(parseReviewOutput({ verdict: 'nope' })).toMatchObject({
      verdict: 'ambiguous',
      reason: expect.stringContaining('해석하지 못했다'),
    });
    expect(parseReviewOutput(undefined).verdict).toBe('ambiguous');
  });
});

describe('handleDisputes', () => {
  const base = (runRole: (i: RunRoleInput) => Promise<RoleRunResult>) => {
    const q = fakeQueue();
    const input = {
      config: { roles },
      store: q.store,
      rules: [RULE],
      disputes: [dispute],
      readFile: async () => '요약\n\n근거 본문',
      cwd: '/w',
      runId: 'r-0001' as const,
      runRole,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
      log: () => {},
    };
    return { q, input };
  };

  it('재검토 판정을 advisory에 적고 검토 대기열(kind dispute)에 올리며 status queued', async () => {
    const calls: RunRoleInput[] = [];
    const { q, input } = base(async (i) => {
      calls.push(i);
      return roleResult({ verdict: 'test-wrong', reason: '7일째를 거절로 기대', evidenceInput: 'paidAt+7d' });
    });
    const [r] = await handleDisputes(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.outputFormat).toMatchObject({ type: 'json_schema' });
    expect(r?.dispute).toMatchObject({
      status: 'queued',
      queueItemId: 'q-0001',
      advisory: {
        by: 'test-writer',
        verdict: 'test-wrong',
        evidenceInput: 'paidAt+7d',
        at: '2026-10-03T00:00:00.000Z',
      },
    });
    expect(q.items[0]).toMatchObject({
      kind: 'dispute',
      runId: 'r-0001',
      ruleIds: [RULE.id],
      summary: expect.stringContaining('재검토: test-wrong'),
    });
    expect(r?.usage).toEqual({ turns: 2, costUsd: 0.02 });
  });

  it('구조화 출력이 없으면 답 텍스트의 JSON을, 그것도 없으면 ambiguous — 그래도 대기열에 올라간다', async () => {
    const a = base(async () => roleResult(undefined, '판정: {"verdict":"test-correct","reason":"진술 그대로"}'));
    expect((await handleDisputes(a.input))[0]?.dispute.advisory?.verdict).toBe('test-correct');
    const b = base(async () => {
      throw new Error('SDK 죽음');
    });
    const [r] = await handleDisputes(b.input);
    expect(r?.dispute.advisory?.verdict).toBe('ambiguous');
    expect(r?.review?.reason).toMatch(/재검토 실행 실패/);
    expect(b.q.items).toHaveLength(1);
  });

  it('reviewing 아닌 항목은 건너뛴다', async () => {
    const { q, input } = base(async () => roleResult({ verdict: 'test-correct', reason: 'x' }));
    const out = await handleDisputes({ ...input, disputes: [{ ...dispute, status: 'queued' }] });
    expect(out).toEqual([]);
    expect(q.items).toHaveLength(0);
  });
});
