import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// .env는 git에 올라가지 않으므로(CI, 갓 clone한 환경) 없을 수 있다. prisma.config.ts와 같은 방식으로
// 있으면 읽고, 없으면 .env.example과 같은 로컬 기본값을 둔다 — DB가 없어도 설정 로드 자체는 실패하지 않는다.
try {
  process.loadEnvFile('.env');
} catch {
  // .env 없음
}
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/testbed';

export default defineConfig({
  // tsconfig.json `paths`의 `@/*` → `./src/*`. Next.js는 tsconfig paths를 자체 해석하지만 Vitest(Vite)는 아니므로
  // 여기서 같은 값으로 맞춘다. 없으면 `@/domains/payment`를 import하는 테스트가 구현과 무관하게 로드 단계에서
  // 죽는다(로컬 실행 r-0001 이의 제기 d-alias-unresolved, #99). tsconfig paths를 바꾸면 이 줄도 함께 바꾼다.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // src/**/*.test.ts: 구현자의 단위 테스트(규칙 근거 아님). test/**/*.spec.ts: 인수 테스트(테스트 작성자만, 기획안 §8.1)
    include: ['src/**/*.test.ts', 'test/**/*.spec.ts'],
    // JUnit 리포터는 항상 켠다. reports/junit.xml이 M5 `plumb check`의 입력이다 (기획안 §4.2 공통 형식)
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    // 테스트가 0개여도(지금) 통과하고 junit.xml은 생긴다
    passWithNoTests: true,
    // OTel 스팬 수집(#59 → A안). 테스트별 루트 스팬 + 블록 공개 진입점 래핑 + Prisma 계측 → reports/traces/*.jsonl
    setupFiles: ['./test/setup.ts', './instrumentation-test.ts'],
    env: { DATABASE_URL },
    // DB를 쓰는 테스트는 파일 단위 프로세스 격리로 돌린다
    pool: 'forks',
  },
});
