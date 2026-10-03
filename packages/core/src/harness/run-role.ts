/**
 * 역할 실행 래퍼 (이슈 #75). `query()` 한 번을 돌리고 결과를 **항상** 돌려준다:
 *   - SDK는 오류 결과(예산·턴 초과)를 result 메시지로 보낸 뒤 예외로도 던진다(노트 2.2) → 예외 경로에서도 result를 회수
 *   - 격리 누수(`detectLeak`)가 보이면 즉시 `interrupt()`하고 `isolation-leak`으로 끝낸다 (노트 결정 8)
 * 오케스트레이터(M6)는 이 결과로 `RoleUsage` · `StageResult`를 만든다. 에이전트의 메시지 텍스트는 상태 계산의 입력이 아니다.
 */

import { type Options, query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { CACHE_LEAK_THRESHOLD, detectLeak, type InitSnapshot, type LeakVerdict } from './leak.js';

export type RoleRunOutcome = SDKResultMessage['subtype'] | 'isolation-leak' | 'thrown' | 'no-result';

export interface RoleRunResult {
  outcome: RoleRunOutcome;
  ok: boolean;
  init: InitSnapshot | undefined;
  leak: LeakVerdict | undefined;
  result: SDKResultMessage | undefined;
  /** `subtype: 'success'`일 때의 최종 답 */
  answer: string | undefined;
  /** 오케스트레이터가 세는 원자료 (`RoleUsage.turns` · `costUsd`) */
  turns: number;
  costUsd: number | null;
  permissionDenials: number;
  durationMs: number;
  error: unknown;
}

export interface RoleRunHandlers {
  onInit?: (init: InitSnapshot) => void;
  onAssistant?: (text: string, usage: AssistantUsage | undefined) => void;
  onLeak?: (leak: LeakVerdict) => void;
  onMessage?: (message: SDKMessage) => void;
}

export interface AssistantUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

export interface RunRoleInput {
  prompt: string;
  options: Options;
  handlers?: RoleRunHandlers;
  cacheThreshold?: number;
}

export function assistantText(message: SDKMessage): string {
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

export function assistantUsage(message: SDKMessage): AssistantUsage | undefined {
  if (message.type !== 'assistant') return undefined;
  return (message.message as unknown as { usage?: AssistantUsage }).usage;
}

export function initSnapshot(message: SDKMessage): InitSnapshot | undefined {
  if (message.type !== 'system' || message.subtype !== 'init') return undefined;
  return {
    model: message.model,
    apiKeySource: message.apiKeySource,
    claudeCodeVersion: message.claude_code_version,
    tools: message.tools,
    mcpServers: message.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
  };
}

export async function runRole(input: RunRoleInput): Promise<RoleRunResult> {
  const started = Date.now();
  // `tools`는 배열 또는 preset 객체 — 역할 공통부는 배열만 만들지만 타입은 둘 다 허용한다
  const allowedTools = Array.isArray(input.options.tools) ? input.options.tools : [];
  let init: InitSnapshot | undefined;
  let leak: LeakVerdict | undefined;
  let result: SDKResultMessage | undefined;
  let error: unknown;
  let interrupted = false;
  let firstAssistantSeen = false;

  const q = query({ prompt: input.prompt, options: input.options });
  try {
    for await (const message of q) {
      input.handlers?.onMessage?.(message);
      const snap = initSnapshot(message);
      if (snap) {
        init = snap;
        input.handlers?.onInit?.(snap);
        // 도구 목록만으로 판정 가능한 누수(MCP · 하위 에이전트)는 첫 턴을 기다리지 않는다
        const early = detectLeak({ init, allowedTools, cacheThreshold: input.cacheThreshold });
        if (early.leaked) {
          leak = early;
          input.handlers?.onLeak?.(early);
          interrupted = true;
          await q.interrupt().catch(() => undefined);
          break;
        }
        continue;
      }
      if (message.type === 'assistant') {
        const usage = assistantUsage(message);
        input.handlers?.onAssistant?.(assistantText(message), usage);
        if (!firstAssistantSeen) {
          firstAssistantSeen = true;
          const verdict = detectLeak({ init, firstUsage: usage, allowedTools, cacheThreshold: input.cacheThreshold });
          leak = verdict;
          if (verdict.leaked) {
            input.handlers?.onLeak?.(verdict);
            interrupted = true;
            await q.interrupt().catch(() => undefined);
            break;
          }
        }
        continue;
      }
      if (message.type === 'result') result = message;
    }
  } catch (thrown) {
    error = thrown;
  }

  const outcome: RoleRunOutcome = interrupted
    ? 'isolation-leak'
    : result
      ? result.subtype
      : error !== undefined
        ? 'thrown'
        : 'no-result';
  const success = result?.subtype === 'success' ? result : undefined;
  return {
    outcome,
    ok: outcome === 'success' && !result?.is_error,
    init,
    leak,
    result,
    answer: success?.result,
    turns: result?.num_turns ?? 0,
    costUsd: result?.total_cost_usd ?? null,
    permissionDenials: success?.permission_denials.length ?? 0,
    durationMs: Date.now() - started,
    error,
  };
}

export { CACHE_LEAK_THRESHOLD };
