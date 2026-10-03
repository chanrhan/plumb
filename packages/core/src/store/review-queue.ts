/**
 * 검토 대기열 `review-queue/<q-id>.json` (기획안 §9.2, 타입 `ReviewQueueItem`). 오케스트레이터가 올리고(실패 · 예산 초과 · 이의 제기 ·
 * 미판정 주입), 사람이 M10 화면에서 판정한다. `store.status().reviewQueue`는 `resolvedAt` 없는 항목 수.
 */

import type { ReviewQueueItem, ReviewQueueItemId } from '../types/index.js';
import { ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';

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
  if (typeof r.id !== 'string' || !/^q-\d{4,}$/.test(r.id))
    throw new ValidationError(`${where}: id가 q-nnnn 꼴이 아니다`);
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
