/**
 * Agent SDK 스모크 (이슈 #10, M1). 기획안 §8.7 하네스 · §8.6 격리의 전제를 1회 호출로 확인한다.
 *
 * 확인하는 것
 *   1. 이 머신의 인증(구독 `claude login` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`)으로 SDK가 돈다
 *   2. PreToolUse hook이 도구 호출을 가로챈다 — stderr에 `[hook] PreToolUse Read <경로>` 한 줄
 *   3. 격리 수단이 SDK 옵션으로 표현된다 (M4 입력):
 *        도구 allowlist   → `allowedTools` · `disallowedTools`         (§8.6 도구 격리)
 *        경로 차단        → PreToolUse `permissionDecision: 'deny'`      (§8.6 경로 차단 hook)
 *        CLAUDE.md 미로드 → `settingSources: []`                        (§8.6 컨텍스트 격리)
 *        하위 에이전트 금지 → `disallowedTools: ['Agent', 'Task']`       (§8.6 "생성 깊이 1")
 *        예산·반복 상한   → `maxBudgetUsd` · `maxTurns`                 (§15.4)
 *        OS 샌드박스      → `sandbox` 옵션 존재 (내용은 M4에서 실측)      (§8.6 파일시스템 격리)
 *   4. 결과 메시지의 비용·턴·시간 필드 (`total_cost_usd`는 클라이언트 추정 — 청구액 아님, §8.7)
 *
 * 실행: `pnpm --filter @plumb/core smoke`
 * 실패 시 흔한 원인 — docs/harness-notes.md "2. 스모크 결과" 참고
 *   · 인증 없음: `claude login` 또는 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`
 *   · 번들 바이너리 없음(optional dependency 미설치): 아래 PATH_TO_CLAUDE 주석을 풀고 `which claude` 경로를 넣는다
 *   · 권한 프롬프트가 뜸: `allowedTools`에 Read가 있는데도 뜨면 그 사실을 노트에 적는다 (M4 입력)
 */

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type HookCallback,
  type PreToolUseHookInput,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

/** 스모크의 작업 디렉토리 = packages/core (이 파일 기준 `../..`) */
const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = resolve(HERE, '..', '..');

// const PATH_TO_CLAUDE = '/usr/local/bin/claude'; // 번들 바이너리가 없을 때만

/**
 * 모델 · 예산. 기본은 모델을 지정하지 않아 **계정 기본 모델**이 무엇인지 관찰한다(`[init] model=`).
 * 로컬 구독 첫 실행에서 $0.2 상한이 첫 도구 호출 직후 소진됐다(노트 2.2) — 상한을 0.5로 올리고 덮어쓸 수 있게 했다.
 *   PLUMB_SMOKE_MODEL=claude-sonnet-5-5 PLUMB_SMOKE_BUDGET=1 pnpm --filter @plumb/core smoke
 */
const MODEL = process.env.PLUMB_SMOKE_MODEL || undefined;
const BUDGET_USD = Number(process.env.PLUMB_SMOKE_BUDGET ?? '0.5');

function toolPath(input: unknown): string | undefined {
  const t = input as { file_path?: unknown } | null;
  return typeof t?.file_path === 'string' ? t.file_path : undefined;
}

/** 확인 2 — 모든 Read 호출을 stderr에 한 줄 기록하고 허용한다 */
const logRead: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  process.stderr.write(`[hook] PreToolUse ${pre.tool_name} ${toolPath(pre.tool_input) ?? '(경로 없음)'}\n`);
  return {};
};

/** 확인 3(경로 차단) — cwd 밖 파일 읽기는 거부한다. 테스트 작성자의 `src/**` 차단과 같은 수단 */
const denyOutsideCwd: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  const p = toolPath(pre.tool_input);
  if (p === undefined) return {};
  const abs = resolve(CWD, p);
  if (abs === CWD || abs.startsWith(CWD + sep)) return {};
  process.stderr.write(`[hook] deny ${pre.tool_name} ${p} (cwd 밖)\n`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `cwd 밖 경로는 읽을 수 없다: ${p}`,
    },
  };
};

