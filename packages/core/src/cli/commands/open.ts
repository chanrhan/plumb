/**
 * `plumb open <file>:<line> --reason <view-error|missing-info|debugging-env> [--view <name>] [--item <id>] [--note <한 줄>]`
 * (이슈 #60, screens/README 2.2, 기획안 §3 · §15.3). IDE 명령(`config.ide`, 기본 `code --goto {file}:{line}`)을 셸 없이 띄우고,
 * **성공 · 실패와 무관하게** `code-opens.jsonl`에 한 줄 남긴다 — 명제 검증에는 "보려 했다"가 중요하다.
 *
 * `--reason`이 없거나 세 가지 밖이면 exit 2 — "이유를 고르지 않으면 열리지 않는다" (README 2.2). 아무것도 기록하지 않는다.
 * IDE 명령이 실패하면(명령 없음 · 종료 ≠ 0) 기록은 `result.status: 'failed'`로 남고 exit 1 — 열어 달라는 요청은 실패했다.
 * `--view`를 주면 그 View의 머리말 `commit`을 `viewCommit`에 적는다 ("이 생성 커밋 이후 열람 n회"의 근거).
 */

import type { Command } from 'commander';
import { DEFAULT_IDE_COMMAND, openInIde } from '../../ide/open.js';
import { CODE_OPEN_REASONS, type CodeOpenInput, isCodeOpenReason } from '../../store/code-opens.js';
import type { CodeOpenReason, ViewName } from '../../types/index.js';
import { isViewName, VIEW_NAMES } from '../../views/types.js';
import {
  type CliContext,
  EXIT_ERROR,
  EXIT_INPUT,
  EXIT_OK,
  type OpenedStore,
  openTargetStore,
  runCommand,
  targetOf,
  writeJson,
} from './shared.js';

export interface OpenOptions {
  reason?: string;
  view?: string;
  item?: string;
  note?: string;
  json: boolean;
}

export interface OpenTarget {
  file: string;
  line?: number;
}

/** `src/a.ts:30` → `{ file, line }`. 줄이 없거나 숫자가 아니면 전체를 파일로 본다 (`C:\\x.ts` 같은 드라이브 문자도 안전) */
export function parseOpenTarget(text: string): OpenTarget | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (match?.[1] !== undefined && match[1].length > 0) {
    return { file: match[1], line: Number(match[2]) };
  }
  return { file: trimmed };
}

export function reasonRequiredMessage(): string {
  return `plumb open: --reason <${CODE_OPEN_REASONS.join('|')}> 이 필요하다 — 이유를 고르지 않으면 열리지 않는다`;
}

export async function openCommand(
  ctx: CliContext,
  opened: OpenedStore,
  target: OpenTarget,
  reason: CodeOpenReason,
  options: Omit<OpenOptions, 'reason'> & { view?: ViewName },
): Promise<number> {
  const { config, loaded, store } = opened;
  const template = config.ide ?? DEFAULT_IDE_COMMAND;

  let viewCommit: string | undefined;
  if (options.view !== undefined) {
    const stored = await store.views.read(options.view).catch(() => null);
    viewCommit = stored?.view.header.commit;
  }

  const result = await openInIde(target, { template, cwd: loaded.root });

  const input: CodeOpenInput = {
    file: target.file,
    reason,
    result,
    ...(target.line === undefined ? {} : { line: target.line }),
    ...(options.view === undefined ? {} : { view: options.view }),
    ...(options.item === undefined ? {} : { item: options.item }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(viewCommit === undefined ? {} : { viewCommit }),
  };
  const record = await store.codeOpens.append(input);

  if (options.json) {
    writeJson(ctx, { record, path: store.paths.codeOpens });
  } else if (result.status === 'opened') {
    ctx.stdout.write(`IDE에서 열음: ${record.item} (${result.command}) · 기록: ${store.paths.codeOpens}\n`);
  } else {
    ctx.stderr.write(`plumb open: IDE를 열지 못함: ${result.command} — ${result.error}\n`);
    ctx.stdout.write(`기록: ${store.paths.codeOpens} (result: failed)\n`);
  }
  return result.status === 'opened' ? EXIT_OK : EXIT_ERROR;
}

export function registerOpenCommand(program: Command, ctx: CliContext): Command {
  return program
    .command('open')
    .description('코드 열람 점프: <file>:<line>을 IDE로 열고 이유를 기록한다 (M8)')
    .argument('<target>', '<file>:<line> (줄 생략 가능)')
    .option('--reason <reason>', `이유 (필수): ${CODE_OPEN_REASONS.join(' · ')}`)
    .option('--view <name>', `어느 View에서 (${VIEW_NAMES.join(' · ')})`)
    .option('--item <id>', '어느 항목에서 (식별자 또는 라벨). 기본 file:line')
    .option('--note <text>', '메모 한 줄')
    .option('--json', '기록한 줄을 JSON으로', false)
    .action(async (targetText: string, options: OpenOptions, command: Command) => {
      await runCommand(ctx, async () => {
        const target = parseOpenTarget(targetText);
        if (target === null) {
          ctx.stderr.write('plumb open: 대상 <file>:<line>이 비어 있다\n');
          return EXIT_INPUT;
        }
        if (!isCodeOpenReason(options.reason)) {
          ctx.stderr.write(`${reasonRequiredMessage()}\n`);
          return EXIT_INPUT;
        }
        if (options.view !== undefined && !isViewName(options.view)) {
          ctx.stderr.write(`plumb open: 모르는 View 이름 "${options.view}" — ${VIEW_NAMES.join(' · ')} 중 하나\n`);
          return EXIT_INPUT;
        }
        const { reason, view, ...rest } = options;
        return openCommand(ctx, await openTargetStore(ctx, targetOf(command)), target, reason, {
          ...rest,
          ...(view === undefined ? {} : { view: view as ViewName }),
        });
      });
    });
}
