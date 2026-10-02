'use client';

import { useEffect, useState } from 'react';

type State = { kind: 'pending' } | { kind: 'ok'; svg: string } | { kind: 'error'; message: string };

let counter = 0;

/**
 * ```mermaid 펜스 하나를 클라이언트에서 그린다 (work-views 3절 "View 본문 (Markdown + Mermaid)").
 * 실패하면 그 자리에 **원문 코드 블록을 그대로** 보이고 위에 "다이어그램 렌더 실패" 한 줄 — 본문의 나머지는 정상 (4절 오류 표).
 * 서버에서는 원문 코드 블록으로 렌더되고(검색 · curl에서도 펜스 내용이 보인다), 브라우저에서 SVG로 바뀐다.
 */
export function Mermaid({ code }: { code: string }) {
  const [state, setState] = useState<State>({ kind: 'pending' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        counter += 1;
        const { svg } = await mermaid.render(`plumb-mermaid-${counter}`, code);
        if (!cancelled) setState({ kind: 'ok', svg });
      } catch (error) {
        if (!cancelled) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (state.kind === 'ok') {
    // mermaid.render가 만든 SVG. securityLevel: 'strict'라 라벨의 HTML은 이스케이프된다
    // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid가 만든 SVG 문자열을 그대로 넣는 길뿐이다
    return <div className="mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  }
  return (
    <div className={state.kind === 'error' ? 'mermaid-failed' : 'mermaid-pending'}>
      {state.kind === 'error' ? <p role="alert">다이어그램 렌더 실패: {state.message.split('\n')[0]}</p> : null}
      <pre>
        <code className="language-mermaid">{code}</code>
      </pre>
    </div>
  );
}
