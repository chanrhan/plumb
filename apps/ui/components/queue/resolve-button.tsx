'use client';

import type { ApiError, ResolveReviewItemResponse, ReviewQueueItemId } from '@plumb/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** work-approve 4절 오류 표와 같은 문구 */
const MESSAGES = {
  unauthenticated: '처리되지 않음: 세션 없음. `plumb ui` 를 다시 시작하면 `/auth` 로 열립니다',
  resolved: '이미 처리된 항목입니다. 다시 읽습니다',
  notFound: '항목이 없습니다 (지워졌거나 id가 바뀜). 다시 읽습니다',
} as const;

type Outcome = { kind: 'ok'; text: string } | { kind: 'error'; text: string };

export interface ResolveButtonProps {
  id: ReviewQueueItemId;
}

/**
 * 행의 `[처리]` (클라이언트 컴포넌트). `POST /api/queue/:id/resolve {}` → 200이면 서버 컴포넌트를 다시 그린다(`router.refresh()` —
 * 목록에서 빠지고 상단 바 `⚠ n`이 1 준다). 401 → 세션 없음 안내(항목은 그대로 열린 채). 409(이미 처리) · 404 → 안내 뒤 다시 읽기.
 * 쿠키 세션은 approve와 같은 미들웨어가 요구한다 — 에이전트는 이 버튼을 누를 수 없다
 */
export function ResolveButton({ id }: ResolveButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function resolve() {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch(`/api/queue/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        setOutcome({ kind: 'error', text: MESSAGES.unauthenticated });
        return;
      }
      if (res.status === 409 || res.status === 404) {
        setOutcome({ kind: 'error', text: res.status === 409 ? MESSAGES.resolved : MESSAGES.notFound });
        router.refresh();
        return;
      }
      if (!res.ok) {
        const error = (await res.json().catch(() => null)) as ApiError | null;
        setOutcome({ kind: 'error', text: error === null ? `오류 ${res.status}` : `${error.code}: ${error.message}` });
        return;
      }
      const data = (await res.json()) as ResolveReviewItemResponse;
      setOutcome({ kind: 'ok', text: `처리됨 ${data.item.resolvedAt}` });
      router.refresh();
    } catch (error) {
      setOutcome({ kind: 'error', text: `요청 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="queue-resolve">
      <button type="button" onClick={() => void resolve()} disabled={busy}>
        {busy ? '처리 중…' : '처리'}
      </button>
      {outcome === null ? null : (
        <span role={outcome.kind === 'error' ? 'alert' : 'status'} className={`queue-${outcome.kind}`}>
          {outcome.text}
        </span>
      )}
    </span>
  );
}
