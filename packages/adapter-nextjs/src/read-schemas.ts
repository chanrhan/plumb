/**
 * `readSchemas()` — 계약 파일 세 개를 파서로 읽어 공통 형식으로 돌려준다 (이슈 #55, 기획안 §4.2 "스키마 읽기" · §5.1 계약).
 *
 * - Prisma `prisma/schema.prisma` → `@prisma/internals`의 `getDMMF({ datamodel })`(WASM, 엔진 바이너리 불필요) →
 *   모델 · 필드 · 관계 · enum. DMMF에는 줄 번호가 없으므로 `^model <이름> \{` · `^enum <이름> \{` · 필드 줄을 스키마 텍스트에서 찾아
 *   `file:line`을 붙인다 (view-data-contract 3절 "모델 file:line")
 * - OpenAPI `openapi.yaml` → `yaml`로 읽어 `paths[path][method]` → 엔드포인트. `$ref`는 `components.schemas`에서 해소한다.
 *   줄 번호는 YAML CST의 노드 범위에서 (`LineCounter`)
 * - AsyncAPI `asyncapi.yaml` → 채널 · 메시지. 파일이 없으면 `missing` — testbed에는 없다
 *
 * 어댑터는 **원자료만** 돌려준다: 승인 해시 비교(`ContractFile.status`) · 블록 소속(`Operation.block`) · 코드 일치는 코어(`views/contract.ts`)가 한다.
 * 파일이 없으면 `missing`, 깨졌으면 `error` — 이전 성공 결과를 대신 돌려주지 않는다 (view-data-contract 5절).
 * 파일 위치는 `config.contracts`(기본값 {@link DEFAULT_CONTRACT_PATHS}). `ctx.root` 밖은 읽지 않는다.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  AdapterContext,
  ApiSchema,
  DbSchema,
  EnumDef,
  EventSchema,
  Model,
  ModelField,
  Operation,
  Relation,
  SchemaFile,
  SchemaRef,
  SchemaSet,
  ToolInfo,
} from '@plumb/core';
import internals from '@prisma/internals';
import { isMap, isPair, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml';

// ---------------------------------------------------------------------------
// 타입 — 결과는 공유 타입(`SchemaSet` · `DbSchema` · `ApiSchema`) 그대로. DMMF `kind` · `relationName` · `documentation`,
// OpenAPI `tags` · `summary` · 응답 `description` · `components.schemas`는 #63에서 코어 타입의 선택 필드가 됐다
// ---------------------------------------------------------------------------

/** 계약 파일 종류와 기본 경로 (view-data-contract 머리 · `ContractsConfig`) */
export const DEFAULT_CONTRACT_PATHS = {
  openapi: 'openapi.yaml',
  prisma: 'prisma/schema.prisma',
  asyncapi: 'asyncapi.yaml',
} as const;

export type ContractKind = keyof typeof DEFAULT_CONTRACT_PATHS;

