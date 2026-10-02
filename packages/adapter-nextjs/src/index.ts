/**
 * `@plumb/adapter-nextjs` — 첫 어댑터 뼈대 (이슈 #8, 기획안 §4.4).
 *
 * 대상 스택: Next.js + PostgreSQL + Prisma + Vitest + fast-check + Playwright + dependency-cruiser + OpenTelemetry.
 * 구현된 메서드: `extractDependencies`(#45) · `runTests`(#44) · `readSchemas`(#55) · `collectTraces`(#59). 나머지는 {@link NotImplementedError}를 던지며,
 * 구현 마일스톤은 `docs/ROADMAP.md` — M4 generateStubs.
 * 인터페이스 밖의 추가 능력: 정적 호출 그래프 `buildCallGraph`(#59, 코어 `CallGraphProvider`) — 흐름도 View가 덕 타이핑으로 찾는다.
 */

import {
  type Adapter,
  type AdapterName,
  type CallGraphProvider,
  NotImplementedError,
  registerAdapter,
} from '@plumb/core';
import { buildCallGraph } from './call-graph.js';
import { collectTraces } from './collect-traces.js';
import { extractDependencies } from './extract-dependencies.js';
import { readSchemas } from './read-schemas.js';
import { runTests } from './run-tests.js';

export * from './call-graph.js';
export * from './collect-traces.js';
export * from './extract-dependencies.js';
export * from './read-schemas.js';
export { runTests } from './run-tests.js';
export {
  DEPCRUISE_REF_PREFIX,
  type DepcruiseJson,
  type DepcruiseViolation,
  runStaticChecks,
  type StaticCheckRun,
  toStaticCheckResults,
} from './static-checks.js';

/** 등록 이름. `plumb.config.json`의 `adapter: "nextjs"` */
export const ADAPTER_NAME: AdapterName = 'nextjs';

/** Next.js 어댑터. 미구현 메서드의 예정 마일스톤은 던지는 오류에 적혀 있다 */
export const nextjsAdapter: Adapter & CallGraphProvider = {
  name: ADAPTER_NAME,

  /** dependency-cruiser JSON + `config.blocks` → 블록 그래프 JSON (#45, `extract-dependencies.ts`) */
  extractDependencies: (ctx) => extractDependencies(ctx),

  /** `tsc --declaration` → 공개 진입점 `.d.ts`. M4 wave 1 test-writer */
  async generateStubs() {
    throw new NotImplementedError('generateStubs', 'M4');
  },

  /** Vitest → JUnit XML + 가로챈 출력 (#44). 정적 검사(depcruise)는 인터페이스 밖의 {@link runStaticChecks}로 따로 부른다 */
  runTests,

  /** OpenAPI(yaml) · Prisma DMMF(`@prisma/internals`) · AsyncAPI 파싱 → `SchemaSet` (#55, `read-schemas.ts`) */
  readSchemas: (ctx) => readSchemas(ctx),

  /** Vitest + `instrumentation-test.ts` → `reports/traces/*.jsonl` → 스팬. 파일이 없으면 `unavailable` (#59, `collect-traces.ts`) */
  collectTraces: (ctx, opts) => collectTraces(ctx, opts),

  /** TS 컴파일러 API 정적 호출 그래프 — 흐름도의 점선(A안) · 본체(B안) (#59, `call-graph.ts`) */
  buildCallGraph: (ctx) => buildCallGraph(ctx),
};

/**
 * 코어 등록소에 `"nextjs"`로 등록한다. import 부작용으로 등록하지 않고 호출자가 명시적으로 부른다
 * (CLI 진입점(#7)이 설정을 읽은 뒤 어댑터 패키지를 로드하고 `register()`를 부른다). 두 번 불러도 안전하다.
 */
export function register(): void {
  registerAdapter(ADAPTER_NAME, () => nextjsAdapter);
}
