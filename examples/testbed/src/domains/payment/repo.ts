// Prisma 접근은 이 파일에서만 한다 (기획안 §4.4 "Prisma 접근은 repo에서만". #21의 depcruise 규칙이 강제).
// 도메인 로직(payment.ts)은 이 파일의 함수만 부르고 @prisma/client 를 모른다.
import { PrismaClient } from '@prisma/client';
import type { Payment, Refund } from './types';

let client: PrismaClient | undefined;

/** PrismaClient 싱글턴. 처음 부를 때 만든다 (import 시점에 DB 연결을 열지 않기 위해). */
export function prisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function findPayment(id: string): Promise<Payment | null> {
  return prisma().payment.findUnique({ where: { id } });
}

export async function insertPayment(data: { amount: number; currency: string; paidAt: Date }): Promise<Payment> {
  return prisma().payment.create({ data });
}

/**
 * 환불 행을 넣고 같은 트랜잭션에서 결제 status 를 REFUNDED 로 바꾼다.
 * 금액·시점 결정은 도메인(payment.ts)의 몫이고 여기서는 저장만 한다.
 */
export async function insertRefund(data: { paymentId: string; amount: number; requestedAt: Date }): Promise<Refund> {
  const [refund] = await prisma().$transaction([
    prisma().refund.create({ data }),
    prisma().payment.update({ where: { id: data.paymentId }, data: { status: 'REFUNDED' } }),
  ]);
  return refund;
}
