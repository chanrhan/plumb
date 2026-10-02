// payment 도메인 로직. DB 는 repo.ts 를 통해서만 만진다.
import { findPayment, insertPayment, insertRefund } from './repo';
import type { CreatePaymentInput, Payment, Refund } from './types';

export class PaymentNotFoundError extends Error {
  readonly paymentId: string;

  constructor(paymentId: string) {
    super(`payment not found: ${paymentId}`);
    this.name = 'PaymentNotFoundError';
    this.paymentId = paymentId;
  }
}

export async function createPayment(input: CreatePaymentInput): Promise<Payment> {
  return insertPayment({
    amount: input.amount,
    currency: input.currency,
    paidAt: input.paidAt ?? new Date(),
  });
}

/**
 * 결제를 전액 환불한다.
 *
 * 의도적으로 7일 검사가 없다. 규칙 pay.refund-window 위반 상태 = 첫 슬라이스 출발점 (기획안 §8.3, §15.1).
 * 결제가 있으면 requestedAt 이 paidAt 에서 얼마나 지났든 환불 행을 만들고 status 를 REFUNDED 로 바꾼다.
 *
 * @throws PaymentNotFoundError 결제가 없을 때
 */
export async function refund(paymentId: string, requestedAt: Date = new Date()): Promise<Refund> {
  const payment = await findPayment(paymentId);
  if (payment === null) {
    throw new PaymentNotFoundError(paymentId);
  }
  return insertRefund({ paymentId: payment.id, amount: payment.amount, requestedAt });
}
