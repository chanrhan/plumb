/**
 * 역할 공통부 — `query()` 옵션 빌더 (이슈 #75, 기획안 §8.6 · §8.7, 하네스 노트 3절 · 6절).
 *
 * 고정값(역할이 풀 수 없다)과 가변값(`plumb.config.json roles.<role>`)을 가른다.
 *   고정: `strictMcpConfig: true` + `mcpServers: {}` + `disallowedTools: ['mcp__*', 'Agent', 'Task']`  (노트 결정 7)
 *         `settingSources: []` (settings · CLAUDE.md 미로드) · `permissionMode: 'default'` · `systemPrompt: custom`
 *   가변: `model`(`"default"` 금지 — 노트 결정 6) · `maxTurns` · `maxBudgetUsd`
 * 역할별 파일(#76 · #77)은 시스템 프롬프트 · 내장 도구 목록 · hook · sandbox만 보탠다.
 */

import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk';
import type { PlumbConfig, Role, RoleConfig } from '../types/index.js';

/** 어떤 역할도 풀 수 없는 차단 목록. `mcp__*`는 모든 MCP 도구(SDK 주석), `Agent`·`Task`는 하위 에이전트(§8.6 "생성 깊이 1") */
export const FIXED_DISALLOWED_TOOLS = ['mcp__*', 'Agent', 'Task'] as const;

/** 역할에 줄 수 없는 내장 도구. 하위 에이전트와 인터넷은 어느 역할에도 없다 */
const FORBIDDEN_BUILTIN_TOOLS = new Set(['Agent', 'Task', 'WebFetch', 'WebSearch']);

export class RoleOptionsError extends Error {
  constructor(
    readonly role: Role,
    message: string,
  ) {
    super(`roles.${role}: ${message}`);
    this.name = 'RoleOptionsError';
  }
}

export interface RoleOptionsInput {
  role: Role;
  config: Pick<PlumbConfig, 'roles'>;
  /** 역할 작업 디렉토리 (`.work/<role>/` 또는 worktree). 절대 경로 */
  cwd: string;
  systemPrompt: string;
  /** 허용하는 내장 도구. 이 목록이 곧 `tools`와 `allowedTools` */
  tools: readonly string[];
  /** 역할이 더 막는 도구 (예: test-writer의 `Bash`) */
  extraDisallowedTools?: readonly string[];
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  sandbox?: Options['sandbox'];
  stderr?: (data: string) => void;
}

/** `plumb.config.json roles.<role>`를 검증해 돌려준다. `"default"`는 거부 — 계정 기본 모델은 기기마다 비용이 4배 다르다(노트 2.6) */
export function roleConfigOf(role: Role, config: Pick<PlumbConfig, 'roles'>): RoleConfig {
  const rc = config.roles?.[role];
  if (!rc) throw new RoleOptionsError(role, '설정이 없다');
  if (!rc.model || rc.model === 'default') {
    throw new RoleOptionsError(
      role,
      `model은 실제 모델 ID여야 한다 (예: claude-sonnet-5-5). 받은 값: ${JSON.stringify(rc.model)}`,
    );
  }
  if (!Number.isInteger(rc.maxTurns) || rc.maxTurns <= 0) throw new RoleOptionsError(role, 'maxTurns는 양의 정수');
  if (!(rc.maxBudgetUsd > 0)) throw new RoleOptionsError(role, 'maxBudgetUsd는 0보다 커야 한다');
  return rc;
}

export function buildRoleOptions(input: RoleOptionsInput): Options {
  const rc = roleConfigOf(input.role, input.config);
  const tools = [...new Set(input.tools)];
  for (const t of tools) {
    if (t.startsWith('mcp__') || FORBIDDEN_BUILTIN_TOOLS.has(t)) {
      throw new RoleOptionsError(input.role, `tools에 줄 수 없는 도구: ${t}`);
    }
  }
  const disallowedTools = [
    ...new Set([...FIXED_DISALLOWED_TOOLS, 'WebFetch', 'WebSearch', ...(input.extraDisallowedTools ?? [])]),
  ];

  return {
    cwd: input.cwd,
    model: rc.model,
    maxTurns: rc.maxTurns,
    maxBudgetUsd: rc.maxBudgetUsd,
    tools,
    allowedTools: tools,
    disallowedTools,
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: 'default',
    systemPrompt: { type: 'custom', prompt: input.systemPrompt },
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.stderr ? { stderr: input.stderr } : {}),
  };
}
