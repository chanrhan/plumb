import { describe, expect, it } from 'vitest';
import type { PlumbConfig, Rule } from '../../types/index.js';
import {
  TEST_WRITER_DISALLOWED,
  TEST_WRITER_TOOLS,
  testWriterOptions,
  testWriterSystemPrompt,
} from '../roles/test-writer.js';

const roles: PlumbConfig['roles'] = {
  'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
  implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
  injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
  'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
};
const rule: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
  scope: ['src/domains/payment/**'],
};
const input = {
  config: { roles, contracts: { openapi: 'openapi.yaml', prisma: 'prisma/schema.prisma' } },
  rules: [rule],
  cwd: '/svc',
  stubsDir: '.work/test-writer/stubs',
};

describe('testWriterOptions', () => {
  const opts = testWriterOptions(input);

  it('공통부 고정값 위에 test-writer 도구 집합: Bash 없음, 하위 에이전트·MCP 차단', () => {
    expect(opts.tools).toEqual([...TEST_WRITER_TOOLS]);
    expect(opts.tools).not.toContain('Bash');
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining([...TEST_WRITER_DISALLOWED, 'mcp__*', 'Agent', 'Task']),
    );
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.model).toBe('claude-sonnet-5-5');
    expect(opts.maxTurns).toBe(60);
  });

  it('PreToolUse 첫 hook이 경로 가드: src/** 읽기 deny, test/acceptance 쓰기 허용', async () => {
    const matcher = opts.hooks?.PreToolUse?.[0];
    expect(matcher?.hooks).toHaveLength(1);
    const guard = matcher?.hooks[0];
    if (!guard) throw new Error('guard 없음');
    const base = {
      session_id: 's',
      transcript_path: '/t',
      cwd: '/svc',
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'u',
    };
    const ctl = { signal: new AbortController().signal };
    const read = await guard(
      { ...base, tool_name: 'Read', tool_input: { file_path: 'src/domains/payment/refund.ts' } },
      'u',
      ctl,
    );
    expect(read).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const write = await guard(
      { ...base, tool_name: 'Write', tool_input: { file_path: 'test/acceptance/refund.spec.ts', content: '' } },
      'u',
      ctl,
    );
    expect(write).toEqual({});
    const badWrite = await guard(
      { ...base, tool_name: 'Write', tool_input: { file_path: 'src/x.ts', content: '' } },
      'u',
      ctl,
    );
    expect(badWrite).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('시스템 프롬프트에 규칙 진술 · 테스트 파일 · 스텁 경로 · 계약이 들어가고, 실패로 시작을 명시한다', () => {
    const prompt = testWriterSystemPrompt(input);
    expect(prompt).toContain(rule.statement);
    expect(prompt).toContain('test/acceptance/refund-window.property.spec.ts');
    expect(prompt).toContain('.work/test-writer/stubs');
    expect(prompt).toContain('openapi.yaml');
    expect(prompt).toMatch(/실패해야 정상/);
    expect(opts.systemPrompt).toEqual({ type: 'custom', prompt });
  });

  it('담당 규칙이 없으면 예외', () => {
    expect(() => testWriterOptions({ ...input, rules: [] })).toThrow(/담당 규칙/);
  });
});
