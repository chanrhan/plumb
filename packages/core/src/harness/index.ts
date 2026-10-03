/**
 * 하네스 — Agent SDK 위의 역할 공통부. `@plumb/core/harness` 서브패스로만 노출한다:
 * UI(Next.js)는 `@plumb/core` 루트를 import하므로 SDK(자식 프로세스 · 네이티브 optional dep)를 루트에서 re-export하지 않는다.
 */
export * from './dispute.js';
export * from './leak.js';
export * from './path-guard.js';
export * from './role-options.js';
export * from './roles/test-writer.js';
export * from './run-role.js';
export * from './stop.js';
export * from './stubs.js';
export * from './work-dir.js';
