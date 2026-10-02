// payment 도메인 공개 진입점(`src/domains/payment/index.ts`, #19)의 모양. **타입만** 둔다.
// #20의 Route Handler는 `@/domains/payment`를 import하고, 이 타입에 대입해 시그니처가 합의한 것과 같은지 typecheck로 확인한다.
// #19가 머지되기 전에는 진입점이 비어 있어 그 대입에서 typecheck가 실패한다 — 그 실패는 #19 머지 뒤 사라져야 한다.

export type PaymentStatus = 'PAID' | 'REFUNDED';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  paidAt: Date;
  status: PaymentStatus;
}

export interface Refund {
  id: string;
  paymentId: string;
  amount: number;
  requestedAt: Date;
}

export interface CreatePaymentInput {
  amount: number;
  currency: string;
  paidAt?: Date;
}

/** `import * as payment from '@/domains/payment'` 가 만족해야 하는 모양 */
export interface PaymentModule {
  createPayment(input: CreatePaymentInput): Promise<Payment>;
  refund(paymentId: string, requestedAt?: Date): Promise<Refund>;
  PaymentNotFoundError: new (...args: never[]) => Error;
}
