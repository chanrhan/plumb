/**
 * 검사 실행 결과 처리 (M5). JUnit XML 파싱(`junit.ts`) · 규칙 매핑(`junit-to-results.ts`) — 이슈 #43.
 * 상태 · 범위 밖 · 공통 검사 · 집계(#46). `plumb check` 조립(`run-check.ts`, #47).
 */

export * from './common.js';
export * from './diff-search.js';
export * from './junit.js';
export * from './junit-to-results.js';
export * from './out-of-scope.js';
export * from './run-check.js';
export * from './status.js';
export * from './summary.js';
