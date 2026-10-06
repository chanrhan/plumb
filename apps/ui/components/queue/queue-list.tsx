import type { ReviewQueueItem } from '@plumb/core';
import Link from 'next/link';
import { OPEN_MARK, QUEUE_KIND_LABEL, queueTime, resolvedLine } from './format';
import { ResolveButton } from './resolve-button';

export interface QueueListProps {
  /** 이미 거른 행 (기본 열린 것만, `?show=resolved`면 전부). 생성 순 */
  items: ReviewQueueItem[];
  /** 거르기 전 전체가 비었는가 — "검토 대기열 비어 있음"과 "열린 항목 없음"을 가른다 */
  totalCount: number;
}

/**
 * 검토 대기열 목록 (#120). 한 행 = `review-queue/<q-id>.json` 하나: 종류 · 요지 · 규칙(→ `/rules/<id>`) · 실행(→ `/runs?id=`) · 생성 시각 ·
 * `[처리]`(열린 것만). 처리된 행은 `처리됨 <시각> · <처리자> · <메모>`(#130 — `resolvedBy` · `note`가 파일에 있을 때만). 목 데이터는 없다 — 비면 "아직 없음"
 */
export function QueueList({ items, totalCount }: QueueListProps) {
  if (totalCount === 0) {
    return (
      <p className="queue-empty">
        검토 대기열 아직 없음. 실행 실패 · 예산 초과 · 이의 제기 · 미확정 주입이 생기면 <code>plumb run</code> 이 여기
        올립니다
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="queue-empty">
        열린 항목 없음. <Link href="/queue?show=resolved">처리됨 보기</Link>
      </p>
    );
  }

  return (
    <table className="rules-table queue-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>종류</th>
          <th>요지</th>
          <th>규칙</th>
          <th>실행</th>
          <th>생성</th>
          <th>처리</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const open = item.resolvedAt === undefined;
          return (
            <tr key={item.id} data-kind={item.kind} data-open={open ? 'true' : 'false'}>
              <td>
                {open ? `${OPEN_MARK} ` : ''}
                {item.id}
              </td>
              <td>{QUEUE_KIND_LABEL[item.kind]}</td>
              <td className="statement" title={item.summary}>
                {item.summary}
              </td>
              <td>
                {item.ruleIds.length === 0
                  ? '—'
                  : item.ruleIds.map((ruleId, index) => (
                      <span key={ruleId}>
                        {index === 0 ? '' : ' · '}
                        <Link href={`/rules/${encodeURIComponent(ruleId)}`}>{ruleId}</Link>
                      </span>
                    ))}
                {item.decisionId === undefined ? null : <span> · {item.decisionId}</span>}
              </td>
              <td>
                {item.runId === undefined ? (
                  '—'
                ) : (
                  <Link href={`/runs?id=${encodeURIComponent(item.runId)}`}>{item.runId}</Link>
                )}
              </td>
              <td>{queueTime(item.createdAt)}</td>
              <td className="queue-resolved" title={item.note}>
                {open ? <ResolveButton id={item.id} /> : resolvedLine(item)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
