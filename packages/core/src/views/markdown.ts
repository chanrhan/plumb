/**
 * View Markdown 렌더 헬퍼 (이슈 #53). 생성기 6개의 `render()`가 같은 표 · Mermaid 펜스 · `file:line` 앵커 링크 · 출처 표시줄을 쓴다.
 *
 * - 앵커 링크는 `plumb://open?file=…&line=…` 스킴이다. UI(#60)가 이 링크를 가로채 이유 대화창을 띄우고 `POST /api/open`으로 바꾼다
 *   (screens/README 2.2 — 누르기 전에 이유를 고르지 않으면 열리지 않는다). 도구는 코드를 보여주지 않는다 (기획안 §3 · §16)
 * - 출처 표시줄은 모든 View의 첫 줄이다 (기획안 §6 "View는 파서 결과나 실행 결과에서 나와야 한다"). `SourceKind` → 한국어 접두어
 *   매핑은 {@link SOURCE_PREFIX} 한 곳뿐이다
 */

import type { Anchor, RuleStatus, SourceKind, SourceRef } from '../types/index.js';

// ---------------------------------------------------------------------------
// 이스케이프 · 기본 블록
// ---------------------------------------------------------------------------

/** Markdown 구문으로 읽힐 수 있는 문자를 이스케이프한다 (일반 텍스트용. 표 셀은 {@link escapeCell}) */
export function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]<>|~#]/g, (ch) => `\\${ch}`);
}

/** 표 셀 이스케이프: `|`는 열 구분자, 줄바꿈은 행 구분자이므로 둘만 바꾼다. 셀 안의 링크 · 코드 · 아이콘은 그대로 둔다 */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** `# 제목`. 수준은 1~6으로 자른다 */
export function heading(level: number, text: string): string {
  const depth = Math.min(6, Math.max(1, Math.trunc(level)));
  return `${'#'.repeat(depth)} ${text}`;
}

/** 인라인 코드. 본문에 백틱이 있으면 펜스를 더 길게 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * GFM 표. 헤더 수보다 짧은 행은 빈 셀로 채우고, 긴 행은 자르지 않는다 (렌더러가 무시한다).
 * 헤더가 없으면 빈 문자열.
 */
