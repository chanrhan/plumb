import { describe, expect, it } from 'vitest';
import { CACHE_LEAK_THRESHOLD, detectLeak, type InitSnapshot, mcpServerOf } from '../leak.js';

const clean: InitSnapshot = {
  model: 'claude-sonnet-5-5',
  apiKeySource: 'none',
  claudeCodeVersion: '2.1.288',
  tools: ['Read'],
  mcpServers: [],
};

describe('detectLeak (노트 결정 8)', () => {
  it('클라우드 2.5 · 로컬 2.6: 도구 1개, 캐시 생성 수천 → 누수 없음', () => {
    const v = detectLeak({ init: clean, firstUsage: { cache_creation_input_tokens: 1690 }, allowedTools: ['Read'] });
    expect(v.leaked).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.firstTurnCacheCreation).toBe(1690);
  });

  it('로컬 2.4: 계정 MCP 커넥터 도구가 올라오면 서버 이름과 함께 누수', () => {
    const init = {
      ...clean,
      tools: [
        'Read',
        'mcp__claude_ai_Notion__notion-search',
        'mcp__claude_ai_Figma__get_metadata',
        'mcp__claude_ai_Figma__use_figma',
      ],
    };
    const v = detectLeak({ init, firstUsage: { cache_creation_input_tokens: 121925 }, allowedTools: ['Read'] });
    expect(v.leaked).toBe(true);
    expect(v.mcpTools).toHaveLength(3);
    expect(v.mcpServers).toEqual(['claude_ai_Notion', 'claude_ai_Figma']);
    expect(v.reasons[0]).toMatch(/MCP 도구 3개/);
    expect(v.reasons[1]).toMatch(/121925 토큰 > 20000/);
  });

  it('init만으로도 판정한다 — 첫 턴 전에 끊기 위해', () => {
    const v = detectLeak({ init: { ...clean, tools: ['Read', 'mcp__x__y'] }, allowedTools: ['Read'] });
    expect(v.leaked).toBe(true);
    expect(v.firstTurnCacheCreation).toBeNull();
  });

  it('허용 목록 밖 내장 도구(Agent · Bash)도 누수다', () => {
    const v = detectLeak({ init: { ...clean, tools: ['Read', 'Agent', 'Bash'] }, allowedTools: ['Read'] });
    expect(v.leaked).toBe(true);
    expect(v.unexpectedTools).toEqual(['Agent', 'Bash']);
  });

  it('도구 없이 MCP 서버만 연결돼 있어도 누수로 본다', () => {
    const v = detectLeak({
      init: { ...clean, mcpServers: [{ name: 'notion', status: 'connected' }] },
      allowedTools: ['Read'],
    });
    expect(v.leaked).toBe(true);
    expect(v.reasons[0]).toMatch(/MCP 서버 연결됨: notion/);
  });

  it('캐시 기준은 바꿀 수 있고, 기본은 20,000 (macOS 샌드박스 켜짐 8,463까지 정상)', () => {
    expect(CACHE_LEAK_THRESHOLD).toBe(20_000);
    expect(
      detectLeak({ init: clean, firstUsage: { cache_creation_input_tokens: 8463 }, allowedTools: ['Read'] }).leaked,
    ).toBe(false);
    const v = detectLeak({
      init: clean,
      firstUsage: { cache_creation_input_tokens: 5000 },
      allowedTools: ['Read'],
      cacheThreshold: 4000,
    });
    expect(v.leaked).toBe(true);
  });

  it('init이 아직 없으면 판정 불가 = 누수 없음', () => {
    expect(detectLeak({ init: undefined, allowedTools: ['Read'] }).leaked).toBe(false);
  });

  it('mcpServerOf', () => {
    expect(mcpServerOf('mcp__claude_ai_Notion__notion-search')).toBe('claude_ai_Notion');
    expect(mcpServerOf('Read')).toBeUndefined();
  });
});