/** 응답 한 줄 (`Operation.responses[]` 항목) */
type OperationResponse = Operation['responses'][number];

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `config.contracts`의 경로. 없으면 기본값. 앞의 `./`는 뗀다 (저장소 `contracts/<파일>.json` 키와 맞추기 위해) */
export function contractPaths(ctx: AdapterContext): Record<ContractKind, string> {
  const configured = ctx.config.contracts ?? {};
  const normalize = (p: string) => p.replace(/^\.\//, '');
  return {
    openapi: normalize(configured.openapi ?? DEFAULT_CONTRACT_PATHS.openapi),
    prisma: normalize(configured.prisma ?? DEFAULT_CONTRACT_PATHS.prisma),
    asyncapi: normalize(configured.asyncapi ?? DEFAULT_CONTRACT_PATHS.asyncapi),
  };
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/** `ctx.root/<rel>` 텍스트. 없으면 `undefined` */
async function readContract(ctx: AdapterContext, rel: string): Promise<string | undefined> {
  try {
    return await readFile(join(ctx.root, rel), 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프를 지우는 정규식
const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function errorMessage(error: unknown): string {
  return stripAnsi(error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 1. Prisma — DMMF
// ---------------------------------------------------------------------------

/** 파싱에 쓴 `@prisma/internals`의 버전. 도구 이름은 `prisma` (출처 표시줄 `파서: prisma 6.x`) */
export function prismaToolInfo(): ToolInfo {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@prisma/internals/package.json') as { version?: unknown };
    return { name: 'prisma', version: typeof pkg.version === 'string' ? pkg.version : 'unknown' };
  } catch {
    return { name: 'prisma', version: 'unknown' };
  }
}

/** DMMF `Field.default` → 표시 문자열. 스키마 텍스트의 `@default(...)`가 있으면 그것이 우선 (`cuid()`가 DMMF에서는 `cuid(1)`) */
function formatDefault(fieldLine: string | undefined, raw: unknown): string | undefined {
  const fromText = fieldLine?.match(/@default\(((?:[^()]|\([^()]*\))*)\)/);
  if (fromText?.[1] !== undefined) return fromText[1];
  if (raw === undefined) return undefined;
  if (isRecord(raw) && typeof raw.name === 'string') {
    const args = Array.isArray(raw.args) ? raw.args.map(String).join(', ') : '';
    return `${raw.name}(${args})`;
  }
  if (Array.isArray(raw)) return `[${raw.map(String).join(', ')}]`;
  return String(raw);
}

/** 스키마 텍스트에서 `^(model|enum) <이름> {`의 줄과 그 블록 안 필드 줄을 찾는다. 못 찾으면 줄 1 */
export class PrismaLineFinder {
  private readonly lines: string[];

  constructor(text: string) {
    this.lines = text.split(/\r?\n/);
  }

  block(kind: 'model' | 'enum', name: string): number {
    const re = new RegExp(`^\\s*${kind}\\s+${name}\\s*\\{`);
    const idx = this.lines.findIndex((l) => re.test(l));
    return idx === -1 ? 1 : idx + 1;
  }

  /** 블록 시작 줄 다음부터 `}`까지에서 `<field>` 로 시작하는 줄 */
  field(kind: 'model' | 'enum', block: string, field: string): { line: number; text: string } | undefined {
    const start = this.block(kind, block);
    const re = new RegExp(`^\\s*${field}(\\s|$)`);
    for (let i = start; i < this.lines.length; i++) {
      const text = this.lines[i] ?? '';
      if (/^\s*\}/.test(text)) break;
      if (re.test(text)) return { line: i + 1, text };
    }
    return undefined;
  }
}

type DmmfField = Awaited<ReturnType<typeof internals.getDMMF>>['datamodel']['models'][number]['fields'][number];

function cardinalityOf(a: DmmfField, b: DmmfField): Relation['cardinality'] {
  if (a.isList && b.isList) return 'N:M';
  if (!a.isList && !b.isList) return '1:1';
  // a가 FK를 가진 쪽(단수) → a N : 1 b
  return a.isList ? '1:N' : 'N:1';
}

/** DMMF `datamodel` + 스키마 텍스트 → 모델 · enum · 관계 */
export function toDbSchema(
  datamodel: Awaited<ReturnType<typeof internals.getDMMF>>['datamodel'],
  text: string,
  file: string,
): DbSchema {
  const finder = new PrismaLineFinder(text);

  const models: Model[] = datamodel.models.map((m) => {
    const fields: ModelField[] = m.fields.map((f) => {
      const at = finder.field('model', m.name, f.name);
      const field: ModelField = {
        name: f.name,
        type: f.type,
        kind: f.kind,
        isRequired: f.isRequired,
        isList: f.isList,
        isId: f.isId,
        isUnique: f.isUnique,
        anchor: { file, line: at?.line ?? finder.block('model', m.name) },
      };
      const def = formatDefault(at?.text, f.default);
      if (def !== undefined) field.default = def;
      if (f.documentation !== undefined) field.documentation = f.documentation;
      if (f.relationName !== undefined) field.relationName = f.relationName;
      return field;
    });
    const model: Model = { name: m.name, fields, anchor: { file, line: finder.block('model', m.name) } };
    if (m.documentation !== undefined) model.documentation = m.documentation;
    return model;
  });

  const enums: EnumDef[] = datamodel.enums.map((e) => ({
    name: e.name,
    values: e.values.map((v) => v.name),
    anchor: { file, line: finder.block('enum', e.name) },
  }));

  // 관계: relationName이 같은 object 필드 쌍. FK(`relationFromFields`)를 가진 쪽이 from
  const byRelation = new Map<string, Array<{ model: string; field: DmmfField }>>();
  for (const m of datamodel.models) {
    for (const f of m.fields) {
      if (f.kind !== 'object') continue;
      const key = f.relationName ?? `${m.name}To${f.type}`;
      const list = byRelation.get(key) ?? [];
      list.push({ model: m.name, field: f });
      byRelation.set(key, list);
    }
  }
  const relations: Relation[] = [];
  for (const [name, sides] of byRelation) {
    const first = sides[0];
    if (first === undefined) continue;
    const second = sides[1] ?? { model: first.field.type, field: first.field };
    const fkSide = (first.field.relationFromFields?.length ?? 0) > 0 ? first : second;
    const other = fkSide === first ? second : first;
    const relation: Relation = {
      from: fkSide.model,
      to: other.model,
      name,
      cardinality: cardinalityOf(fkSide.field, other.field),
      fromFields: [...(fkSide.field.relationFromFields ?? [])],
      toFields: [...(fkSide.field.relationToFields ?? [])],
    };
    if (fkSide.field.relationOnDelete !== undefined) relation.onDelete = fkSide.field.relationOnDelete;
    relations.push(relation);
  }
  relations.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return { models, enums, relations };
}

/** DMMF 오류 메시지 → 첫 의미 있는 줄 + `schema.prisma:<줄>` */
function prismaError(path: string, error: unknown): SchemaFile<DbSchema> {
  const text = errorMessage(error);
  const lineMatch = text.match(/-->\s+\S+:(\d+)/);
  const message =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^error:/i.test(l))
      ?.replace(/^error:\s*/i, '') ??
    text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ??
    '알 수 없는 오류';
  const out: SchemaFile<DbSchema> = { path, status: 'error', message };
  if (lineMatch?.[1] !== undefined) out.line = Number(lineMatch[1]);
  return out;
}

export async function readPrisma(ctx: AdapterContext, path: string): Promise<SchemaFile<DbSchema>> {
  const text = await readContract(ctx, path);
  if (text === undefined) return { path, status: 'missing' };
  try {
    const dmmf = await internals.getDMMF({ datamodel: text });
    return {
      path,
      status: 'parsed',
      hash: sha256(text),
      tool: prismaToolInfo(),
      data: toDbSchema(dmmf.datamodel, text, path),
    };
  } catch (error) {
    return prismaError(path, error);
  }
}

// ---------------------------------------------------------------------------
// 2. OpenAPI — yaml
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const REF_PREFIX = '#/components/schemas/';

function refName(schema: Record<string, unknown>): string | undefined {
  const ref = schema.$ref;
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined;
}

/** `type` 문자열 (3.1의 `type: [string, 'null']`는 `string|null`). `$ref`면 참조 이름. 없으면 `enum`/`items`에서 추정하지 않고 `unknown` */
function typeOf(schema: unknown): string {
  if (!isRecord(schema)) return 'unknown';
  const name = refName(schema);
  if (name !== undefined) return name;
  if (typeof schema.type === 'string') {
    if (schema.type === 'array' && isRecord(schema.items)) return `${typeOf(schema.items)}[]`;
    return schema.type;
  }
  if (Array.isArray(schema.type)) return schema.type.map(String).join('|');
  return 'unknown';
}

/** 스키마 객체 → `SchemaRef`. `$ref`는 `components.schemas`에서 한 단계 해소한다 (이름이 붙는다) */
export function toSchemaRef(schema: unknown, components: Record<string, unknown>): SchemaRef | undefined {
  if (!isRecord(schema)) return undefined;
  let target: Record<string, unknown> = schema;
  const out: SchemaRef = { properties: [] };
  const name = refName(schema);
  if (name !== undefined) {
    out.name = name;
    const resolved = components[name];
    if (!isRecord(resolved)) return out;
    target = resolved;
  }
  const required = new Set(Array.isArray(target.required) ? target.required.map(String) : []);
  if (isRecord(target.properties)) {
    for (const [propName, prop] of Object.entries(target.properties)) {
      const entry: SchemaRef['properties'][number] = {
        name: propName,
        type: typeOf(prop),
        required: required.has(propName),
      };
      if (isRecord(prop)) {
        if (typeof prop.format === 'string') entry.format = prop.format;
        if (typeof prop.minimum === 'number') entry.minimum = prop.minimum;
      }
      out.properties.push(entry);
    }
  }
  return out;
}

/** `content[application/json].schema` (없으면 첫 미디어 타입) */
function contentSchema(holder: unknown): unknown {
  if (!isRecord(holder) || !isRecord(holder.content)) return undefined;
  const json = holder.content['application/json'];
  const first = Object.values(holder.content)[0];
  const media = isRecord(json) ? json : first;
  return isRecord(media) ? media.schema : undefined;
}

/** `paths` 아래 (경로, 메서드) 키 노드의 줄 번호 */
function operationLines(doc: ReturnType<typeof parseDocument>, lineCounter: LineCounter): Map<string, number> {
  const lines = new Map<string, number>();
  const paths = doc.get('paths', true);
  if (!isMap(paths)) return lines;
  for (const pathPair of paths.items) {
    if (!isPair(pathPair) || !isScalar(pathPair.key) || !isMap(pathPair.value)) continue;
    const pathName = String(pathPair.key.value);
    for (const methodPair of pathPair.value.items) {
      if (!isPair(methodPair) || !isScalar(methodPair.key)) continue;
      const key = methodPair.key as Node;
      const offset = key.range?.[0];
      if (offset === undefined) continue;
      lines.set(`${String(methodPair.key.value)} ${pathName}`, lineCounter.linePos(offset).line);
    }
  }
  return lines;
}

function isYamlSeqOrMap(node: unknown): boolean {
  return isMap(node) || isSeq(node);
}

/** OpenAPI 문서(JS 객체) + 줄 번호 → 엔드포인트 · 스키마 목록 */
export function toApiSchema(raw: Record<string, unknown>, file: string, lines: Map<string, number>): ApiSchema {
  const components = isRecord(raw.components) && isRecord(raw.components.schemas) ? raw.components.schemas : {};
  const operations: Operation[] = [];
  const paths = isRecord(raw.paths) ? raw.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : [];
      const responses: OperationResponse[] = [];
      if (isRecord(op.responses)) {
        for (const [code, response] of Object.entries(op.responses)) {
          const entry: OperationResponse = { code };
          const schema = toSchemaRef(contentSchema(response), components);
          if (schema !== undefined) entry.schema = schema;
          if (isRecord(response) && typeof response.description === 'string') entry.description = response.description;
          responses.push(entry);
        }
      }
      const upper = method.toUpperCase();
      const operation: Operation = {
        method: upper,
        path,
        tags,
        anchor: { file, line: lines.get(`${method} ${path}`) ?? 1 },
        responses,
        block: { mismatch: false },
      };
      if (typeof op.operationId === 'string') operation.operationId = op.operationId;
      if (typeof op.summary === 'string') operation.summary = op.summary;
      const request = toSchemaRef(contentSchema(op.requestBody), components);
      if (request !== undefined) operation.request = request;
      const firstTag = tags[0];
      if (firstTag !== undefined) operation.block.fromTags = firstTag;
      operations.push(operation);
    }
  }
  const schemas: SchemaRef[] = Object.keys(components)
    .sort()
    .map((name) => toSchemaRef({ $ref: `${REF_PREFIX}${name}` }, components))
    .filter((s): s is SchemaRef => s !== undefined);
  return { operations, schemas };
}

interface ParsedYaml {
  raw: Record<string, unknown>;
  doc: ReturnType<typeof parseDocument>;
  lineCounter: LineCounter;
}

/** YAML 텍스트 → 문서. 구문 오류는 첫 오류와 줄 번호로 */
function parseYamlDocument(
  path: string,
  text: string,
): ParsedYaml | { status: 'error'; message: string; line?: number } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: false });
  const first = doc.errors[0];
  if (first !== undefined) {
    const out: { status: 'error'; message: string; line?: number } = {
      status: 'error',
      message: first.message.split('\n')[0] ?? first.message,
    };
    const pos = first.pos[0];
    if (pos !== undefined) out.line = lineCounter.linePos(pos).line;
    return out;
  }
  const raw: unknown = doc.toJS();
  if (!isRecord(raw)) return { status: 'error', message: `${path}: YAML 최상위가 객체가 아니다` };
  return { raw, doc, lineCounter };
}