export function mdTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return '';
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  const out = [line(headers), `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    const cells = [...row];
    while (cells.length < headers.length) cells.push('');
    out.push(line(cells));
  }
  return out.join('\n');
}

/** Mermaid 펜스. 코드 안에 ``` 가 있으면 펜스를 더 길게 (UI는 `mermaid` 언어 태그로 다이어그램을 그린다) */
export function mermaid(code: string): string {
  return fence('mermaid', code);
}

/** 언어 태그가 있는 코드 펜스 */
export function fence(lang: string, code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${code.replace(/\s+$/, '')}\n${ticks}`;
}

// ---------------------------------------------------------------------------
// file:line 앵커 링크 (README 2.2)
// ---------------------------------------------------------------------------

/** 코드 열람 점프 링크의 스킴. UI가 `/api/open`으로 바꾼다 */
export const PLUMB_OPEN_SCHEME = 'plumb://open';

/** `plumb://open?file=<encoded>&line=<n>`. `file`이 없으면 `null` — 링크 없는 항목 */
export function anchorUrl(anchor: Anchor): string | null {
  if (anchor.file === undefined || anchor.file.length === 0) return null;
  const params = new URLSearchParams({ file: anchor.file });
  if (anchor.line !== undefined) params.set('line', String(anchor.line));
  return `${PLUMB_OPEN_SCHEME}?${params.toString()}`;
}

/** 링크 라벨 기본값 `file:line` (줄 없으면 `file`) */
export function anchorLabel(anchor: Anchor): string {
  if (anchor.file === undefined) return '';
  return anchor.line === undefined ? anchor.file : `${anchor.file}:${anchor.line}`;
}

/**
 * `[file:line](plumb://open?file=…&line=…)`. `file`이 없으면 링크 없이 라벨만 (없으면 빈 문자열) —
 * 점프할 곳이 없는 항목에 가짜 링크를 만들지 않는다.
 */
export function anchorLink(anchor: Anchor, label?: string): string {
  const url = anchorUrl(anchor);
  const text = label ?? anchorLabel(anchor);
  if (url === null) return text;
  return `[${text.replace(/[[\]]/g, (ch) => `\\${ch}`)}](${url})`;
}

/** `plumb://open?file=…&line=…` → `Anchor`. 다른 스킴 · `file` 없음 · 잘못된 줄 번호면 `null`. UI(#60)의 가로채기용 */
export function parseAnchorUrl(url: string): Anchor | null {
  if (!url.startsWith(`${PLUMB_OPEN_SCHEME}?`)) return null;
  const params = new URLSearchParams(url.slice(PLUMB_OPEN_SCHEME.length + 1));
  const file = params.get('file');
  if (file === null || file.length === 0) return null;
  const anchor: Anchor = { file };
  const line = params.get('line');
  if (line !== null) {
    if (!/^\d+$/.test(line)) return null;
    anchor.line = Number(line);
  }
  return anchor;
}

// ---------------------------------------------------------------------------
// 출처 표시줄 (README 2.1)
// ---------------------------------------------------------------------------

/** `SourceKind` → 한국어 접두어. 이 매핑은 여기 한 곳뿐이다 (README 2.1 표와 1:1) */
export const SOURCE_PREFIX: Record<SourceKind, string> = {
  parser: '파서:',
  execution: '실행:',
  store: '저장소:',
  git: 'git:',
  'user-input': '사용자 입력:',
};

/** 7자리 축약 (work-views 3절 "마지막 생성 커밋 — 7자리 축약") */
export function shortCommit(commit: string): string {
  return commit.length > 7 ? commit.slice(0, 7) : commit;
}

/**
 * 출처 하나. `파서: dependency-cruiser 18.5 (src)` · `실행: vitest-junit (reports/junit.xml)` · `저장소: rules.yaml` ·
 * `git: a1b2c3d (HEAD~1..HEAD)` · `사용자 입력: ?block=payment`. git이 아닌 출처의 커밋은 `@a1b2c3d`로 뒤에 붙는다.
 */
export function formatSource(ref: SourceRef): string {
  const parts: string[] = [];
  const tool = [ref.tool, ref.version].filter((p): p is string => p !== undefined && p.length > 0).join(' ');
  if (tool.length > 0) parts.push(tool);
  if (ref.kind === 'git') {
    if (ref.commit !== undefined) parts.push(shortCommit(ref.commit));
    if (ref.input !== undefined) parts.push(`(${ref.input})`);
  } else {
    if (ref.input !== undefined)
      parts.push(ref.kind === 'user-input' || tool.length === 0 ? ref.input : `(${ref.input})`);
    if (ref.commit !== undefined) parts.push(`@${shortCommit(ref.commit)}`);
  }
  const prefix = SOURCE_PREFIX[ref.kind];
  return parts.length === 0 ? prefix : `${prefix} ${parts.join(' ')}`;
}

/** `출처: 파서: dependency-cruiser 18.5 (src) · 실행: vitest-junit · git: a1b2c3d`. 비어 있으면 `출처: 없음` — 0개를 숨기지 않는다 */
export function sourceBar(sources: readonly SourceRef[]): string {
  if (sources.length === 0) return '출처: 없음';
  return `출처: ${sources.map(formatSource).join(' · ')}`;
}

// ---------------------------------------------------------------------------
// 상태 아이콘 (rules.ts `RuleStatus` 주석의 다섯 아이콘)
// ---------------------------------------------------------------------------

/** 🟢 pass-verified · 🟡 pass-unverified · 🟠 recheck · 🔴 fail · ⬜ unchecked */
export const STATUS_ICON: Record<RuleStatus, string> = {
  'pass-verified': '🟢',
  'pass-unverified': '🟡',
  recheck: '🟠',
  fail: '🔴',
  unchecked: '⬜',
};

export function statusIcon(status: RuleStatus): string {
  return STATUS_ICON[status];
}
