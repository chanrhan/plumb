import { describe, expect, it } from 'vitest';
import type { PlumbConfig, Rule } from '../../types/index.js';
import { decideBash, GIT_WRITE_RULES, NETWORK_RULES, protectedPathRules } from '../bash-guard.js';
import { decidePath } from '../path-guard.js';
import {
  IMPLEMENTER_TOOLS,
  implementerOptions,
  implementerPathRules,
  implementerProtectedPaths,
  implementerSystemPrompt,
} from '../roles/implementer.js';

const roles: PlumbConfig['roles'] = {
  'test-writer': { model: 'claude-sonnet-5-5', maxTurns: 60, maxBudgetUsd: 3 },
  implementer: { model: 'claude-sonnet-5-5', maxTurns: 80, maxBudgetUsd: 5 },
  injector: { model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 2 },
  'rule-drafter': { model: 'claude-sonnet-5-5', maxTurns: 1, maxBudgetUsd: 0.5 },
};
const rule: Rule = {
  id: 'pay.refund-window',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
};
const config = { roles, store: './.plumb-store' };
const input = { config, rules: [rule], failingTests: ['test/acceptance/refund-window.property.spec.ts'], cwd: '/svc' };

describe('bash-guard 판정표', () => {
  const rules = [
    ...NETWORK_RULES,
    ...GIT_WRITE_RULES,
    ...protectedPathRules(['test/acceptance', '.git', '.plumb-store']),
  ];
  const cfg = { rules };
  it.each([
    ['curl https://example.com', '네트워크 도구'],
    ['wget -q http://x', '네트워크 도구'],
    ['git push origin main', 'git 원격'],
    ['git -C /svc fetch', 'git 원격'],
    ['pnpm add lodash', '패키지 설치'],
    ['npx some-cli', '패키지 설치'],
    ['git commit -m x', 'git 쓰기'],
    ['git checkout -- src/a.ts', 'git 쓰기'],
    ['git add .', 'git 쓰기'],
    ['echo x > test/acceptance/a.spec.ts', '보호 경로 리다이렉션'],
    ['cat a >> ./test/acceptance/b.spec.ts', '보호 경로 리다이렉션'],
    ['rm -rf test/acceptance', '보호 경로 변경 명령'],
    ['sed -i "s/a/b/" test/acceptance/a.spec.ts', '보호 경로 변경 명령'],
    ['mv src/x.ts test/acceptance/x.spec.ts', '보호 경로 변경 명령'],
    ['rm .git/index', '보호 경로 변경 명령'],
    ['pnpm vitest run && curl x', '네트워크 도구'],
  ])('거부: %s → %s', (cmd, name) => {
    expect(decideBash(cfg, cmd)).toEqual({ allow: false, rule: name });
  });
  it.each([
    'pnpm vitest run test/acceptance/refund-window.property.spec.ts',
    'pnpm test',
    'pnpm typecheck',
    'git status --short',
    'git diff src/',
    'git log --oneline -3',
    'cat test/acceptance/refund-window.property.spec.ts',
    'grep -rn refund src/',
    'ls test/acceptance',
    'echo done > .work/implementer/notes.txt',
    'node -e "console.log(1)"',
  ])('허용: %s', (cmd) => {
    expect(decideBash(cfg, cmd)).toEqual({ allow: true });
  });
});

describe('implementer 경로 규칙', () => {
  const pathCfg = { root: '/svc', rules: implementerPathRules(config) };
  it('보호 경로 = test/acceptance · .git · plumb · plumb.config.json · 루트 안의 저장소', () => {
    expect(implementerProtectedPaths(config)).toEqual([
      'test/acceptance',
      '.git',
      'plumb.config.json',
      'plumb',
      '.plumb-store',
    ]);
    expect(implementerProtectedPaths({ store: '/abs/store' })).not.toContain('/abs/store');
  });
  it('src/** 읽기·쓰기 허용, 보호 경로 쓰기 거부, 보호 경로 읽기는 허용', () => {
    expect(decidePath(pathCfg, 'Read', { file_path: 'src/domains/payment/refund.ts' }).allow).toBe(true);
    expect(decidePath(pathCfg, 'Edit', { file_path: 'src/domains/payment/refund.ts' }).allow).toBe(true);
    expect(decidePath(pathCfg, 'Read', { file_path: 'test/acceptance/a.spec.ts' }).allow).toBe(true);
    expect(decidePath(pathCfg, 'Write', { file_path: 'test/acceptance/a.spec.ts' }).allow).toBe(false);
    expect(decidePath(pathCfg, 'Edit', { file_path: '.git/HEAD' }).allow).toBe(false);
    expect(decidePath(pathCfg, 'Write', { file_path: 'plumb.config.json' }).allow).toBe(false);
    expect(decidePath(pathCfg, 'Write', { file_path: '.plumb-store/rules.yaml' }).allow).toBe(false);
    expect(decidePath(pathCfg, 'Write', { file_path: '.work/implementer/disputes/d-x.md' }).allow).toBe(true);
    expect(decidePath(pathCfg, 'Write', { file_path: 'src/x.test.ts' }).allow).toBe(true);
  });
});

describe('implementerOptions', () => {
  const opts = implementerOptions(input);
  it('Bash 포함 6개 도구, 인터넷·하위 에이전트·MCP 차단, 샌드박스는 네트워크 0 + 보호 경로 denyWrite', () => {
    expect(opts.tools).toEqual([...IMPLEMENTER_TOOLS]);
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'Agent', 'Task', 'mcp__*', 'NotebookEdit']),
    );
    expect(opts.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: { denyWrite: expect.arrayContaining(['test/acceptance', '.git']) },
    });
    expect(implementerOptions({ ...input, sandbox: false }).sandbox).toBeUndefined();
    expect(opts.maxTurns).toBe(80);
  });
  it('PreToolUse 첫 matcher에 경로 가드 + Bash 가드가 순서대로', async () => {
    const hooks = opts.hooks?.PreToolUse?.[0]?.hooks ?? [];
    expect(hooks).toHaveLength(2);
    const base = {
      session_id: 's',
      transcript_path: '/t',
      cwd: '/svc',
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'u',
    };
    const ctl = { signal: new AbortController().signal };
    const [pathGuard, bashGuard] = hooks;
    if (!pathGuard || !bashGuard) throw new Error('hooks 없음');
    expect(
      await pathGuard(
        { ...base, tool_name: 'Write', tool_input: { file_path: 'test/acceptance/a.spec.ts', content: '' } },
        'u',
        ctl,
      ),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(
      await bashGuard({ ...base, tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } }, 'u', ctl),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(
      await bashGuard({ ...base, tool_name: 'Bash', tool_input: { command: 'pnpm vitest run' } }, 'u', ctl),
    ).toEqual({});
    expect(
      await pathGuard({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf test/acceptance' } }, 'u', ctl),
    ).toEqual({}); // 경로 가드는 Bash에 관여 안 함
  });
  it('시스템 프롬프트: 실패 테스트 · 이의 제기 경로 · 금지 목록 · 테스트 약화 금지', () => {
    const p = implementerSystemPrompt(input);
    expect(p).toContain('test/acceptance/refund-window.property.spec.ts');
    expect(p).toContain('.work/implementer/disputes');
    expect(p).toMatch(/test\/acceptance\/\*\* 수정/);
    expect(p).toMatch(/약화/);
    expect(opts.systemPrompt).toEqual({ type: 'custom', prompt: p });
  });
});
