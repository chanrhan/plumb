'use client';

import type { ViewName } from '@plumb/core';
import { type ComponentProps, isValidElement, type ReactNode, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './Mermaid';
import { OpenDialog } from './OpenDialog';
import { type OpenTarget, PLUMB_OPEN_PREFIX, parseOpenHref } from './reasons';

export interface ViewBodyProps {
  view: ViewName;
  /** `views/<name>.md` 본문 (front matter 제외). `GET /api/views/:name`의 `markdown` */
  markdown: string;
}

/** `plumb://open?…`만 살리고 나머지는 react-markdown 기본 규칙(http · https · mailto · 상대 경로) */
function urlTransform(url: string): string {
  return url.startsWith(PLUMB_OPEN_PREFIX) ? url : defaultUrlTransform(url);
}

/** `<pre><code class="language-mermaid">` 를 Mermaid 컴포넌트로 바꾼다. 다른 코드 블록은 그대로 */
function mermaidCodeOf(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const className = children.props.className ?? '';
  if (!/\blanguage-mermaid\b/.test(className)) return null;
  const text = children.props.children;
  return typeof text === 'string' ? text.replace(/\n$/, '') : Array.isArray(text) ? text.join('') : null;
}

/**
 * View 본문 (work-views 3절 "View 본문" · "항목의 file:line 링크" · 4절 "코드 열람 점프"). 이 컴포넌트는 **렌더링만** 한다 —
 * 내용은 저장소의 Markdown이다. ```mermaid 펜스는 클라이언트에서 그리고, `plumb://open?file=&line=` 링크는 가로채 이유 대화창을 띄운다.
 * 클릭만으로는 아무것도 열리지 않는다 (3절 `[IDE ↗]` 비고).
 */
export function ViewBody({ view, markdown }: ViewBodyProps) {
  const [target, setTarget] = useState<OpenTarget | null>(null);

  return (
    <div className="view-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          pre: ({ children, ...rest }: ComponentProps<'pre'>) => {
            const code = mermaidCodeOf(children);
            return code === null ? <pre {...rest}>{children}</pre> : <Mermaid code={code} />;
          },
          a: ({ href, children, ...rest }: ComponentProps<'a'>) => {
            const open = parseOpenHref(href);
            if (open === null)
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            return (
              <a
                href={href}
                className="ide-link"
                title={`IDE에서 열기: ${open.label} (이유를 고른다)`}
                onClick={(event) => {
                  event.preventDefault();
                  setTarget(open);
                }}
              >
                {children} <span aria-hidden="true">[IDE ↗]</span>
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
      {target === null ? null : <OpenDialog target={target} view={view} onClose={() => setTarget(null)} />}
    </div>
  );
}
