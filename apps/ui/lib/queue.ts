/**
 * `/queue` 화면과 검토 대기열 API가 공유하는 서버 쪽 읽기 · 처리 모델 (이슈 #120, 기획안 §9.2 · §6.4, compare 13절 M10-07).
 * 값은 전부 저장소의 `review-queue/*.json`에서 온다 — 목 데이터 없음. 쓰기는 `store.reviewQueue.resolve` 하나뿐이고 그것도 `resolvedAt`만 찍는다.
 *
 * - `readReviewQueue()`: 항목 전부(생성 순) + 열린 수. 열린 것만 보이는 기본 · "처리됨 보기"는 `applyReviewQueueFilter`가 거른다
 * - `resolveReviewQueueItem(id, body)`: 없는 id → 404 `review-item-not-found`, 이미 처리 → 409 `review-item-resolved`(이미 처리된 항목을 같이 준다 —
 *   화면은 다시 읽는다). 세션 쿠키 검사는 `/api/**` 미들웨어가 먼저 한다 (approve route와 같은 보호)
 * - 이의 제기의 **판정 결과를 규칙 상태에 반영**(🟠 보류)하는 것은 M10-17 — 여기 없다
 */

import {
  type ApiError,
  isReviewQueueItemId,
  type ResolveReviewItemRequest,
  type ResolveReviewItemResponse,
  ReviewItemNotFoundError,
  type ReviewQueueFilter,
  type ReviewQueueItem,
  type ReviewQueueItemId,
  type ReviewQueueResponse,
  ValidationError,
} from '@plumb/core';
import { getStore } from './store';

export { isReviewQueueItemId };

/** 처리한 통로 — UI 토큰 세션 (`lib/rules-api.ts`의 `APPROVED_BY`와 같은 값) */
export const RESOLVED_BY = 'ui';

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

/** `GET /api/queue` 본문. 저장소: `review-queue/*.json` 전부(생성 순) + `resolvedAt` 없는 수 */
export async function readReviewQueue(): Promise<ReviewQueueResponse> {
  const store = await getStore();
  const items = await store.reviewQueue.list();
  return { items, open: items.filter((item) => item.resolvedAt === undefined).length };
}

/** URL 쿼리 → 필터. 모르는 값은 버린다 */
export function parseReviewQueueFilter(query: Record<string, string | string[] | undefined>): ReviewQueueFilter {
  const one = (key: string): string | undefined => {
    const value = query[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first.length === 0 ? undefined : first;
  };
  const show = one('show');
  const id = one('id');
  return {
    ...(show === 'resolved' ? { show: 'resolved' as const } : {}),
    ...(isReviewQueueItemId(id) ? { id } : {}),
  };
}

/** 기본은 열린 것만 (§6.4 "쌓였을 때 비우는 화면"). `show=resolved`면 전부 */
export function applyReviewQueueFilter(items: ReviewQueueItem[], filter: ReviewQueueFilter): ReviewQueueItem[] {
  return filter.show === 'resolved' ? items : items.filter((item) => item.resolvedAt === undefined);
}

// ---------------------------------------------------------------------------
// 처리 — POST /api/queue/:id/resolve
// ---------------------------------------------------------------------------

export type ResolveOutcome = { kind: 'ok'; response: ResolveReviewItemResponse } | { kind: 'error'; error: ApiError };

/** 본문 `{ by?, note? }`. 둘 다 선택이지만 있으면 문자열이어야 한다. JSON이 아니거나 객체가 아니면 400 `invalid-body` */
export function parseResolveBody(raw: unknown): ResolveReviewItemRequest | ApiError {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, code: 'invalid-body', message: '요청 본문은 객체여야 한다' };
  }
  const { by, note } = raw as Record<string, unknown>;
  if (by !== undefined && (typeof by !== 'string' || by.trim().length === 0)) {
    return { status: 400, code: 'invalid-body', message: 'by는 비어 있지 않은 문자열이어야 한다' };
  }
  if (note !== undefined && typeof note !== 'string') {
    return { status: 400, code: 'invalid-body', message: 'note는 문자열이어야 한다' };
  }
  return {
    ...(by === undefined ? {} : { by }),
    ...(note === undefined ? {} : { note }),
  };
}

export function reviewItemNotFound(id: string): ApiError {
  return { status: 404, code: 'review-item-not-found', message: `검토 대기열 항목 없음: ${id}` };
}

/**
 * 처리. `by`가 없으면 `ui`. 코어 오류 → HTTP: `ReviewItemNotFoundError` 404 · `ValidationError`(이미 처리) 409 `review-item-resolved` —
 * 이미 처리된 항목을 다시 읽어 `item`으로 붙인다(화면이 "이미 처리됐습니다. 다시 읽습니다"). 그 밖의 오류는 다시 던진다 (Next가 500으로)
 */
export async function resolveReviewQueueItem(id: string, body: ResolveReviewItemRequest): Promise<ResolveOutcome> {
  if (!isReviewQueueItemId(id)) return { kind: 'error', error: reviewItemNotFound(id) };
  const store = await getStore();
  try {
    const item = await store.reviewQueue.resolve(id, {
      by: body.by ?? RESOLVED_BY,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    if (item.resolvedAt === undefined) throw new Error('unreachable: resolve가 resolvedAt을 쓰지 않았다');
    return { kind: 'ok', response: { item: { ...item, resolvedAt: item.resolvedAt } } };
  } catch (error) {
    if (error instanceof ReviewItemNotFoundError) return { kind: 'error', error: reviewItemNotFound(id) };
    if (error instanceof ValidationError) {
      const already = await store.reviewQueue.get(id as ReviewQueueItemId);
      return {
        kind: 'error',
        error: {
          status: 409,
          code: 'review-item-resolved',
          message: error.message,
          ...(already === undefined ? {} : { item: already }),
        },
      };
    }
    throw error;
  }
}