function textOf(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const blocks = (message.message as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b: unknown) => {
      const block = b as { type?: string; text?: string; name?: string };
      if (block.type === 'text' && block.text) return block.text;
      if (block.type === 'tool_use') return `<tool_use ${block.name ?? '?'}>`;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function usageLine(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const u = (message.message as unknown as { usage?: Record<string, unknown> }).usage;
  if (!u) return '';
  const thinking = (u.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens;
  return `in ${u.input_tokens ?? 0} · cache+ ${u.cache_creation_input_tokens ?? 0} · cache↺ ${u.cache_read_input_tokens ?? 0} · out ${u.output_tokens ?? 0}${thinking !== undefined ? ` (think ${thinking})` : ''}`;
}

function summarize(result: SDKResultMessage): Record<string, unknown> {
  const base = {
    subtype: result.subtype,
    num_turns: result.num_turns,
    duration_ms: result.duration_ms,
    total_cost_usd: result.total_cost_usd,
    is_error: result.is_error,
  };
  return result.subtype === 'success'
    ? { ...base, usage: result.usage, permission_denials: result.permission_denials.length }
    : base;
}

async function main(): Promise<number> {
  let result: SDKResultMessage | undefined;
  const started = Date.now();

  const finish = (thrown?: unknown): number => {
    if (result !== undefined) {
      process.stdout.write(`[result] ${JSON.stringify(summarize(result))}\n`);
      if (result.subtype === 'success') process.stdout.write(`[answer] ${result.result}\n`);
      if (result.subtype === 'error_max_budget_usd') {
        process.stdout.write(`[smoke] 예산 상한($${BUDGET_USD})에 걸림 — maxBudgetUsd가 실행을 끊는 것은 확인됨\n`);
      }
    }
    if (thrown !== undefined) {
      const e = thrown as { message?: string };
      process.stderr.write(`[smoke] 실패: ${e.message ?? String(thrown)}\n`);
    }
    process.stdout.write(`[smoke] wall ${Date.now() - started}ms\n`);
    if (thrown !== undefined || result === undefined) return 1;
    return result.subtype === 'success' && !result.is_error ? 0 : 1;
  };

  try {
    for await (const message of query({
      prompt:
        '현재 디렉토리의 package.json 파일을 읽고, 그 첫 줄의 내용을 한 문장으로 알려줘. 다른 파일은 열지 말고 다른 일은 하지 마.',
      options: {
        cwd: CWD,
        ...(MODEL ? { model: MODEL } : {}),
        // 도구 격리: Read 하나만. 목록에 없는 도구는 에이전트에게 존재하지 않는다 (§8.6)
        tools: ['Read'],
        allowedTools: ['Read'],
        disallowedTools: ['Agent', 'Task', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
        // 컨텍스트 격리: 프로젝트·사용자 settings와 CLAUDE.md를 읽지 않는다
        settingSources: [],
        systemPrompt: { type: 'custom', prompt: '지시한 파일만 읽는다. 답은 한국어 한 문장.' },
        permissionMode: 'default',
        maxTurns: 3,
        maxBudgetUsd: BUDGET_USD,
        // pathToClaudeCodeExecutable: PATH_TO_CLAUDE,
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [logRead, denyOutsideCwd] }],
        },
        stderr: (data) => process.stderr.write(`[sdk] ${data}`),
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        process.stdout.write(
          `[init] model=${message.model} apiKeySource=${message.apiKeySource} claude_code=${message.claude_code_version} permissionMode=${message.permissionMode} tools=${JSON.stringify(message.tools)} budget=$${BUDGET_USD}\n`,
        );
      } else if (message.type === 'assistant') {
        const text = textOf(message);
        if (text) process.stdout.write(`[assistant] ${text}\n`);
        const usage = usageLine(message);
        if (usage) process.stdout.write(`[usage] ${usage}\n`);
      } else if (message.type === 'result') {
        result = message;
      }
    }
  } catch (error) {
    // SDK는 오류 결과(예산·턴 초과 등)를 예외로도 던진다 — 받아 둔 result로 요약을 남긴다 (M4 하네스 입력)
    return finish(error);
  }
  if (result === undefined) process.stderr.write('[smoke] result 메시지가 오지 않았다\n');
  return finish();
}

main().then((code) => process.exit(code));
