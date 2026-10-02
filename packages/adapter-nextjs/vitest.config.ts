import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 테스트 파일 여럿이 같은 examples/testbed에서 vitest · depcruise를 spawn하고 reports/junit.xml · reports/traces/를 쓴다 —
    // 파일 단위로 순서대로 돌려 서로의 결과를 지우지 않게 한다 (#44 · #45 · #59)
    fileParallelism: false,
  },
});
