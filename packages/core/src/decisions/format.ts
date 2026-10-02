/**
 * 결정 기록 `decisions/D-xxxx.md`의 파일 형식 (기획안 §6.2, 이슈 #35). 저장 형식은 `types/rules.ts`의 {@link DecisionRecord}를
 * 직렬화한 것이다 — Markdown + YAML front matter.
 *
 * ```
 * ---
 * id: D-0001
 * title: 환불 기간 7일을 규칙으로 둔다
 * block: payment
 * at: 2026-10-02T03:00:00Z
 * session: null
 * links:
 *   rules: [ pay.refund-window ]
 *   commits: []
 *   packages: []
 *   services: []
 * ---
 * ## 결정
 * ## 이유
 * ## 기각한 대안
 * ## 감수하는 것
 * ```
 *
 * - front matter 키는 `id · title · block? · at · session · links`. `at`은 {@link DecisionRecord.date}, `session`은 없으면 `null`
 * - `links.events`는 도구가 역으로 채우는 값(docs/types/README view-changelog 2번)이라 비어 있으면 쓰지 않는다
 * - 본문의 네 절 제목은 고정 문자열({@link SECTION_HEADINGS}). 순서가 바뀌어도 읽히지만 {@link formatDecision}은 이 순서로 쓴다
 * - 모르는 `## 절`은 {@link DecisionRecord.extra}에 그대로 보존한다 (왕복 동일성). 절 제목이 하나도 없으면 {@link DecisionParseError}
 * - 에이전트가 쓴 텍스트를 그대로 둔다 — 절 본문은 앞뒤 공백만 다듬는다 (`DecisionRecord` 주석 "요약하지 않는다")
 */

import { isMap, isSeq, parse as parseYaml, Document as YamlDocument } from 'yaml';
import { type ZodIssue, z } from 'zod';
import { formatIssue } from '../config/load.js';
import { StoreError } from '../store/index.js';
import type { ChangeEventId, DecisionExtraSection, DecisionId, DecisionRecord, RuleId, RunId } from '../types/index.js';

// ---------------------------------------------------------------------------
// 절
// ---------------------------------------------------------------------------

/** 필수 네 절의 키. `tradeoff`는 {@link DecisionRecord.accepted}("감수하는 것") */
export type DecisionSection = 'decision' | 'reason' | 'rejected' | 'tradeoff';

/** 절 키 → `## 제목` 고정 문자열. 쓰는 순서이기도 하다 */
export const SECTION_HEADINGS: Readonly<Record<DecisionSection, string>> = {
  decision: '결정',
  reason: '이유',
  rejected: '기각한 대안',
  tradeoff: '감수하는 것',
};

/** 절 키 → {@link DecisionRecord} 필드 */
export const SECTION_FIELDS: Readonly<Record<DecisionSection, 'decision' | 'reason' | 'rejected' | 'accepted'>> = {
  decision: 'decision',
  reason: 'reason',
  rejected: 'rejected',
  tradeoff: 'accepted',
};

export const DECISION_SECTIONS: readonly DecisionSection[] = ['decision', 'reason', 'rejected', 'tradeoff'];

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------

/** 파일이 결정 기록 형식이 아니다 — front matter 없음 · YAML 오류 · 스키마 위반 · 절 제목 없음 */
export class DecisionParseError extends StoreError {
  override readonly name = 'DecisionParseError';
  constructor(
    message: string,
    readonly issues: readonly ZodIssue[] = [],
    options: { cause?: unknown } = {},
  ) {
    super(
      issues.length > 0 ? `${message}\n${issues.map((issue) => `  ${formatIssue(issue)}`).join('\n')}` : message,
      options,
    );
  }
}

// ---------------------------------------------------------------------------
// front matter 스키마
// ---------------------------------------------------------------------------

/** 결정 ID `D-nnnn` — 숫자 네 자리 이상. 파일 이름이자 번호 증가의 기준 (`store.ts`). `store/rules.ts`의 `decisionIdSchema`(`D-…`)보다 엄격하다 */
export const DECISION_ID_PATTERN = /^D-\d{4,}$/;

