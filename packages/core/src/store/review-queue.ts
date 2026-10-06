/**
 * 검토 대기열 `review-queue/<q-id>.json` (기획안 §9.2, 타입 `ReviewQueueItem`). 오케스트레이터가 올리고(실패 · 예산 초과 · 이의 제기 ·
 * 미판정 주입), 사람이 `/queue` 화면(#120)에서 처리한다. `store.status().reviewQueue`는 `resolvedAt` 없는 항목 수.
 * 처리(`resolveReviewItem`)는 `resolvedAt`만 쓴다 — 판정 결과를 규칙 상태에 반영하는 것은 M10-17.
 */

import type { ReviewQueueItem, ReviewQueueItemId } from '../types/index.js';
import { StoreError, ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';

export const REVIEW_QUEUE_ID_PATTERN = /^q-\d{4,}$/;

export function isReviewQueueItemId(value: unknown): value is ReviewQueueItemId {
  return typeof value === 'string' && REVIEW_QUEUE_ID_PATTERN.test(value);
}

/** 그 id의 항목 파일이 없다 (→ API 404 `review-item-not-found`) */
export class ReviewItemNotFoundError extends StoreError {
  override readonly name = 'ReviewItemNotFoundError';
  constructor(readonly itemId: string) {
    super(`검토 대기열 항목 ${itemId}이(가) 없다`);
  }
}

export const REVIEW_QUEUE_KINDS: readonly ReviewQueueItem['kind'][] = [
  'dispute',
  'interpretation',
  'undetermined-injection',
  'run-failed',
  'budget-exceeded',
  'design-change',
];

function parseItem(raw: unknown, where: string): ReviewQueueItem {
  const r = raw as Partial<ReviewQueueItem> | null;
  if (!r || typeof r !== 'object') throw new ValidationError(`${where}: 객체가 아니다`);
  if (!isReviewQueueItemId(r.id)) throw new ValidationError(`${where}: id가 q-nnnn 꼴이 아니다`);
  if (!REVIEW_QUEUE_KINDS.includes(r.kind as ReviewQueueItem['kind']))
    throw new ValidationError(`${where}: kind 값이 아니다: ${String(r.kind)}`);
  if (!Array.isArray(r.ruleIds)) throw new ValidationError(`${where}: ruleIds는 배열`);
  if (typeof r.summary !== 'string' || r.summary.trim().length === 0)
    throw new ValidationError(`${where}: summary 필요`);
  if (typeof r.createdAt !== 'string') throw new ValidationError(`${where}: createdAt 필요`);
  return r as ReviewQueueItem;
}

export async function nextReviewQueueId(paths: StorePaths): Promise<ReviewQueueItemId> {
  let max = 0;
  for (const file of await listFiles(paths.reviewQueueDir, '.json')) {
    const m = /^q-(\d+)\.json$/.exec(file);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `q-${String(max + 1).padStart(4, '0')}` as ReviewQueueItemId;
}

export type EnqueueInput = Omit<ReviewQueueItem, 'id' | 'createdAt'> & { createdAt?: string };

/** id를 매겨 올린다. 돌려주는 항목의 `id`를 `RunOutcome.queueItemId` · `Dispute.queueItemId`에 적는다 */
export async function enqueueReviewItem(
  paths: StorePaths,
  input: EnqueueInput,
  now: () => Date = () => new Date(),
): Promise<ReviewQueueItem> {
  const item: ReviewQueueItem = {
    ...input,
    id: await nextReviewQueueId(paths),
    createdAt: input.createdAt ?? now().toISOString(),
  };
  const parsed = parseItem(item, 'reviewQueue.enqueue');
  await writeJsonAtomic(paths.reviewQueueItem(parsed.id), parsed);
  return parsed;
}

/** 생성 순. `openOnly`면 `resolvedAt` 없는 것만 */
export async function listReviewQueue(paths: StorePaths, openOnly = false): Promise<ReviewQueueItem[]> {
  const out: ReviewQueueItem[] = [];
  for (const file of await listFiles(paths.reviewQueueDir, '.json')) {
    const raw = await readJsonFile(`${paths.reviewQueueDir}/${file}`);
    if (raw === undefined) continue;
    const item = parseItem(raw, file);
    if (!openOnly || item.resolvedAt === undefined) out.push(item);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** 항목 하나. 없으면 `undefined` */
export async function getReviewItem(paths: StorePaths, id: ReviewQueueItemId): Promise<ReviewQueueItem | undefined> {
  const raw = await readJsonFile(paths.reviewQueueItem(id));
  return raw === undefined ? undefined : parseItem(raw, id);
}

export interface ResolveReviewInput {
  /** 처리한 사람 · 통로 (`ui` · `cli`). 비어 있으면 `ValidationError` */
  by: string;
  /** 처리 메모 한 줄 */
  note?: string;
}

/**
 * 처리 — `resolvedAt`을 쓴다. 없는 id면 {@link ReviewItemNotFoundError}, 이미 처리된 항목이면 `ValidationError`(→ API 409).
 * `by` · `note`는 입력 검증만 한다: `ReviewQueueItem`에 그 자리가 없어(타입은 이 이슈 범위 밖) 파일에는 남지 않는다 —
 * 남기려면 타입 필드 추가가 먼저다. 판정 결과를 규칙 상태(🟠 보류)에 잇는 것은 M10-17
 */
export async function resolveReviewItem(
  paths: StorePaths,
  id: ReviewQueueItemId,
  input: ResolveReviewInput,
  now: () => Date = () => new Date(),
): Promise<ReviewQueueItem> {
  if (typeof input.by !== 'string' || input.by.trim().length === 0)
    throw new ValidationError('reviewQueue.resolve: by 필요');
  if (input.note !== undefined && typeof input.note !== 'string')
    throw new ValidationError('reviewQueue.resolve: note는 문자열');
  if (!isReviewQueueItemId(id)) throw new ReviewItemNotFoundError(String(id));
  const item = await getReviewItem(paths, id);
  if (item === undefined) throw new ReviewItemNotFoundError(id);
  if (item.resolvedAt !== undefined)
    throw new ValidationError(`reviewQueue.resolve: ${id}은(는) 이미 처리됐다 (${item.resolvedAt})`);
  const resolved: ReviewQueueItem = { ...item, resolvedAt: now().toISOString() };
  await writeJsonAtomic(paths.reviewQueueItem(id), resolved);
  return resolved;
}