export async function readOpenApi(ctx: AdapterContext, path: string): Promise<SchemaFile<ApiSchema>> {
  const text = await readContract(ctx, path);
  if (text === undefined) return { path, status: 'missing' };
  const parsed = parseYamlDocument(path, text);
  if ('status' in parsed) return { path, ...parsed };
  const version = parsed.raw.openapi;
  if (typeof version !== 'string' || !isRecord(parsed.raw.paths)) {
    return {
      path,
      status: 'error',
      message: 'OpenAPI 문서가 아니다 — `openapi` 버전 문자열과 `paths` 객체가 필요하다',
    };
  }
  if (!isYamlSeqOrMap(parsed.doc.contents)) {
    return { path, status: 'error', message: 'OpenAPI 문서가 비어 있다' };
  }
  return {
    path,
    status: 'parsed',
    hash: sha256(text),
    tool: { name: 'openapi', version },
    data: toApiSchema(parsed.raw, path, operationLines(parsed.doc, parsed.lineCounter)),
  };
}

// ---------------------------------------------------------------------------
// 3. AsyncAPI — yaml (2.x `publish/subscribe.message` · 3.x `channels.<c>.messages`)
// ---------------------------------------------------------------------------

export function toEventSchema(raw: Record<string, unknown>): EventSchema {
  const components = isRecord(raw.components) && isRecord(raw.components.schemas) ? raw.components.schemas : {};
  const channels: EventSchema['channels'] = [];
  const rawChannels = isRecord(raw.channels) ? raw.channels : {};
  for (const [name, channel] of Object.entries(rawChannels)) {
    if (!isRecord(channel)) continue;
    const messages: EventSchema['channels'][number]['messages'] = [];
    const push = (msgName: string, message: unknown) => {
      const entry: EventSchema['channels'][number]['messages'][number] = { name: msgName };
      const payload = isRecord(message) ? toSchemaRef(message.payload, components) : undefined;
      if (payload !== undefined) entry.payload = payload;
      messages.push(entry);
    };
    if (isRecord(channel.messages)) {
      for (const [msgName, message] of Object.entries(channel.messages)) push(msgName, message);
    }
    for (const op of ['publish', 'subscribe'] as const) {
      const operation = channel[op];
      if (!isRecord(operation) || !isRecord(operation.message)) continue;
      const message = operation.message;
      const msgName = typeof message.name === 'string' ? message.name : `${op}`;
      push(msgName, message);
    }
    channels.push({ name, messages });
  }
  return { channels };
}