export const decisionRecordIdSchema = z.custom<DecisionId>(
  (value) => typeof value === 'string' && DECISION_ID_PATTERN.test(value),
  { message: '결정 ID는 D-nnnn 형식 (숫자 네 자리 이상)' },
);

const ruleIdSchema = z.custom<RuleId>((value) => typeof value === 'string' && /^[\w-]+(?:\.[\w-]+)+$/.test(value), {
  message: '규칙 ID는 <블록>.<이름> 형식 (예: pay.refund-window)',
});

const runIdSchema = z.custom<RunId>((value) => typeof value === 'string' && /^r-.+$/.test(value), {
  message: '세션(실행) ID는 r-… 형식',
});

const eventIdSchema = z.custom<ChangeEventId>((value) => typeof value === 'string' && /^E-.+$/.test(value), {
  message: '이벤트 ID는 E-… 형식',
});

const stringList = z.array(z.string().min(1)).default([]);

/** front matter. 출력은 {@link DecisionRecord}의 본문 네 필드를 뺀 것 */
export const decisionFrontMatterSchema = z
  .object({
    id: decisionRecordIdSchema,
    title: z.string().min(1, '제목이 비어 있다'),
    block: z.string().min(1).optional(),
    at: z.string().datetime({ offset: true, message: 'at은 ISO 8601 시각 (예: 2026-10-02T03:00:00Z)' }),
    session: runIdSchema.nullable().optional(),
    links: z
      .object({
        rules: z.array(ruleIdSchema).default([]),
        commits: stringList,
        events: z.array(eventIdSchema).default([]),
        packages: stringList,
        services: stringList,
      })
      .strict()
      .default({}),
  })
  .strict();

export type DecisionFrontMatter = z.output<typeof decisionFrontMatterSchema>;

// ---------------------------------------------------------------------------
// 파싱
// ---------------------------------------------------------------------------

const FRONT_MATTER_OPEN = /^---[ \t]*\r?\n/;
const FRONT_MATTER_CLOSE = /\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^## (.+?)\s*$/;
const FENCE = /^(```|~~~)/;

function splitFrontMatter(md: string, where: string): { yaml: string; body: string } {
  const open = FRONT_MATTER_OPEN.exec(md);
  if (open === null) throw new DecisionParseError(`${where}: front matter(---)로 시작하지 않는다`);
  const rest = md.slice(open[0].length);
  // 첫 줄이 바로 `---`(빈 front matter)일 수도 있어 `\n`을 앞에 붙여 찾는다. 인덱스는 한 칸 당겨진다
  const close = FRONT_MATTER_CLOSE.exec(`\n${rest}`);
  if (close === null) throw new DecisionParseError(`${where}: front matter를 닫는 ---가 없다`);
  const yaml = rest.slice(0, close.index);
  const body = rest.slice(close.index - 1 + close[0].length);
  return { yaml, body };
}

interface RawSection {
  heading: string;
  lines: string[];
}

/** `## 제목` 줄로 본문을 자른다. 코드 펜스 안의 `##`은 제목이 아니다. 첫 제목 앞의 글은 허용하지 않는다 */
function splitSections(body: string, where: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | undefined;
  let inFence = false;
  const preamble: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading !== null) {
      current = { heading: heading[1] as string, lines: [] };
      sections.push(current);
    } else if (current === undefined) {
      preamble.push(line);
    } else {
      current.lines.push(line);
    }
  }
  if (sections.length === 0) {
    throw new DecisionParseError(
      `${where}: 절 제목(## 결정 · ## 이유 · ## 기각한 대안 · ## 감수하는 것)이 하나도 없다`,
    );
  }
  if (preamble.join('\n').trim().length > 0) {
    throw new DecisionParseError(`${where}: 첫 절 제목 앞에 본문이 있다. 모든 글은 ## 절 아래에 둔다`);
  }
  return sections;
}

