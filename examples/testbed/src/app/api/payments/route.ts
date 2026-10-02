// POST /payments (openapi.yaml operationId: createPayment). 파싱·검증 → 도메인 호출 → 응답 매핑만 한다.
import * as payment from '@/domains/payment';
import { handleUnexpected, json, readJsonObject, requireInteger, requireString } from '@/lib/http';
import type { Payment, PaymentModule } from '@/lib/payment-contract';

// 공개 진입점이 #19와 합의한 시그니처인지 typecheck로 확인한다 (#19 머지 전에는 여기서 실패한다)
const domain: PaymentModule = payment;

/** 도메인 Payment → openapi.yaml `Payment` (Date → ISO 8601) */
function toResponse(p: Payment) {
  return {
    id: p.id,
    amount: p.amount,
    currency: p.currency,
    paidAt: p.paidAt.toISOString(),
    status: p.status,
  };
}

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    const amount = requireInteger(body, 'amount', { min: 1 });
    const currency = requireString(body, 'currency', { minLength: 3, maxLength: 3 });

    const created = await domain.createPayment({ amount, currency });
    return json(toResponse(created), 201);
  } catch (err) {
    return handleUnexpected(err);
  }
}
