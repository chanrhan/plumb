// POST /refunds (openapi.yaml operationId: createRefund). 파싱·검증 → 도메인 호출 → 응답 매핑만 한다.
// 계약의 422 REFUND_WINDOW_EXCEEDED 는 의도적으로 내지 않는다 — 규칙 pay.refund-window 승인 뒤 구현한다 (기획안 §5.4).
import * as payment from '@/domains/payment';
import { error, handleUnexpected, json, readJsonObject, requireString } from '@/lib/http';
import type { PaymentModule, Refund } from '@/lib/payment-contract';

// 공개 진입점이 #19와 합의한 시그니처인지 typecheck로 확인한다 (#19 머지 전에는 여기서 실패한다)
const domain: PaymentModule = payment;

/** 도메인 Refund → openapi.yaml `Refund` (Date → ISO 8601) */
function toResponse(r: Refund) {
  return {
    id: r.id,
    paymentId: r.paymentId,
    amount: r.amount,
    requestedAt: r.requestedAt.toISOString(),
  };
}

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    const paymentId = requireString(body, 'paymentId', { minLength: 1 });

    const created = await domain.refund(paymentId);
    return json(toResponse(created), 201);
  } catch (err) {
    if (err instanceof domain.PaymentNotFoundError) {
      return error(404, 'PAYMENT_NOT_FOUND', err.message);
    }
    return handleUnexpected(err);
  }
}
