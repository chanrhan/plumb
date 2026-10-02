/**
 * View 저장 `views/<name>.json` · `views/<name>.md` (이슈 #53, work-views 3절, docs/types/README.md 결정 1 "View 정본은 JSON").
 *
 * - JSON이 정본이다. Markdown은 렌더링이며 같은 머리말(`view` · `generatedAt` · `commit` · `sources`)을 YAML front matter로 갖는다 —
 *   `write()`가 View JSON의 머리말에서 만들어 붙이므로 두 파일의 `generatedAt`은 항상 같다
 * - 둘 다 원자적으로 쓴다 (`fs.ts`). Markdown을 먼저, JSON을 나중에 — 새 JSON이 보이면 그 Markdown도 이미 있다
 * - `read()`는 JSON이 없으면 `null`(→ API 404 "View 없음"). JSON은 있는데 Markdown이 없거나 머리말이 어긋나면 {@link ViewStoreError} —
 *   반쪽을 조용히 그리지 않는다
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { SourceRef, View, ViewHeader, ViewName } from '../types/index.js';
import { isViewName, VIEW_NAMES } from '../views/types.js';
import { StoreError, ValidationError } from './errors.js';
import { isEnoent, listFiles, readJsonFile, writeFileAtomic, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';

export const viewNameSchema = z.custom<ViewName>((value) => isViewName(value), {
  message: 'View 이름 여섯 개 중 하나',
});

export const sourceKindSchema = z.enum(['parser', 'execution', 'store', 'git', 'user-input']);

export const sourceRefSchema = z
  .object({
    kind: sourceKindSchema,
    tool: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    input: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
  })
  .strict() satisfies z.ZodType<SourceRef, z.ZodTypeDef, unknown>;

export const viewHeaderSchema = z
  .object({
    view: viewNameSchema,
    generatedAt: z.string().datetime({ offset: true }),
    commit: z.string().min(1).optional(),
    sources: z.array(sourceRefSchema),
  })
  .strict() satisfies z.ZodType<ViewHeader, z.ZodTypeDef, unknown>;

/** 머리말만 검증한다. View 본문의 모양은 각 생성기(#54~#59)의 타입이 책임진다 */
const viewEnvelopeSchema = z.object({ header: viewHeaderSchema }).passthrough();

/** 저장된 View 하나: JSON(정본) + Markdown 본문(front matter 제외) */
export interface StoredView {
  view: View;
  markdown: string;
}

/** `list()` 한 항목. 탭 상태 · 생성 시각 · 커밋 (work-views 3절 "탭 6개의 활성 여부" · "마지막 생성 시각/커밋") */
export interface ViewListItem {
  name: ViewName;
  generatedAt: string;
  commit?: string;
}

/** JSON은 있는데 Markdown이 없거나 두 파일의 머리말이 어긋난다 — `plumb views`로 다시 생성한다 */
export class ViewStoreError extends StoreError {
  override readonly name = 'ViewStoreError';
  constructor(
    readonly view: ViewName,
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: View ${view} — ${detail}. plumb views로 다시 생성한다`);
  }
}

function parseHeader(raw: unknown, where: string): ViewHeader {
  const result = viewEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: View 머리말이 스키마에 맞지 않는다`, result.error.issues);
  }
  return result.data.header;
}

// ---------------------------------------------------------------------------
// Markdown front matter
// ---------------------------------------------------------------------------

const FRONT_MATTER_OPEN = '---\n';
const FRONT_MATTER_CLOSE = '\n---\n';

/** Markdown 본문 앞에 머리말 YAML front matter를 붙인다. 본문은 그대로 — 끝에 줄바꿈 하나만 보장 */
export function formatViewMarkdown(header: ViewHeader, body: string): string {
  const yaml = stringifyYaml(header, { lineWidth: 0 }).replace(/\n$/, '');
  const text = body.replace(/\n*$/, '');
  return `${FRONT_MATTER_OPEN}${yaml}${FRONT_MATTER_CLOSE}${text.length === 0 ? '' : `\n${text}\n`}`;
}

