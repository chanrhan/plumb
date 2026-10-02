/**
 * `@plumb/adapter-nextjs` — 첫 어댑터 뼈대 (이슈 #8, 기획안 §4.4).
 *
 * 대상 스택: Next.js + PostgreSQL + Prisma + Vitest + fast-check + Playwright + dependency-cruiser + OpenTelemetry.
 * 구현된 메서드: `runTests` (#44, M5). 나머지는 {@link NotImplementedError}를 던지며,
 * 구현 마일스톤은 `docs/ROADMAP.md` — M4 generateStubs · M8 extractDependencies · readSchemas · collectTraces.
 */

import { type Adapter, type AdapterName, NotImplementedError, registerAdapter } from '@plumb/core';
import { runTests } from './run-tests.js';

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

/** Next.js 어댑터. 아직 비어 있는 메서드의 예정 마일스톤은 던지는 오류에 적혀 있다 */
export const nextjsAdapter: Adapter = {
  name: ADAPTER_NAME,

  /** dependency-cruiser → 블록 그래프 JSON. M8 wave 0 (M5 wave 0 1등급 검사의 원자료) */
  async extractDependencies() {
    throw new NotImplementedError('extractDependencies', 'M8');
  },

  /** `tsc --declaration` → 공개 진입점 `.d.ts`. M4 wave 1 test-writer */
  async generateStubs() {
    throw new NotImplementedError('generateStubs', 'M4');
  },

  /** Vitest → JUnit XML + 가로챈 출력 (#44). 정적 검사(depcruise)는 인터페이스 밖의 {@link runStaticChecks}로 따로 부른다 */
  runTests,

  /** OpenAPI · Prisma DMMF · AsyncAPI 파싱. M8 wave 0 */
  async readSchemas() {
    throw new NotImplementedError('readSchemas', 'M8');
  },

  /** OTLP JSON 트레이스 파일 → 스팬. M8 wave 1 흐름도 spike */
  async collectTraces() {
    throw new NotImplementedError('collectTraces', 'M8');
  },
};

/**
 * 코어 등록소에 `"nextjs"`로 등록한다. import 부작용으로 등록하지 않고 호출자가 명시적으로 부른다
 * (CLI 진입점(#7)이 설정을 읽은 뒤 어댑터 패키지를 로드하고 `register()`를 부른다). 두 번 불러도 안전하다.
 */
export function register(): void {
  registerAdapter(ADAPTER_NAME, () => nextjsAdapter);
}
