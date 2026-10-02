// 시드: 결제 3건 — 1일 전·6일 전·8일 전 (금액 10000·25000·5000 KRW).
// 첫 슬라이스(pay.refund-window: 환불은 결제 후 7일 이내만)의 입력이다.
// 1일·6일 전 결제는 창 안, 8일 전 결제는 창 밖 — naive refund()는 셋 다 환불한다.
// 실행: pnpm --filter @plumb/testbed db:seed  (prisma.config.ts 의 migrations.seed 에도 등록돼 있어
// `prisma migrate dev` / `prisma db seed` 가 같은 파일을 돈다)
import { PrismaClient } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

const prisma = new PrismaClient();

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

async function main(): Promise<void> {
  const now = new Date();
  const payments = [
    { id: 'seed-paid-1d-ago', amount: 10000, currency: 'KRW', paidAt: daysAgo(1, now) },
    { id: 'seed-paid-6d-ago', amount: 25000, currency: 'KRW', paidAt: daysAgo(6, now) },
    { id: 'seed-paid-8d-ago', amount: 5000, currency: 'KRW', paidAt: daysAgo(8, now) },
  ];

  // 멱등: 다시 돌려도 같은 상태가 되도록 비우고 넣는다
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.payment.createMany({ data: payments });

  for (const p of payments) {
    console.log(`seed: ${p.id} ${p.amount} ${p.currency} paidAt=${p.paidAt.toISOString()}`);
  }
  console.log(`seed: ${payments.length} payments`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