/** `formatViewMarkdown`의 역. front matter가 없거나 YAML이 아니면 {@link ValidationError} */
export function parseViewMarkdown(text: string, where = '입력'): { header: ViewHeader; body: string } {
  if (!text.startsWith(FRONT_MATTER_OPEN)) {
    throw new ValidationError(`${where}: View Markdown에 머리말(front matter)이 없다`);
  }
  const close = text.indexOf(FRONT_MATTER_CLOSE, FRONT_MATTER_OPEN.length);
  if (close < 0) throw new ValidationError(`${where}: View Markdown 머리말이 닫히지 않았다`);
  const yaml = text.slice(FRONT_MATTER_OPEN.length, close);
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (error) {
    throw new ValidationError(
      `${where}: View Markdown 머리말을 YAML로 읽을 수 없다 — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = viewHeaderSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: View Markdown 머리말이 스키마에 맞지 않는다`, result.error.issues);
  }
  const body = text
    .slice(close + FRONT_MATTER_CLOSE.length)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
  return { header: result.data, body };
}

// ---------------------------------------------------------------------------
// 쓰기 · 읽기 · 목록
// ---------------------------------------------------------------------------

/**
 * `views/<name>.md`(front matter + 본문)와 `views/<name>.json`(정본)을 이 순서로 원자적으로 쓴다.
 * `name`과 `view.header.view`가 다르면 {@link ValidationError} — 다른 이름의 파일에 View를 쓰지 않는다.
 */
export async function writeView(
  paths: StorePaths,
  name: ViewName,
  view: View | unknown,
  markdown: string,
): Promise<StoredView> {
  if (!isViewName(name)) throw new ValidationError(`View 이름 "${String(name)}"은(는) 여섯 개 중 하나가 아니다`);
  if (typeof markdown !== 'string') throw new ValidationError(`views.write(${name}): Markdown은 문자열이어야 한다`);
  const header = parseHeader(view, `views.write(${name})`);
  if (header.view !== name) {
    throw new ValidationError(`views.write(${name}): View 머리말의 view가 "${header.view}"다 — 이름이 다르다`);
  }
  await writeFileAtomic(paths.view(name, 'md'), formatViewMarkdown(header, markdown));
  await writeJsonAtomic(paths.view(name, 'json'), view);
  return { view: view as View, markdown };
}

/**
 * JSON(정본)과 Markdown 본문. JSON이 없으면 `null`. Markdown이 없거나 두 파일의 `generatedAt`이 다르면 {@link ViewStoreError}.
 */
export async function readView(paths: StorePaths, name: ViewName): Promise<StoredView | null> {
  if (!isViewName(name)) return null;
  const jsonPath = paths.view(name, 'json');
  const raw = await readJsonFile(jsonPath);
  if (raw === undefined) return null;
  const header = parseHeader(raw, jsonPath);
  if (header.view !== name) throw new ViewStoreError(name, jsonPath, `머리말의 view가 "${header.view}"다`);

  const mdPath = paths.view(name, 'md');
  let text: string;
  try {
    text = await readFile(mdPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) throw new ViewStoreError(name, mdPath, 'JSON은 있는데 Markdown이 없다');
    throw error;
  }
  const md = parseViewMarkdown(text, mdPath);
  if (md.header.generatedAt !== header.generatedAt) {
    throw new ViewStoreError(
      name,
      mdPath,
      `Markdown의 generatedAt(${md.header.generatedAt})이 JSON(${header.generatedAt})과 다르다`,
    );
  }
  return { view: raw as View, markdown: md.body };
}

/**
 * 저장된 View 목록. 순서는 {@link VIEW_NAMES}(탭 순서) — 생성 시각이 아니다. 여섯 이름이 아닌 파일은 무시한다.
 * 폴더가 없으면 빈 배열.
 */
export async function listViews(paths: StorePaths): Promise<ViewListItem[]> {
  const items: ViewListItem[] = [];
  for (const file of await listFiles(paths.viewsDir, '.json')) {
    const name = file.slice(0, -'.json'.length);
    if (!isViewName(name)) continue;
    const path = paths.view(name, 'json');
    const raw = await readJsonFile(path);
    if (raw === undefined) continue;
    const header = parseHeader(raw, path);
    const item: ViewListItem = { name, generatedAt: header.generatedAt };
    if (header.commit !== undefined) item.commit = header.commit;
    items.push(item);
  }
  return items.sort((a, b) => VIEW_NAMES.indexOf(a.name) - VIEW_NAMES.indexOf(b.name));
}
