/**
 * `plumb views [names...] [--json]` (이슈 #60, 기획안 §11). View를 파서 · 실행 결과에서 다시 만들어 `views/<name>.json` · `.md`에 쓴다.
 *
 * 흐름: `--target` → 설정 → 저장소 → 어댑터 로드(`buildViewContext`, `check`와 같은 방식) → `generateViews()` → 표.
 * 표: View · 결과 · 생성 시각 · 출처 수 · 파일. 등록되지 않은 View는 "아직 없음" — 목 데이터로 채우지 않는다.
 * 종료 코드: 0 전부 생성(또는 아직 없음) · 1 하나라도 실패 · 2 모르는 View 이름.
 */

import { relative } from 'node:path';
import type { Command } from 'commander';
import type { ViewName } from '../../types/index.js';
import { buildViewContext, formatSummary, generateViews, type ViewGenerationResult } from '../../views/generate.js';
import { VIEW_PLANNED_IN } from '../../views/registry.js';
import { isViewName, VIEW_NAMES } from '../../views/types.js';
import {
  type CliContext,
  displayWidth,
  EXIT_ERROR,
  EXIT_INPUT,
  EXIT_OK,
  type OpenedStore,
  openTargetStore,
  renderTable,
  runCommand,
  targetOf,
  writeJson,
} from './shared.js';

export interface ViewsOptions {
  json: boolean;
}

/** 모르는 이름 → stderr 한 줄용 */
export function unknownViewMessage(name: string): string {
  return `plumb views: 모르는 View 이름 "${name}" — ${VIEW_NAMES.join(' · ')} 중 하나`;
}

/** 결과 열 한 칸 */
export function resultText(result: ViewGenerationResult): string {
  if ('skipped' in result) {
    const planned = VIEW_PLANNED_IN[result.name];
    return planned === undefined ? '아직 없음' : `아직 없음 (${planned})`;
  }
  if (result.ok) return '생성됨';
  return `실패(${STAGE_SHORT[result.stage]}): ${result.error}`;
}

const STAGE_SHORT = { generate: '생성', render: '렌더링', write: '저장' } as const;

/** 표 + 요약 한 줄 */
export function renderViews(ctx: CliContext, results: readonly ViewGenerationResult[]): string {
  const base = ctx.cwd ?? process.cwd();
  const rows = results.map((result) => ({
    name: result.name,
    result: resultText(result),
    generatedAt: 'ok' in result && result.ok ? result.generatedAt : '—',
    sources: 'ok' in result && result.ok ? String(result.sources) : '—',
    files:
      'ok' in result && result.ok ? `${relative(base, result.files.json)} · ${relative(base, result.files.md)}` : '—',
  }));
  const width = (key: keyof (typeof rows)[number], min: number) =>
    Math.max(min, ...rows.map((row) => displayWidth(row[key])));
  const table = renderTable(
    [
      { header: 'View', width: width('name', 12), cell: (row) => row.name },
      { header: '결과', width: Math.min(width('result', 8), 60), cell: (row) => row.result },
      { header: '생성 시각', width: 24, cell: (row) => row.generatedAt },
      { header: '출처', width: 4, cell: (row) => row.sources },
      { header: '파일', width: width('files', 6), cell: (row) => row.files },
    ],
    rows,
  );
  const failures = results.filter((r): r is Extract<ViewGenerationResult, { ok: false }> => 'ok' in r && !r.ok);
  const detail = failures.map((f) => `  ${f.name}: ${f.error}`);
  return `${table}${formatSummary(results)}\n${detail.length === 0 ? '' : `${detail.join('\n')}\n`}`;
}

/** `--json`용: `cause`(Error)는 빼고 메시지만 */
export function toJsonResult(result: ViewGenerationResult): Record<string, unknown> {
  if ('skipped' in result) return { name: result.name, skipped: result.skipped };
  if (result.ok) return { ...result };
  const { cause: _cause, ...rest } = result;
  return rest;
}

export function exitCodeOf(results: readonly ViewGenerationResult[]): number {
  return results.some((r) => 'ok' in r && !r.ok) ? EXIT_ERROR : EXIT_OK;
}

/** 이름 검사. 모르는 이름이 있으면 그 이름, 없으면 `ViewName[]`(비면 `undefined` = 전부) */
export function parseViewNames(names: readonly string[]): { unknown: string } | { names: ViewName[] | undefined } {
  const unknown = names.find((name) => !isViewName(name));
  if (unknown !== undefined) return { unknown };
  return { names: names.length === 0 ? undefined : (names as ViewName[]) };
}

export async function viewsCommand(
  ctx: CliContext,
  opened: OpenedStore,
  wanted: readonly ViewName[] | undefined,
  options: ViewsOptions,
): Promise<number> {
  const { config, loaded, store } = opened;
  const viewCtx = await buildViewContext({
    config,
    root: loaded.root,
    store,
    ...(ctx.loadAdapter === undefined ? {} : { loadAdapter: ctx.loadAdapter }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });
  const results = await generateViews(viewCtx, wanted, {
    ...(ctx.viewGenerators === undefined ? {} : { generators: ctx.viewGenerators }),
  });
  const code = exitCodeOf(results);

  if (options.json) {
    writeJson(ctx, {
      ...(viewCtx.commit === undefined ? {} : { commit: viewCtx.commit }),
      views: results.map(toJsonResult),
      exitCode: code,
    });
  } else {
    ctx.stdout.write(renderViews(ctx, results));
  }
  return code;
}

export function registerViewsCommand(program: Command, ctx: CliContext): Command {
  return program
    .command('views')
    .description('View를 파서 · 실행 결과에서 다시 만든다 (M8). 이름을 주면 그것만')
    .argument('[names...]', `View 이름 (${VIEW_NAMES.join(' · ')})`)
    .option('--json', '기계용 JSON 출력', false)
    .action(async (names: string[], options: ViewsOptions, command: Command) => {
      await runCommand(ctx, async () => {
        // 모르는 이름은 설정 · 저장소를 열기 전에 거른다 (exit 2)
        const parsed = parseViewNames(names);
        if ('unknown' in parsed) {
          ctx.stderr.write(`${unknownViewMessage(parsed.unknown)}\n`);
          return EXIT_INPUT;
        }
        return viewsCommand(ctx, await openTargetStore(ctx, targetOf(command)), parsed.names, options);
      });
    });
}
