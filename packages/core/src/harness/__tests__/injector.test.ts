import { describe, expect, it } from 'vitest';
import type { PlumbConfig, Rule } from '../../types/index.js';
import { decidePath } from '../path-guard.js';
import {
  INJECTION_OUTPUT_SCHEMA,
  INJECTOR_TOOLS,
  injectorOptions,
  injectorPathRules,
  injectorWriteGlobs,
  parseInjectionOutput,
} from '../roles/injector.js';

const roles: PlumbConfig['roles'] = {
  'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
  implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
  injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
  'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
};
const blocks = { payment: { include: ['src/domains/payment/**'], dependsOn: [], risk: 'high' as const } };
const rule: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};

describe('injector 쓰기 범위', () => {
  it('rule.scope → 블록 include → src/** 순', () => {
    expect(injectorWriteGlobs({ ...rule, scope: ['src/domains/payment/payment.ts'] }, { blocks })).toEqual([
      'src/domains/payment/payment.ts',
    ]);
    expect(injectorWriteGlobs(rule, { blocks })).toEqual(['src/domains/payment/**']);
    expect(injectorWriteGlobs({ ...rule, block: undefined }, {})).toEqual(['src/**']);
  });
  it('test/** 읽기 거부 · 범위 안 src만 쓰기 · 테스트 파일은 범위 안이라도 쓰기 거부', () => {
    const cfg = { root: '/w', rules: injectorPathRules(rule, { blocks }) };
    expect(decidePath(cfg, 'Read', { file_path: 'test/acceptance/a.spec.ts' }).allow).toBe(false);
    expect(decidePath(cfg, 'Glob', { pattern: '*', path: 'test/acceptance' }).allow).toBe(false);
    expect(decidePath(cfg, 'Read', { file_path: 'src/domains/payment/payment.ts' }).allow).toBe(true);
    expect(decidePath(cfg, 'Edit', { file_path: 'src/domains/payment/payment.ts' }).allow).toBe(true);
    expect(decidePath(cfg, 'Edit', { file_path: 'src/domains/auth/x.ts' }).allow).toBe(false);
    expect(decidePath(cfg, 'Write', { file_path: 'src/domains/payment/__tests__/payment.unit.test.ts' }).allow).toBe(
      false,
    );
    expect(decidePath(cfg, 'Write', { file_path: 'test/acceptance/x.spec.ts' }).allow).toBe(false);
  });
});

describe('injectorOptions · parseInjectionOutput', () => {
  it('Bash 없음 · 구조화 출력 · 공통부 고정값', () => {
    const opts = injectorOptions({ config: { roles, blocks }, rule, cwd: '/w' });
    expect(opts.tools).toEqual([...INJECTOR_TOOLS]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'mcp__*', 'Agent', 'WebFetch']));
    expect(opts.outputFormat).toEqual({ type: 'json_schema', schema: INJECTION_OUTPUT_SCHEMA });
    expect(opts.maxTurns).toBe(30);
    expect(opts.strictMcpConfig).toBe(true);
    expect((opts.systemPrompt as { prompt: string }).prompt).toMatch(/위반하도록/);
    expect((opts.systemPrompt as { prompt: string }).prompt).toContain('src/domains/payment/**');
  });
  it('출력 파싱', () => {
    expect(
      parseInjectionOutput({ description: '7일 검사 제거', file: 'src/domains/payment/payment.ts', line: 30 }),
    ).toEqual({
      description: '7일 검사 제거',
      file: 'src/domains/payment/payment.ts',
      line: 30,
    });
    expect(parseInjectionOutput({ description: '', file: 'x' })).toBeUndefined();
    expect(parseInjectionOutput(undefined)).toBeUndefined();
  });
});
