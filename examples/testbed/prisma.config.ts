import { defineConfig } from 'prisma/config';

// prisma.config.ts가 있으면 Prisma CLI는 .env를 자동으로 읽지 않는다. 여기서 직접 읽는다.
// .env가 없으면(CI, 갓 clone한 환경) .env.example과 같은 로컬 기본값으로 둔다 —
// `prisma validate`가 DATABASE_URL 없이도 통과해야 골격 검증이 DB 없이 돈다.
try {
  process.loadEnvFile('.env');
} catch {
  // .env 없음
}
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/testbed';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    // Prisma 6 방식. package.json 의 "prisma.seed" 는 deprecated.
    seed: 'tsx prisma/seed.ts',
  },
});
