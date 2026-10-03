/**
 * injector 역할 (이슈 #90, 기획안 §7.4 · §8.6). 임시 worktree에서 규칙을 **위반하도록** 구현을 최소로 바꾼다.
 *   본다:   `src/**`(대상 코드) · 계약. **`test/**`는 읽을 수 없다** — 테스트를 보고 피해 가지 못하게
 *   쓴다:   `rule.scope`(없으면 블록 `include`) 안의 `src/**`만. 그 밖은 가드가 막는다
 *   없다:   Bash · 하위 에이전트 · 인터넷 · MCP(공통부)
 *   끝낼 때: 마지막 메시지를 구조화 출력(`{ description, file, line }`)으로 — 사람은 설명 한 줄과 위치만 본다. 패치 본문은 저장하지 않는다
 */

import type { HookCallback, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import type { PlumbConfig, Rule } from '../../types/index.js';
import { makePathGuard, type PathRule } from '../path-guard.js';
import { buildRoleOptions } from '../role-options.js';

export const INJECTOR_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
export const INJECTOR_DISALLOWED = ['Bash', 'MultiEdit', 'NotebookEdit'] as const;

export interface InjectionOutput {
  /** 주입 설명 한 줄 — 사람이 보는 전부 */
  description: string;
  /** 바꾼 위치 */
  file: string;
  line?: number;
}

export const INJECTION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
  },
  required: ['description', 'file'],
  additionalProperties: false,
} as const;

export interface InjectorInput {
  config: Pick<PlumbConfig, 'roles' | 'blocks'>;
  rule: Rule;
  /** 역할 cwd = 임시 worktree의 서비스 루트 */
  cwd: string;
  stopHook?: HookCallback;
  extraPreToolUse?: HookCallbackMatcher[];
  log?: (line: string) => void;
  stderr?: (data: string) => void;
}

/** 쓸 수 있는 글롭: `rule.scope` → 블록 `include` → `src/**` */
export function injectorWriteGlobs(rule: Rule, config: Pick<PlumbConfig, 'blocks'>): string[] {
  if (rule.scope && rule.scope.length > 0) return [...rule.scope];
  const block = rule.block ? config.blocks?.[rule.block] : undefined;
  if (block && block.include.length > 0) return [...block.include];
  return ['src/**'];
}

export function injectorPathRules(rule: Rule, config: Pick<PlumbConfig, 'blocks'>): PathRule[] {
  return [
    { access: 'read', globs: ['test/**'], mode: 'deny' },
    { access: 'write', globs: injectorWriteGlobs(rule, config), mode: 'allow-only' },
    // 쓰기 허용 범위 안이라도 테스트 파일은 안 된다
    { access: 'write', globs: ['**/*.test.ts', '**/*.spec.ts', 'test/**'], mode: 'deny' },
  ];
}

export function injectorSystemPrompt(input: Pick<InjectorInput, 'rule' | 'config'>): string {
  const globs = injectorWriteGlobs(input.rule, input.config);
  return [
    '너는 Plumb의 위반 주입자(injector)다. 검사가 규칙을 정말로 잡는지 시험하기 위해, 구현이 규칙 진술을 **위반하도록** 최소한으로 바꾼다.',
    '',
    `## 규칙 ${input.rule.id}`,
    `진술: ${input.rule.statement}`,
    '',
    '## 규칙',
    `- 바꿀 수 있는 파일: ${globs.join(', ')} 안의 구현만. 테스트(test/** · *.test.ts · *.spec.ts)는 읽을 수도 쓸 수도 없다 — 테스트를 보고 피해 가면 시험이 아니다`,
    '- 변경은 한 곳, 한 가지 의미로: 진술이 요구하는 검사를 빼거나 경계를 뒤집는다. 다른 동작은 그대로 둔다. 컴파일은 되어야 한다',
    '- 셸은 없다. 파일을 Read로 읽고 Edit로 바꾼다',
    '- 끝낼 때 지정된 JSON 모양으로만 답한다: description(무엇을 어떻게 위반시켰는지 한 문장) · file(바꾼 파일, cwd 상대) · line(바꾼 줄)',
  ].join('\n');
}

export function injectorOptions(input: InjectorInput): Options {
  const guard = makePathGuard({ root: input.cwd, rules: injectorPathRules(input.rule, input.config), log: input.log });
  const base = buildRoleOptions({
    role: 'injector',
    config: input.config,
    cwd: input.cwd,
    systemPrompt: injectorSystemPrompt(input),
    tools: INJECTOR_TOOLS,
    extraDisallowedTools: INJECTOR_DISALLOWED,
    hooks: {
      PreToolUse: [{ hooks: [guard] }, ...(input.extraPreToolUse ?? [])],
      ...(input.stopHook ? { Stop: [{ hooks: [input.stopHook] }] } : {}),
    },
    stderr: input.stderr,
  });
  return { ...base, outputFormat: { type: 'json_schema', schema: INJECTION_OUTPUT_SCHEMA } };
}

export function parseInjectionOutput(raw: unknown): InjectionOutput | undefined {
  const r = raw as Partial<InjectionOutput> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.description !== 'string' ||
    !r.description.trim() ||
    typeof r.file !== 'string' ||
    !r.file
  )
    return undefined;
  return { description: r.description.trim(), file: r.file, ...(typeof r.line === 'number' ? { line: r.line } : {}) };
}