export async function readAsyncApi(ctx: AdapterContext, path: string): Promise<SchemaFile<EventSchema>> {
  const text = await readContract(ctx, path);
  if (text === undefined) return { path, status: 'missing' };
  const parsed = parseYamlDocument(path, text);
  if ('status' in parsed) return { path, ...parsed };
  const version = parsed.raw.asyncapi;
  if (typeof version !== 'string') {
    return { path, status: 'error', message: 'AsyncAPI 문서가 아니다 — `asyncapi` 버전 문자열이 필요하다' };
  }
  return {
    path,
    status: 'parsed',
    hash: sha256(text),
    tool: { name: 'asyncapi', version },
    data: toEventSchema(parsed.raw),
  };
}

// ---------------------------------------------------------------------------
// 4. 진입점
// ---------------------------------------------------------------------------

/** 세 계약 파일을 읽는다. 하나가 없거나 깨져도 나머지는 돌려준다 — 항목별 `missing` · `error` */
export async function readSchemas(ctx: AdapterContext): Promise<SchemaSet> {
  const paths = contractPaths(ctx);
  const [openapi, prisma, asyncapi] = await Promise.all([
    readOpenApi(ctx, paths.openapi),
    readPrisma(ctx, paths.prisma),
    readAsyncApi(ctx, paths.asyncapi),
  ]);
  return { openapi, prisma, asyncapi };
}
