/**
 * 경로 차단 hook (기획안 §8.6 "파일 도구는 hook으로 막는다"). test-writer(#76)와 implementer(#77)가 같은 가드를 쓴다.
 *
 * 판정은 순수 함수 `decidePath`가 하고, `makePathGuard`가 그것을 SDK `PreToolUse` 콜백으로 감싼다.
 * 경로는 `root`(역할 cwd) 기준 상대 · posix로 정규화한다. root 밖(`../…`)은 어떤 규칙에도 맞지 않으므로 **읽기·쓰기 모두 거부**된다.
 * OS 샌드박스(`sandbox.filesystem`)는 셸에만 적용되므로 파일 도구는 여기서 따로 막는다(노트 3절 파일시스템 행).
 */

import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

/** 파일을 읽는 내장 도구. Glob·Grep은 `path` 인자가 없으면 cwd 전체를 뒤지므로 cwd 자체를 대상으로 본다 */
export const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** 파일을 쓰는 내장 도구 */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

export type PathAccess = 'read' | 'write';

export interface PathRule {
  /** 어떤 접근에 대한 규칙인가 */
  access: PathAccess;
  /** 글롭(root 기준 상대, posix). `src/**` · `test/acceptance/**` · `.git/**` */
  globs: readonly string[];
  /** `deny`: 맞으면 거부. `allow-only`: 맞는 곳**만** 허용(그 밖은 거부) */
  mode: 'deny' | 'allow-only';
}

export interface PathGuardConfig {
  /** 역할 cwd. 절대 경로 */
  root: string;
  rules: readonly PathRule[];
  /** 거부 로그. 기본 stderr `[hook] deny <tool> <path> (<이유>)` */
  log?: (line: string) => void;
}

export interface PathDecision {
  allow: boolean;
  access: PathAccess | null;
  /** root 기준 상대 posix 경로. root 밖이면 `..`로 시작 */
  relPath: string | null;
  reason?: string;
}

/** 글롭 → 정규식. `**`는 경로 구분자를 포함한 임의, `*`는 한 세그먼트 안, `?`는 한 글자 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 는 0개 이상의 디렉토리, 끝의 `**`는 나머지 전부
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

/** 도구 입력에서 대상 경로를 뽑는다. Read/Write/Edit `file_path`, Glob/Grep `path`, NotebookEdit `notebook_path` */
export function toolTargetPath(toolName: string, toolInput: unknown): string | undefined {
  const t = toolInput as Record<string, unknown> | null;
  if (!t) return undefined;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof t[key] === 'string' && (t[key] as string).length > 0) return t[key] as string;
  }
  // Glob·Grep에 path가 없으면 cwd 전체
  return (READ_TOOLS as readonly string[]).includes(toolName) ? '.' : undefined;
}

export function accessOf(toolName: string): PathAccess | null {
  if ((READ_TOOLS as readonly string[]).includes(toolName)) return 'read';
  if ((WRITE_TOOLS as readonly string[]).includes(toolName)) return 'write';
  return null;
}

/** root 기준 상대 posix 경로. root 밖이면 `../…` */
export function relativeToRoot(root: string, target: string): string {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(resolve(root), abs);
  return rel === '' ? '.' : rel.split(sep).join(posix.sep);
}

export function decidePath(config: PathGuardConfig, toolName: string, toolInput: unknown): PathDecision {
  const access = accessOf(toolName);
  if (access === null) return { allow: true, access: null, relPath: null };
  const target = toolTargetPath(toolName, toolInput);
  if (target === undefined) return { allow: true, access, relPath: null };
  const relPath = relativeToRoot(config.root, target);

  if (relPath.startsWith('..')) {
    return { allow: false, access, relPath, reason: '작업 디렉토리 밖' };
  }
  // Glob/Grep이 디렉토리를 가리키면 그 아래 전부를 뒤지는 것 — `dir/**`로 판정한다
  const dirRead = access === 'read' && toolName !== 'Read';
  const probe = dirRead ? (relPath === '.' ? '**' : `${relPath}/**`) : relPath;

  for (const rule of config.rules) {
    if (rule.access !== access) continue;
    // 디렉토리 읽기는 양방향으로 본다: 규칙 글롭이 그 디렉토리 아래에 있어도(`**` ⊇ `src/**`) 금지 영역을 뒤지는 것이다
    const hit = matchesAny(probe, rule.globs) || (dirRead && rule.globs.some((g) => matchesAny(g, [probe])));
    if (rule.mode === 'deny' && hit) {
      return {
        allow: false,
        access,
        relPath,
        reason: `${rule.globs.join(', ')} ${access === 'read' ? '읽기' : '쓰기'} 금지`,
      };
    }
    if (rule.mode === 'allow-only' && !hit) {
      return {
        allow: false,
        access,
        relPath,
        reason: `${access === 'read' ? '읽기' : '쓰기'}는 ${rule.globs.join(', ')} 안에서만`,
      };
    }
  }
  return { allow: true, access, relPath };
}

export function makePathGuard(config: PathGuardConfig): HookCallback {
  const log = config.log ?? ((line) => process.stderr.write(`${line}\n`));
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const decision = decidePath(config, pre.tool_name, pre.tool_input);
    if (decision.allow) return {};
    log(`[hook] deny ${pre.tool_name} ${decision.relPath ?? '?'} (${decision.reason})`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${decision.reason}: ${decision.relPath}`,
      },
    };
  };
}
