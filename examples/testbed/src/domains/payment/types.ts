// payment 도메인의 입력·출력 타입. Prisma 타입은 여기 새지 않는다 — repo.ts 가 이 타입으로 돌려준다.

export type PaymentStatus = 'PAID' | 'REFUNDED';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  paidAt: Date;
  status: PaymentStatus;
  createdAt: Date;
}

export interface Refund {
  id: string;
  paymentId: string;
  amount: number;
  requestedAt: Date;
  createdAt: Date;
}

export interface CreatePaymentInput {
  /** 최소 통화 단위의 정수 (KRW 10000 = 만 원) */
  amount: number;
  /** ISO 4217 코드. 예: 'KRW' */
  currency: string;
  /** 생략하면 지금 */
  paidAt?: Date;
}
