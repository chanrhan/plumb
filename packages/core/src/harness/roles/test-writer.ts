/**
 * test-writer 역할 (이슈 #76, 기획안 §8.1 · §8.2 · §8.3).
 *   본다:   규칙(EARS 진술 · 검사 참조) · 계약 파일 · `.d.ts` 스텁(#stubs) · `test/**`
 *   못 본다: `src/**` — 설정(PreToolUse deny)으로. CLAUDE.md · settings — 공통부 `settingSources: []`
 *   쓴다:   `test/acceptance/**`만. 테스트는 **실패로 시작**해야 한다(§8.3) — 종료 판정은 Stop hook(#78)
 *   없다:   Bash(셸 불필요 — 테스트 실행은 오케스트레이터가 한다) · 하위 에이전트 · 인터넷(공통부)
 */

import type { HookCallback, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import type { PlumbConfig, Rule } from '../../types/index.js';
import { makePathGuard, type PathRule } from '../path-guard.js';
import { buildRoleOptions } from '../role-options.js';

export const TEST_WRITER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
export const TEST_WRITER_DISALLOWED = ['Bash', 'MultiEdit', 'NotebookEdit'] as const;

/** 서비스 루트 기준. `src/**`는 읽기 금지, 쓰기는 `test/acceptance/**`에만 */
export const TEST_WRITER_PATH_RULES: readonly PathRule[] = [
  { access: 'read', globs: ['src/**'], mode: 'deny' },
  { access: 'write', globs: ['test/acceptance/**'], mode: 'allow-only' },
];

export interface TestWriterInput {
  config: Pick<PlumbConfig, 'roles' | 'contracts'>;
  /** 담당 규칙(승인된 것). 비어 있으면 예외 */
  rules: readonly Rule[];
  /** 역할 cwd = 대상 서비스 루트(또는 그 worktree). 경로 가드의 기준 */
  cwd: string;
  /** `.d.ts` 스텁 디렉토리 — cwd 기준 상대 또는 절대 */
  stubsDir: string;
  /** 추가 hook (스모크·프로브의 로그 등). PreToolUse에는 가드가 먼저 붙는다 */
  extraPreToolUse?: HookCallbackMatcher[];
  /** 종료 조건 Stop hook (#78 `makeStopHook().hook`). 없으면 모델이 끝내는 대로 끝난다 — 오케스트레이터(M6)는 반드시 준다 */
  stopHook?: HookCallback;
  log?: (line: string) => void;
  stderr?: (data: string) => void;
}

export function testWriterSystemPrompt(input: Pick<TestWriterInput, 'rules' | 'stubsDir' | 'config'>): string {
  const contracts = input.config.contracts;
  const contractLines = [
    contracts?.openapi ? `- OpenAPI: ${contracts.openapi}` : undefined,
    contracts?.prisma ? `- Prisma: ${contracts.prisma}` : undefined,
    contracts?.asyncapi ? `- AsyncAPI: ${contracts.asyncapi}` : undefined,
  ].filter((l): l is string => l !== undefined);
  const ruleLines = input.rules.map((r) => {
    const refs = r.checks.filter((c) => c.kind === 'acceptance' || c.kind === 'pbt').map((c) => c.ref);
    return [
      `### ${r.id} (${r.kind} · risk ${r.risk} · ${r.source})`,
      `진술: ${r.statement}`,
      refs.length > 0 ? `테스트 파일: ${refs.join(', ')}` : '테스트 파일: test/acceptance/<규칙이름>.spec.ts',
      r.scope?.length ? `대상 코드 글롭(읽을 수 없음, 참고만): ${r.scope.join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    '너는 Plumb의 테스트 작성자(test-writer)다. 규칙마다 인수 테스트를 쓴다. 구현은 하지 않는다.',
    '',
    '## 규칙',
    ...ruleLines,
    '',
    '## 볼 수 있는 것',
    `- 구현의 타입 시그니처: ${input.stubsDir} 아래 .d.ts (읽기 전용). 구현 본문(src/**)은 읽을 수 없고 읽으려 하면 거부된다 — 거부되면 다시 시도하지 말고 스텁과 계약으로 판단한다`,
    ...contractLines,
    '- 기존 테스트: test/**',
    '',
    '## 규칙',
    '- 파일은 test/acceptance/ 아래 *.spec.ts 에만 쓴다. 다른 곳에 쓰면 거부된다',
    '- import는 실제 경로(@/… 또는 상대 경로)로 쓴다. 스텁 경로를 import하지 않는다',
    '- 테스트는 규칙의 진술(EARS)을 그대로 검증한다. 구현이 아직 없거나 틀렸으므로 **지금은 실패해야 정상**이다. 통과하게 만들려고 테스트를 약하게 쓰지 않는다',
    '- 셸은 없다. 테스트 실행은 하네스가 한다. 끝나면 쓴 파일 목록과 각 테스트가 검증하는 진술을 한 줄씩 적는다',
  ].join('\n');
}

export function testWriterOptions(input: TestWriterInput): Options {
  if (input.rules.length === 0) throw new Error('test-writer: 담당 규칙이 없다');
  const guard = makePathGuard({ root: input.cwd, rules: TEST_WRITER_PATH_RULES, log: input.log });
  return buildRoleOptions({
    role: 'test-writer',
    config: input.config,
    cwd: input.cwd,
    systemPrompt: testWriterSystemPrompt(input),
    tools: TEST_WRITER_TOOLS,
    extraDisallowedTools: TEST_WRITER_DISALLOWED,
    hooks: {
      PreToolUse: [{ hooks: [guard] }, ...(input.extraPreToolUse ?? [])],
      ...(input.stopHook ? { Stop: [{ hooks: [input.stopHook] }] } : {}),
    },
    stderr: input.stderr,
  });
}
