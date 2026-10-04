// 단위 테스트 — 구현자 영역이다. 규칙(pay.refund-window)의 근거가 아니다.
// 규칙의 근거는 test/acceptance/** 의 인수 테스트(테스트 작성 에이전트만 쓴다, 기획안 §8.1)이고,
// 이 파일은 현재 코드가 어떻게 동작하는지를 그대로 기록한다. 그래서 "8일 지난 결제도 환불된다"가
// 통과하는 케이스로 들어 있다 — 그것이 지금의 동작이고, 첫 슬라이스의 출발점이다 (§8.3, §15.1).
// repo.ts 는 모킹한다. DB 없이 돈다.
// 공개 진입점은 tsconfig `@/*` 별칭으로 import 한다 — vitest.config.ts 의 resolve.alias 가 풀리는지 이 파일이 증명한다(#99).
// `../repo` 모킹은 상대 경로 그대로: index → payment → ./repo 이므로 같은 모듈(src/domains/payment/repo.ts)을 가리킨다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayment, PaymentNotFoundError, refund } from '@/domains/payment';
import * as repo from '../repo';
import type { Payment, Refund } from '../types';

vi.mock('../repo', () => ({
  findPayment: vi.fn(),
  insertPayment: vi.fn(),
  insertRefund: vi.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-02T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    amount: 10000,
    currency: 'KRW',
    paidAt: daysAgo(1),
    status: 'PAID',
    createdAt: daysAgo(1),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.insertPayment).mockImplementation(
    async (data): Promise<Payment> => ({ id: 'pay_new', status: 'PAID', createdAt: NOW, ...data }),
  );
  vi.mocked(repo.insertRefund).mockImplementation(
    async (data): Promise<Refund> => ({ id: 'ref_new', createdAt: NOW, ...data }),
  );
});

describe('createPayment', () => {
  it('amount·currency 로 결제를 만들고 status 는 PAID 다', async () => {
    const paidAt = daysAgo(2);
    const created = await createPayment({ amount: 25000, currency: 'KRW', paidAt });

    expect(repo.insertPayment).toHaveBeenCalledWith({ amount: 25000, currency: 'KRW', paidAt });
    expect(created).toMatchObject({ amount: 25000, currency: 'KRW', paidAt, status: 'PAID' });
  });

  it('paidAt 을 생략하면 지금으로 채운다', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      await createPayment({ amount: 5000, currency: 'KRW' });
    } finally {
      vi.useRealTimers();
    }

    expect(repo.insertPayment).toHaveBeenCalledWith({ amount: 5000, currency: 'KRW', paidAt: NOW });
  });
});

describe('refund', () => {
  it('없는 결제면 PaymentNotFoundError', async () => {
    vi.mocked(repo.findPayment).mockResolvedValue(null);

    await expect(refund('missing', NOW)).rejects.toBeInstanceOf(PaymentNotFoundError);
    await expect(refund('missing', NOW)).rejects.toMatchObject({ paymentId: 'missing' });
    expect(repo.insertRefund).not.toHaveBeenCalled();
  });

  it('1일 지난 결제는 전액 환불된다', async () => {
    vi.mocked(repo.findPayment).mockResolvedValue(payment({ id: 'pay_1d', amount: 10000, paidAt: daysAgo(1) }));

    const created = await refund('pay_1d', NOW);

    expect(repo.insertRefund).toHaveBeenCalledWith({ paymentId: 'pay_1d', amount: 10000, requestedAt: NOW });
    expect(created).toMatchObject({ paymentId: 'pay_1d', amount: 10000, requestedAt: NOW });
  });

  it('6일 지난 결제는 전액 환불된다', async () => {
    vi.mocked(repo.findPayment).mockResolvedValue(payment({ id: 'pay_6d', amount: 25000, paidAt: daysAgo(6) }));

    const created = await refund('pay_6d', NOW);

    expect(created).toMatchObject({ paymentId: 'pay_6d', amount: 25000 });
  });

  // 현재 동작 기록. 규칙 pay.refund-window("환불은 결제 후 7일 이내만")가 위반된 상태다.
  // 인수 테스트가 들어오고 구현이 바뀌면 이 케이스는 구현자가 함께 고친다.
  it('8일 지난 결제도 환불된다 (현재 동작 — 7일 검사 없음)', async () => {
    vi.mocked(repo.findPayment).mockResolvedValue(payment({ id: 'pay_8d', amount: 5000, paidAt: daysAgo(8) }));

    const created = await refund('pay_8d', NOW);

    expect(repo.insertRefund).toHaveBeenCalledWith({ paymentId: 'pay_8d', amount: 5000, requestedAt: NOW });
    expect(created).toMatchObject({ paymentId: 'pay_8d', amount: 5000, requestedAt: NOW });
  });

  it('requestedAt 을 생략하면 지금으로 채운다', async () => {
    vi.mocked(repo.findPayment).mockResolvedValue(payment());
    vi.useFakeTimers({ now: NOW });
    try {
      await refund('pay_1');
    } finally {
      vi.useRealTimers();
    }

    expect(repo.insertRefund).toHaveBeenCalledWith(expect.objectContaining({ requestedAt: NOW }));
  });
});
