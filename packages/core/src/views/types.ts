/**
 * View 생성기 공통 인터페이스 (이슈 #53). 개별 생성기(#54~#59)는 {@link ViewGenerator}를 구현하고,
 * `plumb views`(#60)가 {@link ViewContext}를 만들어 순서대로 돌린 뒤 `store.views.write()`에 넘긴다.
 *
 * View는 파서·실행 결과에서만 나온다 (기획안 §6, CLAUDE.md "하지 않는 것"). 그래서 생성기는 어댑터 · 저장소 · git 커밋만
 * 입력으로 받고, 결과 JSON(`views/<name>.json`)이 정본이며 Markdown은 그 렌더링이다 (docs/types/README.md 결정 1).
 */

import type { Adapter, AdapterContext, StaticRunner } from '../adapter/index.js';
import type { Store } from '../store/index.js';
import type { PlumbConfig, View, ViewName } from '../types/index.js';

/** View 이름 여섯 개의 고정 순서 = 탭 순서 (screens/README 1, work-views 3절 "탭 라벨과 순서는 고정 목록") */
export const VIEW_NAMES: readonly ViewName[] = [
  'architecture',
  'flow',
  'changelog',
  'verification',
  'dependencies',
  'contract',
] as const;

export function isViewName(value: unknown): value is ViewName {
  return typeof value === 'string' && (VIEW_NAMES as readonly string[]).includes(value);
}

/**
 * 모든 View 생성기의 입력. `run-check.ts`(#47)의 `runCheck({ config, root, store, adapter, now, commit })`와 같은 의존 주입 모양이라
 * `plumb check --views`가 같은 묶음을 그대로 넘길 수 있다.
 */
export interface ViewContext {
  /** 대상 레포 루트 (절대 경로). 어댑터 `AdapterContext.root`와 같다 */
  root: string;
  config: PlumbConfig;
  store: Store;
  adapter: Adapter;
  /** `plumb views` 실행 시점의 HEAD. git이 없으면 `undefined` → 머리말에 `commit` 없음 ("생성 커밋 기록 없음") */
  commit: string | undefined;
  /** 생성 시각. 테스트가 바꾼다 */
  now: () => Date;
  /** 정적 검사를 다시 돌려야 하는 생성기만 쓴다. 없으면 저장소의 마지막 `CheckRun`만 읽는다 */
  staticRunner?: StaticRunner;
}

/** `ViewContext`에서 어댑터 메서드의 첫 인자를 꺼낸다 */
export function adapterContextOf(ctx: ViewContext): AdapterContext {
  return { root: ctx.root, config: ctx.config };
}

/**
 * View 생성기 하나. `generate`는 파서·실행·저장소·git에서 JSON(정본)을 만들고, `render`는 그 JSON만 보고 Markdown을 그린다 —
 * `render`가 `ctx`를 받지 않는 것은 의도다. 저장된 JSON에서 Markdown을 언제든 다시 만들 수 있어야 한다.
 */
export interface ViewGenerator<V extends View> {
  readonly name: V['header']['view'];
  generate(ctx: ViewContext): Promise<V>;
  render(view: V): string;
}

/** 어느 View, 어느 단계였나 */
export type ViewGenerationStage = 'generate' | 'render' | 'write';

/**
 * View 생성 실패. 생성기 하나가 던져도 `plumb views`(#60)는 나머지를 계속 돌리고 이 오류를 결과 표에 적는다.
 * 원인 예외는 `cause`에 그대로 둔다 — 메시지를 요약해서 숨기지 않는다.
 */
export class ViewGenerationError extends Error {
  override readonly name = 'ViewGenerationError';
  constructor(
    readonly view: ViewName,
    readonly stage: ViewGenerationStage,
    override readonly cause: unknown,
  ) {
    super(`View ${view}: ${STAGE_LABEL[stage]} 실패 — ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const STAGE_LABEL: Record<ViewGenerationStage, string> = {
  generate: '생성',
  render: '렌더링',
  write: '저장',
};
