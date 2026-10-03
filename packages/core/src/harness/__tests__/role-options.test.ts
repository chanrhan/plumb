import { describe, expect, it } from 'vitest';
import type { PlumbConfig } from '../../types/index.js';
import { buildRoleOptions, FIXED_DISALLOWED_TOOLS, RoleOptionsError, roleConfigOf } from '../role-options.js';

const roles: PlumbConfig['roles'] = {
  'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
  implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
  injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
  'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
};

const base = {
  role: 'test-writer' as const,
  config: { roles },
  cwd: '/tmp/work/test-writer',
  systemPrompt: '규칙만 보고 테스트를 쓴다',
  tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
};

describe('buildRoleOptions — 고정값 (노트 결정 7)', () => {
  const opts = buildRoleOptions(base);

  it('MCP는 옵션으로 준 것만: strictMcpConfig + 빈 mcpServers + mcp__* 차단', () => {
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
    expect(opts.disallowedTools).toContain('mcp__*');
  });

  it('하위 에이전트와 인터넷은 어느 역할도 못 쓴다', () => {
    for (const t of FIXED_DISALLOWED_TOOLS) expect(opts.disallowedTools).toContain(t);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task', 'WebFetch', 'WebSearch']));
  });

  it('settings · CLAUDE.md 미로드, 권한 모드 default, 시스템 프롬프트는 custom 통째로', () => {
    expect(opts.settingSources).toEqual([]);
    expect(opts.permissionMode).toBe('default');
    expect(opts.systemPrompt).toEqual({ type: 'custom', prompt: base.systemPrompt });
  });

  it('tools와 allowedTools는 같은 목록(중복 제거), 가변값은 roles.<role>에서', () => {
    expect(opts.tools).toEqual(base.tools);
    expect(opts.allowedTools).toEqual(base.tools);
    expect(opts.model).toBe('claude-sonnet-5-5');
    expect(opts.maxTurns).toBe(60);
    expect(opts.maxBudgetUsd).toBe(3);
    expect(opts.cwd).toBe(base.cwd);
    expect(buildRoleOptions({ ...base, tools: ['Read', 'Read'] }).tools).toEqual(['Read']);
  });

  it('역할이 더 막는 도구는 보태지고, hooks · sandbox는 준 것만 들어간다', () => {
    const withExtra = buildRoleOptions({ ...base, extraDisallowedTools: ['Bash'] });
    expect(withExtra.disallowedTools).toContain('Bash');
    expect(opts.hooks).toBeUndefined();
    expect(opts.sandbox).toBeUndefined();
    const withSandbox = buildRoleOptions({ ...base, sandbox: { enabled: true } });
    expect(withSandbox.sandbox).toEqual({ enabled: true });
  });
});

describe('buildRoleOptions — 거부 (노트 결정 6)', () => {
  it('model "default"는 거부한다 — 계정 기본 모델은 기기마다 비용이 다르다', () => {
    const bad = { ...roles, 'test-writer': { ...roles['test-writer'], model: 'default' } };
    expect(() => roleConfigOf('test-writer', { roles: bad })).toThrow(RoleOptionsError);
    expect(() => buildRoleOptions({ ...base, config: { roles: bad } })).toThrow(/실제 모델 ID/);
  });

  it('tools에 mcp__ · Agent · Task · WebFetch는 넣을 수 없다', () => {
    for (const t of ['mcp__notion__search', 'Agent', 'Task', 'WebFetch']) {
      expect(() => buildRoleOptions({ ...base, tools: ['Read', t] })).toThrow(RoleOptionsError);
    }
  });

  it('없는 역할 설정, 0 이하 상한은 거부한다', () => {
    expect(() => roleConfigOf('implementer', { roles: { ...roles, implementer: undefined as never } })).toThrow(
      /설정이 없다/,
    );
    expect(() =>
      roleConfigOf('injector', { roles: { ...roles, injector: { ...roles.injector, maxBudgetUsd: 0 } } }),
    ).toThrow(/maxBudgetUsd/);
    expect(() =>
      roleConfigOf('injector', { roles: { ...roles, injector: { ...roles.injector, maxTurns: 0 } } }),
    ).toThrow(/maxTurns/);
  });
});