const HEADING_TO_SECTION = new Map<string, DecisionSection>(
  DECISION_SECTIONS.map((section) => [SECTION_HEADINGS[section], section]),
);

/**
 * Markdown 원문 → {@link DecisionRecord}. `where`는 오류 메시지의 위치(파일 경로 등).
 * 형식이 아니면 {@link DecisionParseError}. 네 절 중 없는 것은 빈 문자열이다 — 빈 절 판정은 `validate.ts`
 */
export function parseDecision(md: string, where = '입력'): DecisionRecord {
  const { yaml, body } = splitFrontMatter(md, where);

  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (error) {
    throw new DecisionParseError(
      `${where}: front matter를 YAML로 읽을 수 없다 — ${error instanceof Error ? error.message : String(error)}`,
      [],
      { cause: error },
    );
  }
  const result = decisionFrontMatterSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new DecisionParseError(`${where}: front matter가 결정 기록 스키마에 맞지 않는다`, result.error.issues);
  }
  const front = result.data;

  const fields: Record<DecisionSection, string> = { decision: '', reason: '', rejected: '', tradeoff: '' };
  const seen = new Set<DecisionSection>();
  const extra: DecisionExtraSection[] = [];
  for (const { heading, lines } of splitSections(body, where)) {
    const text = lines.join('\n').trim();
    const section = HEADING_TO_SECTION.get(heading);
    if (section === undefined) {
      extra.push({ heading, body: text });
    } else if (seen.has(section)) {
      throw new DecisionParseError(`${where}: "## ${heading}" 절이 두 번 나온다`);
    } else {
      seen.add(section);
      fields[section] = text;
    }
  }

  const record: DecisionRecord = {
    id: front.id,
    title: front.title,
    ...(front.block === undefined ? {} : { block: front.block }),
    date: front.at,
    ...(front.session == null ? {} : { session: front.session }),
    decision: fields.decision,
    reason: fields.reason,
    rejected: fields.rejected,
    accepted: fields.tradeoff,
    links: {
      rules: front.links.rules,
      commits: front.links.commits,
      events: front.links.events,
      packages: front.links.packages,
      services: front.links.services,
    },
  };
  if (extra.length > 0) record.extra = extra;
  return record;
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

function frontMatterOf(record: DecisionRecord): string {
  const links: Record<string, string[]> = {
    rules: record.links.rules,
    commits: record.links.commits,
    ...((record.links.events ?? []).length > 0 ? { events: record.links.events } : {}),
    packages: record.links.packages ?? [],
    services: record.links.services ?? [],
  };
  const doc = new YamlDocument({
    id: record.id,
    title: record.title,
    ...(record.block === undefined ? {} : { block: record.block }),
    at: record.date,
    session: record.session ?? null,
    links,
  });
  // 연결 목록은 한 줄 flow 표기(`rules: [ pay.refund-window ]`) — 비어 있어도 `[]`로 자리가 보인다
  const linksNode = doc.get('links', true);
  if (isMap(linksNode)) {
    for (const pair of linksNode.items) {
      if (isSeq(pair.value)) pair.value.flow = true;
    }
  }
  return doc.toString({ lineWidth: 0 });
}

function sectionOf(heading: string, body: string): string {
  const text = body.trim();
  return text.length === 0 ? `## ${heading}\n` : `## ${heading}\n\n${text}\n`;
}

/**
 * {@link DecisionRecord} → Markdown 원문. 네 절을 고정 순서로, 그 뒤에 `extra` 절을 들어온 순서로 쓴다.
 * `parseDecision(formatDecision(r))`는 `r`과 같다 (빈 `packages` · `services`는 `[]`로, `session` 없음은 `null`로 정규화)
 */
export function formatDecision(record: DecisionRecord): string {
  const sections = DECISION_SECTIONS.map((section) =>
    sectionOf(SECTION_HEADINGS[section], record[SECTION_FIELDS[section]]),
  );
  for (const { heading, body } of record.extra ?? []) sections.push(sectionOf(heading, body));
  return `---\n${frontMatterOf(record)}---\n${sections.join('\n')}`;
}
