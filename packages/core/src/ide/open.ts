/**
 * IDE로 `file:line` 열기 (이슈 #60, screens/README 2.2, 기획안 §3 "코드를 봐야 하는 상황이면 IDE를 연다. 도구는 코드를 보여주지 않는다").
 *
 * 설정 `ide`는 명령 템플릿이다 — 기본 `code --goto {file}:{line}`. `{file}` `{line}`을 치환한 뒤 **셸 없이** `spawn`한다
 * (템플릿은 공백으로 나눈다. 따옴표 · 셸 문법은 해석하지 않는다 — 파일 경로가 명령으로 바뀌지 않게).
 * 결과는 `CodeOpenRecord['result']` 모양 그대로다: 종료 0이면 `opened`, 명령이 없거나(ENOENT) 종료 ≠ 0이면 `failed`.
 * 호출자(`plumb open` · `POST /api/open`)는 성공 · 실패와 무관하게 `store.codeOpens.append()`한다.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { CodeOpenRecord } from '../types/index.js';

export const DEFAULT_IDE_COMMAND = 'code --goto {file}:{line}';

/** `code --goto` 같은 명령은 실행 중인 IDE에 넘기고 바로 끝난다. 이 시간 안에 안 끝나면 열린 것으로 본다 (GUI를 직접 띄운 경우) */
export const IDE_EXIT_WAIT_MS = 10_000;

export interface IdeTarget {
  file: string;
  line?: number;
}

/** 템플릿 → argv. `{line}`이 없으면 `:{line}` 꼬리와 `{line}` 토큰을 지운다 (`code --goto src/a.ts`) */
export function renderIdeCommand(template: string, target: IdeTarget): string[] {
  const line = target.line === undefined ? undefined : String(target.line);
  const tokens = template
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const out: string[] = [];
  for (const token of tokens) {
    let text = token;
    if (line === undefined) {
      text = text.replace(/:\{line\}/g, '').replace(/\{line\}/g, '');
      if (text.length === 0) continue;
    } else {
      text = text.replace(/\{line\}/g, line);
    }
    out.push(text.replace(/\{file\}/g, target.file));
  }
  return out;
}

/** 표시 · 기록용 한 줄 (`command` 필드). 공백이 든 인자는 따옴표로 */
export function formatCommand(argv: readonly string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

export type SpawnLike = typeof nodeSpawn;

export interface OpenInIdeOptions {
  /** 명령 템플릿. 기본 {@link DEFAULT_IDE_COMMAND} (`config.ide`) */
  template?: string;
  /** 작업 폴더 — 상대 경로 `file`의 기준. 보통 대상 루트 */
  cwd?: string;
  /** 테스트가 바꾼다 */
  spawn?: SpawnLike;
  /** 기본 {@link IDE_EXIT_WAIT_MS} */
  waitMs?: number;
}

/**
 * IDE 명령을 돌리고 결과를 돌려준다. 던지지 않는다 — 실패도 기록해야 하므로 `failed`로 돌려준다.
 */
export async function openInIde(target: IdeTarget, options: OpenInIdeOptions = {}): Promise<CodeOpenRecord['result']> {
  const template =
    options.template === undefined || options.template.trim().length === 0 ? DEFAULT_IDE_COMMAND : options.template;
  const argv = renderIdeCommand(template, target);
  const command = formatCommand(argv);
  const [bin, ...args] = argv;
  if (bin === undefined) {
    return { status: 'failed', command: template, error: 'IDE 명령 템플릿이 비어 있다' };
  }
  const spawn = options.spawn ?? nodeSpawn;
  const waitMs = options.waitMs ?? IDE_EXIT_WAIT_MS;

  return new Promise((resolveResult) => {
    let settled = false;
    const settle = (result: CodeOpenRecord['result']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    let child: ReturnType<SpawnLike>;
    try {
      child = spawn(bin, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdio: 'ignore',
        detached: true,
      });
    } catch (error) {
      settle({ status: 'failed', command, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      // GUI를 직접 띄운 경우 — 부모와 분리하고 열린 것으로 본다
      child.unref();
      settle({ status: 'opened', command });
    }, waitMs);
    timer.unref();
    child.once('error', (error: NodeJS.ErrnoException) => {
      settle({
        status: 'failed',
        command,
        error: error.code === 'ENOENT' ? `명령을 찾을 수 없다: ${bin}` : error.message,
      });
    });
    child.once('exit', (code, signal) => {
      if (code === 0) settle({ status: 'opened', command });
      else
        settle({
          status: 'failed',
          command,
          ...(code === null ? {} : { exitCode: code }),
          error: code === null ? `시그널 ${signal ?? '?'}로 끝남` : `종료 코드 ${code}`,
        });
    });
  });
}
