import { StoreNotInitializedError } from '@plumb/core';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { queueHeadline } from '@/components/queue/format';
import { QueueList } from '@/components/queue/queue-list';
import { COOKIE, isValidSession } from '@/lib/auth';
import { applyReviewQueueFilter, parseReviewQueueFilter, readReviewQueue } from '@/lib/queue';
import NoSessionPage from '../no-session/page';

export const dynamic = 'force-dynamic';

type Query = Record<string, string | string[] | undefined>;

/**
 * 검토 대기열 (`/queue`, #120 · 기획안 §6.4 · §9.2 · compare 13절 M10-07). 서버 컴포넌트 — 저장소 `review-queue/*.json`을 직접 읽는다 (README 3.1).
 * 기본은 열린 것만("매일 여는 화면이 아니라 쌓였을 때 비우는 화면"), `?show=resolved`로 처리된 것도 본다. 행마다 `[처리]` — 쿠키 세션 필요.
 * 세션 검사: 미들웨어 matcher가 `/queue`도 덮는다(#130 — `/rules` · `/runs`와 같이 쿠키 없으면 `/no-session`으로 rewrite). 이 페이지는 그와 별개로
 * `layout.tsx`와 같은 방법으로 한 번 더 확인하고 없으면 `/no-session`과 같은 내용을 그린다 — 쿠키 없는 요청에 저장소 값을 보이지 않는다
 */
export default async function QueuePage({ searchParams }: { searchParams: Promise<Query> }) {
  const session = (await cookies()).get(COOKIE)?.value;
  if (!(await isValidSession(session))) return <NoSessionPage />;

  const filter = parseReviewQueueFilter(await searchParams);

  let queue: Awaited<ReturnType<typeof readReviewQueue>>;
  try {
    queue = await readReviewQueue();
  } catch (error) {
    if (error instanceof StoreNotInitializedError) {
      return (
        <section>
          <h1>검토 대기열</h1>
          <p role="alert">보호 저장소를 읽지 못함: {error.message}</p>
        </section>
      );
    }
    throw error;
  }

  const rows = applyReviewQueueFilter(queue.items, filter);
  const showingResolved = filter.show === 'resolved';

  return (
    <section className="queue-screen">
      <header className="rules-head queue-head">
        <h1>검토 대기열</h1>
        <p>{queueHeadline(queue.items)}</p>
        <p className="queue-toggle">
          {showingResolved ? (
            <Link href="/queue">열린 것만 보기</Link>
          ) : (
            <Link href="/queue?show=resolved">처리됨 보기</Link>
          )}
        </p>
      </header>
      <p className="queue-note">
        처리는 <code>resolvedAt</code> · 처리자 · 메모를 적습니다 — 판정 결과를 규칙 상태(🟠 보류)에 잇는 것은 M10-17.
        이의 제기의 판정 근거는 실행 링크의 이의 제기 줄과 <code>.work/</code> 의 이의 제기 파일에 있습니다
      </p>
      <QueueList items={rows} totalCount={queue.items.length} />
    </section>
  );
}
