import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plumb',
};

/**
 * 공통 레이아웃 뼈대 (docs/screens/README.md 2절).
 * 상단 바와 블록 트리는 모든 화면에 고정이다. 값은 전부 자리만 있고 "—" 이다 —
 * 프로젝트 이름·저장소 상태·마지막 검사·⚠ 는 M3 `/api/status`, 블록 트리는 M8 `/api/blocks` 에서 채운다.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="shell">
          <header className="topbar">
            <strong>Plumb · —</strong>
            <span>보호 저장소 —</span>
            <span>마지막 검사 —</span>
            <span className="spacer" />
            <span title="미확인 항목 수">⚠ —</span>
          </header>
          <aside className="sidebar">
            <h2>블록 트리</h2>
            <p>블록 아직 없음</p>
          </aside>
          <main className="main">{children}</main>
          <nav className="nav">
            <Link href="/views">/views</Link>
            <span>·</span>
            <Link href="/rules">/rules</Link>
            <span>·</span>
            <Link href="/runs">/runs</Link>
          </nav>
        </div>
      </body>
    </html>
  );
}
