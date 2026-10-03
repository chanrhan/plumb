/**
 * 셸 명령 차단 hook (이슈 #77, 기획안 §8.6). OS 샌드박스(`sandbox` 옵션)가 셸의 1차 방어지만 플랫폼에 따라 없을 수 있으므로
 * (`failIfUnavailable: false`) 명령 문자열을 보는 2차 방어를 둔다. 판정은 순수 함수 `decideBash`.
 *
 * 막는 것: 인터넷(curl · wget · ssh …, git의 원격 동작, 패키지 설치) · git 쓰기(commit · reset · checkout …; 커밋은 오케스트레이터가 한다)
 *          · 보호 경로(`test/acceptance/` · `.git/` · 저장소)를 **쓰는** 셸 리다이렉션·sed -i · rm · mv · cp
 * 허용: 테스트 실행(`pnpm vitest run …`), 읽기 전용 git(status · diff · log · show), 일반 빌드·타입체크
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export interface BashRule {
  /** 사람이 읽는 이름 — 거부 로그에 찍힌다 */
  name: string;
  pattern: RegExp;
}

export interface BashGuardConfig {
  rules: readonly BashRule[];
  log?: (line: string) => void;
}

export interface BashDecision {
  allow: boolean;
  rule?: string;
}

/** 인터넷으로 나가는 명령 */
export const NETWORK_RULES: readonly BashRule[] = [
  {
    name: '네트워크 도구',
    pattern: /(^|[\s;&|(])(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|telnet|ftp|dig|nslookup|ping)(\s|$)/,
  },
  {
    name: 'git 원격',
    pattern: /(^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?(push|fetch|pull|clone|remote|submodule|ls-remote)(\s|$)/,
  },
  {
    name: '패키지 설치',
    pattern: /(^|[\s;&|(])(pnpm|npm|yarn|bun)\s+(add|install|i|ci|update|up|publish|dlx|create)(\s|$)/,
  },
  // npx/pnpx/bunx는 없는 패키지를 내려받아 실행한다 — 서브커맨드와 무관하게 막는다
  { name: '패키지 설치', pattern: /(^|[\s;&|(])(npx|pnpx|bunx)(\s|$)/ },
  { name: '네트워크 접근(런타임)', pattern: /(^|[\s;&|(])(pip3?|gem|cargo|go)\s+(install|get|add)(\s|$)/ },
];

/** git 상태를 바꾸는 명령. 읽기 전용(status · diff · log · show · blame · rev-parse)은 허용 */
export const GIT_WRITE_RULES: readonly BashRule[] = [
  {
    name: 'git 쓰기',
    pattern:
      /(^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?(commit|reset|checkout|switch|restore|rebase|merge|stash|add|rm|mv|tag|branch|cherry-pick|revert|clean|am|apply|worktree|config|init)(\s|$)/,
  },
];

/** 보호 경로를 셸로 쓰는 시도. 경로 글롭별로 만든다 */
export function protectedPathRules(paths: readonly string[]): BashRule[] {
  const alt = paths.map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '')).join('|');
  const P = `(?:\\./)?(?:${alt})(?:/|\\s|$|["'])`;
  return [
    { name: '보호 경로 리다이렉션', pattern: new RegExp(`>>?\\s*${P}`) },
    {
      name: '보호 경로 변경 명령',
      pattern: new RegExp(
        `(^|[\\s;&|(])(rm|mv|cp|sed\\s+(?:-[a-zA-Z]*i|--in-place)|tee|truncate|touch|mkdir|chmod|chown|ln|install)\\b[^;&|]*\\s${P}`,
      ),
    },
  ];
}

export function decideBash(config: BashGuardConfig, command: string): BashDecision {
  for (const rule of config.rules) {
    if (rule.pattern.test(command)) return { allow: false, rule: rule.name };
  }
  return { allow: true };
}

export function makeBashGuard(config: BashGuardConfig): HookCallback {
  const log = config.log ?? ((line) => process.stderr.write(`${line}\n`));
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== 'Bash') return {};
    const command = (pre.tool_input as { command?: unknown } | null)?.command;
    if (typeof command !== 'string') return {};
    const decision = decideBash(config, command);
    if (decision.allow) return {};
    const short = command.length > 120 ? `${command.slice(0, 117)}…` : command;
    log(`[hook] deny Bash ${JSON.stringify(short)} (${decision.rule})`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${decision.rule}: 이 역할은 셸로 이 일을 할 수 없다`,
      },
    };
  };
}
