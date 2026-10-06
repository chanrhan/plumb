import type { BlocksResponse, StatusResponse } from '@plumb/core';
import { toStatusResponse } from '@plumb/core';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BlockTree } from '@/components/blocks/BlockTree';
import { COOKIE, isValidSession } from '@/lib/auth';
import { readBlocksResponse } from '@/lib/blocks';
import { getStore } from '@/lib/store';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plumb',
};

/** 요청마다 그린다 — 상단 바는 저장소의 현재 값이지 빌드 시점 값이 아니다 */
export const dynamic = 'force-dynamic';

/** 저장소 상태 라벨 (README 2절 표: 정상 / 변조 증거. `unverified`는 승인 기록 없이 내용이 있는 경우) */
const STORE_LABEL: Record<StatusResponse['store']['status'], string> = {
  ok: '정상',
  tampered: '변조 증거',
  unverified: '미확인',
};

type TopBar = { kind: 'no-session' } | { kind: 'ok'; status: StatusResponse } | { kind: 'error'; message: string };

/**
 * 상단 바 값. 세션 쿠키가 맞을 때만 저장소를 읽는다 — `/no-session` 화면에는 저장소 값을 보이지 않는다.
 * 읽기에 실패하면 "—"를 그대로 두고 `title`에 오류를 적는다.
 */
async function loadTopBar(): Promise<TopBar> {
  const session = (await cookies()).get(COOKIE)?.value;
  if (!(await isValidSession(session))) return { kind: 'no-session' };
  try {
    const store = await getStore();
    return { kind: 'ok', status: toStatusResponse(await store.status()) };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

type Sidebar = { kind: 'no-session' } | { kind: 'ok'; blocks: BlocksResponse } | { kind: 'error'; message: string };

/**
 * 블록 트리 값 (`GET /api/blocks`와 같은 읽기 모델, #121). 세션이 없으면 저장소 값을 보이지 않는다.
 * 읽기에 실패하면(아키텍처 View JSON이 반쪽 등) "블록 트리를 읽지 못함"에 오류를 `title`로 적는다 — 반쪽을 그리지 않는다.
 */
async function loadSidebar(hasSession: boolean): Promise<Sidebar> {
  if (!hasSession) return { kind: 'no-session' };
  try {
    return { kind: 'ok', blocks: await readBlocksResponse() };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function formatLastCheck(lastCheck: StatusResponse['lastCheck']): string {
  if (lastCheck === undefined) return '없음';
  const commit = lastCheck.commit.slice(0, 7);
  return `${lastCheck.finishedAt} (${commit})`;
}

/**
 * 공통 레이아웃 뼈대 (docs/screens/README.md 2절).
 * 상단 바 4자리(프로젝트 이름 · 저장소 상태 · 마지막 검사 · ⚠)는 서버 컴포넌트에서 `getStore().status()`로 채운다 (#33).
 * 블록 트리는 `readBlocksResponse()`(= `GET /api/blocks`)로 채운다 (#121) — 그래프가 없으면 "블록 아직 없음".
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const bar = await loadTopBar();
  const sidebar = await loadSidebar(bar.kind !== 'no-session');
  const status = bar.kind === 'ok' ? bar.status : null;
  const title = bar.kind === 'error' ? `저장소를 읽지 못함: ${bar.message}` : undefined;

  return (
    <html lang="ko">
      <body>
        <div className="shell">
          <header className="topbar" title={title}>
            <strong>Plumb · {status?.project ?? '—'}</strong>
            <span>보호 저장소 {status === null ? '—' : STORE_LABEL[status.store.status]}</span>
            <span>마지막 검사 {status === null ? '—' : formatLastCheck(status.lastCheck)}</span>
            <span className="spacer" />
            <span
              title={
                status === null
                  ? '미확인 항목 수'
                  : `미확인 ${status.unconfirmed.total} = 잠정 규칙 ${status.unconfirmed.provisionalRules} + 검토 대기열 ${status.unconfirmed.reviewQueue}`
              }
            >
              ⚠ {status?.unconfirmed.total ?? '—'}
            </span>
          </header>
          <aside className="sidebar">
            <h2>블록 트리</h2>
            {sidebar.kind === 'ok' ? (
              <BlockTree data={sidebar.blocks} />
            ) : sidebar.kind === 'error' ? (
              <p title={sidebar.message}>블록 트리를 읽지 못함</p>
            ) : (
              <p>—</p>
            )}
          </aside>
          <main className="main">{children}</main>
          <nav className="nav">
            <Link href="/views">/views</Link>
            <span>·</span>
            <Link href="/rules">/rules</Link>
            <span>·</span>
            <Link href="/runs">/runs</Link>
            <span>·</span>
            <Link href="/queue">검토 대기열</Link>
          </nav>
        </div>
      </body>
    </html>
  );
}
