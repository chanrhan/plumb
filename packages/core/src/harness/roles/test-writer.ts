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

// ---------------------------------------------------------------------------
// 재검토 (이슈 #88, 기획안 §8.4) — implementer의 이의 제기를 test-writer가 읽기 전용으로 판정한다. 결과는 advisory
// ---------------------------------------------------------------------------

export const TEST_WRITER_REVIEW_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** 재검토 판정. `Dispute.advisory.verdict`와 같은 값 */
export const REVIEW_VERDICTS = ['test-correct', 'test-wrong', 'ambiguous'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ReviewOutput {
  verdict: ReviewVerdict;
  /** 한 문장 근거 */
  reason: string;
  /** 진술과 테스트가 갈리는 구체 입력 (있으면) */
  evidenceInput?: string;
}

/** SDK `outputFormat` JSON 스키마 — 모델이 이 모양으로만 답한다 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...REVIEW_VERDICTS] },
    reason: { type: 'string' },
    evidenceInput: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
} as const;

export interface TestWriterReviewInput {
  config: Pick<PlumbConfig, 'roles'>;
  rule: Rule;
  /** 이의 제기 파일의 요약과 본문 */
  dispute: { summary: string; body: string };
  /** 역할 cwd = 서비스 루트(worktree). 테스트 파일을 읽는다 */
  cwd: string;
  /** 재검토는 짧다. 기본 8턴 */
  maxTurns?: number;
  log?: (line: string) => void;
  stderr?: (data: string) => void;
}

export function testWriterReviewSystemPrompt(input: Pick<TestWriterReviewInput, 'rule' | 'dispute'>): string {
  const files = input.rule.checks.filter((c) => c.kind === 'acceptance' || c.kind === 'pbt').map((c) => c.ref);
  return [
    '너는 Plumb의 테스트 작성자(test-writer)다. 구현자가 네 인수 테스트에 이의를 제기했다. 테스트가 규칙 진술을 올바르게 검증하는지 판정한다.',
    '',
    `## 규칙 ${input.rule.id}`,
    `진술: ${input.rule.statement}`,
    `테스트 파일: ${files.join(', ') || '(없음)'}`,
    '',
    '## 이의 제기',
    input.dispute.summary,
    input.dispute.body,
    '',
    '## 판정 기준',
    '- test-correct: 테스트가 진술을 그대로 검증한다. 구현자가 구현을 고쳐야 한다',
    '- test-wrong: 테스트가 진술과 다른 것을 요구한다(경계 · 입력 형태 · 없는 API). 테스트를 고쳐야 한다 — 어디가 어떻게 틀렸는지 reason에',
    '- ambiguous: 진술이 두 해석을 허용해 테스트와 구현자가 다른 쪽을 골랐다. 사람이 진술을 명확히 해야 한다',
    '- evidenceInput: 진술과 테스트가 갈리는 구체 입력 하나(예: paidAt=…, requestedAt=정확히 7일)',
    '',
    '## 규칙',
    '- 파일은 읽기만 한다(test/** · 계약 · 이 디렉토리). src/**는 읽을 수 없다. 아무것도 쓰지 않는다',
    '- 이 판정은 참고용(advisory)이다 — 규칙 상태를 바꾸지 않는다. 사람이 검토 대기열에서 최종 판단한다',
    '- 답은 지정된 JSON 모양으로만 한다',
  ].join('\n');
}

/** 읽기 전용 · 구조화 출력. 쓰기 도구가 없고 `src/**` 읽기는 가드가 막는다 */
export function testWriterReviewOptions(input: TestWriterReviewInput): Options {
  const guard = makePathGuard({
    root: input.cwd,
    rules: [{ access: 'read', globs: ['src/**'], mode: 'deny' }],
    log: input.log,
  });
  const base = buildRoleOptions({
    role: 'test-writer',
    config: input.config,
    cwd: input.cwd,
    systemPrompt: testWriterReviewSystemPrompt(input),
    tools: TEST_WRITER_REVIEW_TOOLS,
    extraDisallowedTools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    stderr: input.stderr,
  });
  return {
    ...base,
    maxTurns: input.maxTurns ?? 8,
    outputFormat: { type: 'json_schema', schema: REVIEW_OUTPUT_SCHEMA },
  };
}

/** 구조화 출력 → ReviewOutput. 모양이 어긋나면 `ambiguous`로 접는다 — 재검토 실패가 실행을 멈추지 않는다 */
export function parseReviewOutput(raw: unknown): ReviewOutput {
  const r = raw as Partial<ReviewOutput> | null;
  if (
    r &&
    typeof r === 'object' &&
    typeof r.verdict === 'string' &&
    (REVIEW_VERDICTS as readonly string[]).includes(r.verdict)
  ) {
    return {
      verdict: r.verdict as ReviewVerdict,
      reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : '(근거 없음)',
      ...(typeof r.evidenceInput === 'string' && r.evidenceInput.trim()
        ? { evidenceInput: r.evidenceInput.trim() }
        : {}),
    };
  }
  return {
    verdict: 'ambiguous',
    reason: `재검토 출력을 해석하지 못했다: ${JSON.stringify(raw)?.slice(0, 120) ?? String(raw)}`,
  };
}
