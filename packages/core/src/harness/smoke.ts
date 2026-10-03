/**
 * Agent SDK 스모크 (이슈 #10, M1 → #75에서 역할 공통부 위로 옮김). 기획안 §8.7 하네스 · §8.6 격리의 전제를 1회 호출로 확인한다.
 *
 * 확인하는 것
 *   1. 이 머신의 인증(구독 `claude login` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`)으로 SDK가 돈다
 *   2. PreToolUse hook이 도구 호출을 가로챈다 — stderr에 `[hook] PreToolUse Read <경로>` 한 줄
 *   3. 격리 수단이 SDK 옵션으로 표현된다 — `buildRoleOptions`의 고정값 (role-options.ts, 노트 3절 대응표)
 *   4. 결과 메시지의 비용·턴·시간 필드 (`total_cost_usd`는 클라이언트 추정 — 청구액 아님, §8.7)
 *   5. 컨텍스트 누수 감시 — `runRole`이 `[init].tools`와 첫 턴 캐시 생성을 보고 누수면 즉시 끊는다 (leak.ts, 노트 결정 8)
 *
 * 실행: `pnpm --filter @plumb/core smoke`
 *   PLUMB_SMOKE_MODEL  기본 claude-sonnet-5-5 (노트 결정 6: 모델은 항상 명시. 계정 기본 fable은 같은 토큰에 4배, 노트 2.6)
 *   PLUMB_SMOKE_BUDGET 기본 0.5
 * 실패 시 흔한 원인 — docs/harness-notes.md "2. 스모크 결과" 참고 (완료 증거: 2.6 로컬 `tools=1 (mcp 0)` · exit 0)
 *   · 인증 없음: `claude login` 또는 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`
 *   · `[smoke] 격리 누수`: 막지 못한 서버·도구 이름이 찍힌다 — 노트 2.4 · 2.6과 비교해 적는다
 */

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { buildRoleOptions } from './role-options.js';
import { runRole } from './run-role.js';

/** 스모크의 작업 디렉토리 = packages/core (이 파일 기준 `../..`) */
const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = resolve(HERE, '..', '..');

const MODEL = process.env.PLUMB_SMOKE_MODEL || 'claude-sonnet-5-5';
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

async function main(): Promise<number> {
  const started = Date.now();
  // 스모크는 plumb.config.json 없이 돈다 — 역할 하나짜리 설정을 직접 만든다. 다른 역할은 공통부가 보지 않는다
  const roles = { 'test-writer': { model: MODEL, maxTurns: 3, maxBudgetUsd: BUDGET_USD } };
  const options = buildRoleOptions({
    role: 'test-writer',
    config: { roles: roles as never },
    cwd: CWD,
    systemPrompt: '지시한 파일만 읽는다. 답은 한국어 한 문장.',
    tools: ['Read'],
    extraDisallowedTools: ['Bash', 'Write', 'Edit'],
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [logRead, denyOutsideCwd] }] },
    stderr: (data) => process.stderr.write(`[sdk] ${data}`),
  });

  const run = await runRole({
    prompt:
      '현재 디렉토리의 package.json 파일을 읽고, 그 첫 줄의 내용을 한 문장으로 알려줘. 다른 파일은 열지 말고 다른 일은 하지 마.',
    options,
    handlers: {
      onInit: (init) => {
        const mcp = init.tools.filter((t) => t.startsWith('mcp__')).length;
        process.stdout.write(
          `[init] model=${init.model} apiKeySource=${init.apiKeySource} claude_code=${init.claudeCodeVersion} tools=${init.tools.length} (mcp ${mcp}) ${JSON.stringify(init.tools.slice(0, 5))}${init.tools.length > 5 ? '…' : ''} budget=$${BUDGET_USD}\n`,
        );
      },
      onAssistant: (text, u) => {
        if (text) process.stdout.write(`[assistant] ${text}\n`);
        if (u) {
          process.stdout.write(
            `[usage] in ${u.input_tokens ?? 0} · cache+ ${u.cache_creation_input_tokens ?? 0} · cache↺ ${u.cache_read_input_tokens ?? 0} · out ${u.output_tokens ?? 0}\n`,
          );
        }
      },
      onLeak: (leak) => process.stderr.write(`[smoke] 격리 누수 — 실행을 끊는다: ${leak.reasons.join(' / ')}\n`),
    },
  });

  if (run.result) {
    const r = run.result;
    const summary = {
      subtype: r.subtype,
      num_turns: r.num_turns,
      duration_ms: r.duration_ms,
      total_cost_usd: r.total_cost_usd,
      is_error: r.is_error,
      ...(r.subtype === 'success' ? { usage: r.usage, permission_denials: r.permission_denials.length } : {}),
    };
    process.stdout.write(`[result] ${JSON.stringify(summary)}\n`);
  }
  if (run.answer !== undefined) process.stdout.write(`[answer] ${run.answer}\n`);
  if (run.outcome === 'error_max_budget_usd') {
    process.stdout.write(`[smoke] 예산 상한($${BUDGET_USD})에 걸림 — maxBudgetUsd가 실행을 끊는 것은 확인됨\n`);
  }
  if (run.error !== undefined) {
    const e = run.error as { message?: string };
    process.stderr.write(`[smoke] 실패: ${e.message ?? String(run.error)}\n`);
  }
  process.stdout.write(`[smoke] outcome=${run.outcome} wall ${Date.now() - started}ms\n`);
  return run.ok ? 0 : 1;
}

main().then((code) => process.exit(code));
