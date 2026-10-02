/**
 * `@plumb/adapter-nextjs` — 첫 어댑터 뼈대 (이슈 #8, 기획안 §4.4).
 *
 * 대상 스택: Next.js + PostgreSQL + Prisma + Vitest + fast-check + Playwright + dependency-cruiser + OpenTelemetry.
 * 이 단계에서는 인터페이스와 등록 방식만 정한다. 다섯 메서드 모두 {@link NotImplementedError}를 던지며,
 * 구현 마일스톤은 `docs/ROADMAP.md` — M4 generateStubs · M5 runTests · M8 extractDependencies · readSchemas · collectTraces.
 */

import { type Adapter, type AdapterName, NotImplementedError, registerAdapter } from '@plumb/core';

/** 등록 이름. `plumb.config.json`의 `adapter: "nextjs"` */
export const ADAPTER_NAME: AdapterName = 'nextjs';

/** Next.js 어댑터. 구현은 비어 있다 — 각 메서드의 예정 마일스톤은 던지는 오류에 적혀 있다 */
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

  /** Vitest(+ Playwright) → JUnit XML. M5 wave 0 */
  async runTests() {
    throw new NotImplementedError('runTests', 'M5');
  },

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
