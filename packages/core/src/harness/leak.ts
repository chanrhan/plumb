/**
 * 격리 누수 판정 (하네스 노트 결정 8). 누수는 비용으로 즉시 드러나므로 매 실행 두 신호를 본다:
 *   1. `[init].tools` — 허용 목록 밖 도구(특히 `mcp__*`, `Agent`, `Task`)가 있는가
 *   2. 첫 턴 `cache_creation_input_tokens` — 시스템 프롬프트 + 도구 정의 크기. 노트 2.4: MCP 커넥터 92개가 섞이자 1,221 → 121,925
 * 판정은 순수 함수라 SDK 없이 테스트한다.
 */

/** 첫 턴 캐시 생성이 이 이상이면 누수로 본다. 정상 1,221~2,342(노트 2.3 · 2.5 · 2.6) */
export const CACHE_LEAK_THRESHOLD = 10_000;

/** `SDKSystemMessage(init)`에서 판정에 쓰는 부분만 */
export interface InitSnapshot {
  model: string;
  apiKeySource: string;
  claudeCodeVersion: string;
  tools: string[];
  /** 연결된 MCP 서버. 비어 있어야 정상 */
  mcpServers: { name: string; status: string }[];
}

export interface LeakVerdict {
  leaked: boolean;
  /** 사람이 읽는 이유. 비어 있으면 누수 없음 */
  reasons: string[];
  mcpTools: string[];
  /** `mcp__<server>__<tool>`의 서버 이름 + init의 mcp_servers 이름 (중복 제거) */
  mcpServers: string[];
  /** 허용 목록 밖의 내장 도구 */
  unexpectedTools: string[];
  firstTurnCacheCreation: number | null;
}

export interface LeakCheckInput {
  init: InitSnapshot | undefined;
  /** 첫 assistant 메시지의 usage. 아직 없으면 undefined */
  firstUsage?: { cache_creation_input_tokens?: number } | undefined;
  /** 역할에 허용한 내장 도구 */
  allowedTools: readonly string[];
  cacheThreshold?: number;
}

export function mcpServerOf(tool: string): string | undefined {
  if (!tool.startsWith('mcp__')) return undefined;
  return tool.split('__')[1] || undefined;
}

export function detectLeak(input: LeakCheckInput): LeakVerdict {
  const threshold = input.cacheThreshold ?? CACHE_LEAK_THRESHOLD;
  const tools = input.init?.tools ?? [];
  const mcpTools = tools.filter((t) => t.startsWith('mcp__'));
  const allowed = new Set(input.allowedTools);
  const unexpectedTools = tools.filter((t) => !t.startsWith('mcp__') && !allowed.has(t));
  const mcpServers = [
    ...new Set([
      ...mcpTools.map(mcpServerOf).filter((s): s is string => s !== undefined),
      ...(input.init?.mcpServers ?? []).map((s) => s.name),
    ]),
  ];
  const created = input.firstUsage?.cache_creation_input_tokens;
  const firstTurnCacheCreation = typeof created === 'number' ? created : null;

  const reasons: string[] = [];
  if (mcpTools.length > 0) reasons.push(`MCP 도구 ${mcpTools.length}개 (서버: ${mcpServers.join(', ')})`);
  else if (mcpServers.length > 0) reasons.push(`MCP 서버 연결됨: ${mcpServers.join(', ')}`);
  if (unexpectedTools.length > 0) reasons.push(`허용 목록 밖 도구: ${unexpectedTools.join(', ')}`);
  if (firstTurnCacheCreation !== null && firstTurnCacheCreation > threshold) {
    reasons.push(`첫 턴 캐시 생성 ${firstTurnCacheCreation} 토큰 > ${threshold}`);
  }
  return { leaked: reasons.length > 0, reasons, mcpTools, mcpServers, unexpectedTools, firstTurnCacheCreation };
}
