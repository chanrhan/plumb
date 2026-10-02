/**
 * `generateViews(ctx, names?)` (이슈 #60, 기획안 §11 "세션 종료 · 커밋 시 View 갱신"). 등록된 생성기를 `generate → render → store.views.write`로
 * 돌리고 결과 표를 돌려준다. **하나가 던져도 나머지는 계속** — 실패는 `ok: false`로 적고 원인은 `cause`에 그대로 둔다.
 *
 * 순서: 요청된(또는 전부) 이름을 `VIEW_NAMES`(탭) 순서로. 어댑터로 테스트 러너를 돌리는 생성기(`TEST_RUNNER_VIEWS`, 지금은 `flow`)는
 * 다른 것과 `reports/`를 두고 겹치지 않게 **병렬 묶음이 끝난 뒤 순차**로. 나머지는 `Promise.allSettled`로 병렬.
 * 결과 배열의 순서는 실행 순서가 아니라 탭 순서다.
 */

import type { View, ViewName } from '../types/index.js';
import { TEST_RUNNER_VIEWS, VIEW_GENERATORS, type ViewGeneratorMap } from './registry.js';
import {
  VIEW_NAMES,
  type ViewContext,
  ViewGenerationError,
  type ViewGenerationStage,
  type ViewGenerator,
} from './types.js';

export * from './context.js';
export * from './registry.js';

export type ViewGenerationResult =
  | {
      name: ViewName;
      ok: true;
      generatedAt: string;
      /** 머리말 `commit`. git이 없으면 없음 */
      commit?: string;
      /** 머리말 `sources[]` 수 — 출처 0개를 숨기지 않는다 */
      sources: number;
      files: { json: string; md: string };
    }
  | {
      name: ViewName;
      ok: false;
      stage: ViewGenerationStage;
      /** 메시지 한 줄. 원인 예외는 `cause` */
      error: string;
      cause: ViewGenerationError;
    }
  | { name: ViewName; skipped: 'not-implemented' };

export interface GenerateViewsOptions {
  /** 생성기 표. 기본 {@link VIEW_GENERATORS}. 테스트는 가짜를 넣는다 */
  generators?: ViewGeneratorMap;
  /** 순차로 돌릴 이름. 기본 {@link TEST_RUNNER_VIEWS} */
  sequential?: ReadonlySet<ViewName>;
}

/** 결과 요약 수 (`plumb views` 마지막 줄 · `check --views` 한 줄) */
export interface ViewGenerationSummary {
  generated: number;
  failed: number;
  notImplemented: number;
}

export function summarizeResults(results: readonly ViewGenerationResult[]): ViewGenerationSummary {
  const summary: ViewGenerationSummary = { generated: 0, failed: 0, notImplemented: 0 };
  for (const result of results) {
    if ('skipped' in result) summary.notImplemented += 1;
    else if (result.ok) summary.generated += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** `View 갱신: 5 생성 · 0 실패 · 1 아직 없음` */
export function formatSummary(results: readonly ViewGenerationResult[]): string {
  const s = summarizeResults(results);
  return `View 갱신: ${s.generated} 생성 · ${s.failed} 실패 · ${s.notImplemented} 아직 없음`;
}

/** 요청 이름을 탭 순서로 정렬하고 중복을 없앤다. 없으면 전부 */
export function orderViewNames(names?: readonly ViewName[]): ViewName[] {
  if (names === undefined) return [...VIEW_NAMES];
  const wanted = new Set(names);
  return VIEW_NAMES.filter((name) => wanted.has(name));
}

async function generateOne(
  ctx: ViewContext,
  name: ViewName,
  generator: ViewGenerator<View>,
): Promise<ViewGenerationResult> {
  const fail = (stage: ViewGenerationStage, cause: unknown): ViewGenerationResult => {
    const error = cause instanceof ViewGenerationError ? cause : new ViewGenerationError(name, stage, cause);
    return { name, ok: false, stage, error: error.message, cause: error };
  };

  let view: View;
  try {
    view = await generator.generate(ctx);
  } catch (cause) {
    return fail('generate', cause);
  }
  let markdown: string;
  try {
    markdown = generator.render(view);
  } catch (cause) {
    return fail('render', cause);
  }
  try {
    await ctx.store.views.write(name, view, markdown);
  } catch (cause) {
    return fail('write', cause);
  }
  return {
    name,
    ok: true,
    generatedAt: view.header.generatedAt,
    ...(view.header.commit === undefined ? {} : { commit: view.header.commit }),
    sources: view.header.sources.length,
    files: { json: ctx.store.paths.view(name, 'json'), md: ctx.store.paths.view(name, 'md') },
  };
}

export async function generateViews(
  ctx: ViewContext,
  names?: readonly ViewName[],
  options: GenerateViewsOptions = {},
): Promise<ViewGenerationResult[]> {
  const generators = options.generators ?? VIEW_GENERATORS;
  const sequential = options.sequential ?? TEST_RUNNER_VIEWS;
  const ordered = orderViewNames(names);
  const results = new Map<ViewName, ViewGenerationResult>();

  const parallel: Array<{ name: ViewName; generator: ViewGenerator<View> }> = [];
  const serial: Array<{ name: ViewName; generator: ViewGenerator<View> }> = [];
  for (const name of ordered) {
    const generator = generators[name];
    if (generator === undefined) {
      results.set(name, { name, skipped: 'not-implemented' });
      continue;
    }
    (sequential.has(name) ? serial : parallel).push({ name, generator });
  }

  const settled = await Promise.allSettled(parallel.map(({ name, generator }) => generateOne(ctx, name, generator)));
  settled.forEach((outcome, index) => {
    const entry = parallel[index];
    if (entry === undefined) return;
    // generateOne은 던지지 않지만, 만약을 위해 rejected도 결과 행으로 바꾼다
    results.set(
      entry.name,
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            name: entry.name,
            ok: false,
            stage: 'generate',
            error: String(outcome.reason),
            cause: new ViewGenerationError(entry.name, 'generate', outcome.reason),
          },
    );
  });

  for (const { name, generator } of serial) {
    results.set(name, await generateOne(ctx, name, generator));
  }

  return ordered.map((name) => results.get(name) ?? { name, skipped: 'not-implemented' });
}
