/**
 * implementer 역할 (이슈 #77, 기획안 §8.1 · §8.2 · §8.4).
 *   본다:   전부 (`src/**` · `test/**` · 계약). 읽기 제한 없음
 *   쓴다:   `src/**` 등 — 단 `test/acceptance/**` · `.git/**` · 저장소 · `plumb.config.json`은 설정(PreToolUse deny)으로 막힌다
 *   셸:     있다(테스트 실행에 필요). 인터넷 · git 쓰기 · 보호 경로 변경은 `bash-guard`로, 가능하면 OS `sandbox`로도
 *   이의:   테스트가 틀렸다고 보면 고치지 말고 `.work/implementer/disputes/d-<id>.md`를 쓴다(형식은 #78)
 */

import type { HookCallback, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import type { PlumbConfig, Rule } from '../../types/index.js';
import {
  GIT_WRITE_RULES,
  makeBashGuard,
  NETWORK_RULES,
  outsideCwdWriteRules,
  protectedPathRules,
} from '../bash-guard.js';
import { makePathGuard, type PathRule } from '../path-guard.js';
import { buildRoleOptions } from '../role-options.js';

export const IMPLEMENTER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;
export const IMPLEMENTER_DISALLOWED = ['NotebookEdit'] as const;

/** 서비스 루트 기준, 쓰기 금지 경로. 저장소 경로(`config.store`가 루트 안이면)는 호출 시 보탠다 */
export const IMPLEMENTER_PROTECTED_WRITE = ['test/acceptance', '.git', 'plumb.config.json', 'plumb'] as const;

export interface ImplementerInput {
  config: Pick<PlumbConfig, 'roles' | 'store' | 'work'>;
  /** 담당 규칙. 프롬프트에 진술과 테스트 파일을 적는다 */
  rules: readonly Rule[];
  /** 실패 중인 인수 테스트 파일(서비스 루트 기준). 오케스트레이터가 실행 결과에서 준다 */
  failingTests: readonly string[];
  /** 역할 cwd = 서비스 루트(또는 worktree) */
  cwd: string;
  /** 이의 제기 디렉토리 — cwd 기준 상대. 기본 `.work/implementer/disputes` */
  disputesDir?: string;
  /** 테스트 실행 명령 템플릿. 기본 `pnpm vitest run <files>` */
  testCommand?: string;
  /** OS 샌드박스를 끄고 싶을 때(플랫폼 시험용). 기본 켬 + 없으면 조용히 hook만 */
  sandbox?: boolean;
  extraPreToolUse?: HookCallbackMatcher[];
  /** 종료 조건 Stop hook (#78 `makeStopHook().hook`). 없으면 모델이 끝내는 대로 끝난다 — 오케스트레이터(M6)는 반드시 준다 */
  stopHook?: HookCallback;
  log?: (line: string) => void;
  stderr?: (data: string) => void;
}

function relStore(config: Pick<PlumbConfig, 'store'>): string | undefined {
  const s = config.store;
  if (!s || s.startsWith('/') || s.startsWith('~')) return undefined;
  return s.replace(/^\.\//, '').replace(/\/$/, '');
}

export function implementerProtectedPaths(config: Pick<PlumbConfig, 'store'>): string[] {
  const store = relStore(config);
  return [...IMPLEMENTER_PROTECTED_WRITE, ...(store ? [store] : [])];
}

export function implementerPathRules(config: Pick<PlumbConfig, 'store'>): PathRule[] {
  // 디렉토리는 `/**`, 파일(`plumb.config.json`)은 그대로
  const globs = implementerProtectedPaths(config).map((p) => (p.endsWith('.json') ? p : `${p}/**`));
  return [{ access: 'write', globs, mode: 'deny' }];
}

export function implementerSystemPrompt(
  input: Pick<ImplementerInput, 'rules' | 'failingTests' | 'disputesDir' | 'testCommand'>,
): string {
  const disputes = input.disputesDir ?? '.work/implementer/disputes';
  const testCmd = input.testCommand ?? 'pnpm vitest run <테스트 파일>';
  return [
    '너는 Plumb의 구현자(implementer)다. 실패하는 인수 테스트를 통과시키도록 구현(src/**)을 고친다.',
    '',
    '## 규칙과 테스트',
    ...input.rules.map((r) => `- ${r.id}: ${r.statement}`),
    '',
    '## 지금 실패하는 인수 테스트',
    ...(input.failingTests.length > 0 ? input.failingTests.map((f) => `- ${f}`) : ['- (오케스트레이터가 채운다)']),
    '',
    '## 할 수 있는 것',
    `- 테스트 실행: ${testCmd}`,
    '- src/** 와 단위 테스트(src/**/*.test.ts) 수정, 타입체크·빌드 실행',
    '',
    '## 할 수 없는 것 (설정으로 막혀 있다 — 거부되면 다시 시도하지 않는다)',
    '- test/acceptance/** 수정 · 삭제 · 이동. 인수 테스트는 테스트 작성자의 것이다',
    '- 인터넷(curl · wget · 패키지 설치 · git 원격). 필요한 패키지가 없으면 그 사실을 보고하고 끝낸다',
    '- git 상태 변경(commit · checkout · reset …). 커밋은 하네스가 한다. git status · diff · log 는 된다',
    '- .git/** · plumb/** · plumb.config.json · 보호 저장소 쓰기',
    '',
    '## 이의 제기',
    `- 테스트가 규칙 진술과 다르거나 통과가 불가능하다고 판단하면 **테스트를 고치지 말고** ${disputes}/d-<짧은이름>.md 를 **Write 도구로** 쓴다(이 경로 그대로 — 셸 리다이렉션으로 쓰지 않는다). 첫 줄은 한 문장 요약(10자 이상), 그 아래 근거(어떤 입력에서 진술과 테스트가 갈리는가, 20자 이상)`,
    '- 이의 제기 파일을 썼으면 더 구현하지 말고 끝낸다',
    '',
    '## 끝낼 때',
    '- 전부 통과: 바꾼 파일 목록과 마지막 테스트 실행 결과 요약을 적는다. 통과시키려고 테스트를 약화하거나 우회(skip · 조건 분기로 테스트만 통과)하지 않는다',
  ].join('\n');
}

export function implementerOptions(input: ImplementerInput): Options {
  const protectedPaths = implementerProtectedPaths(input.config);
  const pathGuard = makePathGuard({
    root: input.cwd,
    rules: implementerPathRules(input.config),
    log: input.log,
    hint: `이의 제기 파일은 ${input.disputesDir ?? '.work/implementer/disputes'} 에 Write 도구로`,
  });
  const bashGuard = makeBashGuard({
    rules: [
      ...NETWORK_RULES,
      ...GIT_WRITE_RULES,
      ...protectedPathRules(protectedPaths),
      ...outsideCwdWriteRules(input.cwd),
    ],
    log: input.log,
  });
  const useSandbox = input.sandbox ?? true;
  return buildRoleOptions({
    role: 'implementer',
    config: input.config,
    cwd: input.cwd,
    systemPrompt: implementerSystemPrompt(input),
    tools: IMPLEMENTER_TOOLS,
    extraDisallowedTools: IMPLEMENTER_DISALLOWED,
    hooks: {
      PreToolUse: [{ hooks: [pathGuard, bashGuard] }, ...(input.extraPreToolUse ?? [])],
      ...(input.stopHook ? { Stop: [{ hooks: [input.stopHook] }] } : {}),
    },
    ...(useSandbox
      ? {
          sandbox: {
            enabled: true,
            // 샌드박스를 못 쓰는 플랫폼에서도 돈다 — 그때는 hook이 유일한 방어 (프로브 출력에 적는다)
            failIfUnavailable: false,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: [], strictAllowlist: true },
            filesystem: { denyWrite: protectedPaths },
          },
        }
      : {}),
    stderr: input.stderr,
  });
}
