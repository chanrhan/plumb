/**
 * 데이터 모델 / 계약 View 생성기 (이슈 #55, view-data-contract 3절 · 5절 · 6절, 기획안 §5.1 · §5.4 · §7.2).
 *
 * 입력은 넷뿐이다 — 어댑터 `readSchemas()`(파서: Prisma · OpenAPI · AsyncAPI) · 어댑터 `extractDependencies()`(파서: 블록 그래프,
 * 엔드포인트 핸들러의 import 대상 블록) · 저장소 `contracts/`(승인 해시) + `checks/`(계약 테스트 결과) · git(승인 커밋 → HEAD diff).
 * 추론은 넣지 않는다: "이 엔드포인트가 이 모델을 쓴다"는 그리지 않고(6절 5번), 스키마 ↔ 모델 필드 차이는 이름이 같을 때만 기계적으로 비교한다.
 *
 * - `ContractFile.status`: 현재 해시 = 승인 해시 → `match`, 다르면 `changed`, 승인 기록 없음 → `unapproved`, 파일 없음 → `missing`
 * - 엔드포인트 소속 블록: `tags[0]`과 `src/app/api/<경로>/route.ts`의 경계 넘는 import 대상 블록. 둘이 다르면 `mismatch` 🟠 — 둘 다 보인다 (6절 3번)
 * - 모델 소속 블록: `config.contracts.models[<모델>]`이 있으면 그것, 없으면 `repo.ts`를 가진 블록이 **하나뿐일 때** 그 블록 (첫 구현 (b)).
 *   `prisma.<model>` 멤버 접근 스캔(c)은 AST가 필요해 미룬다 — 알 수 없으면 비운다
 * - `codeConformance`: 최신 `CheckRun`에서 `check.kind === 'contract'` 결과 집계. 실패 ≥ 1일 때만 `fail` 🔴. 계약 테스트가 없으면 `none` —
 *   "422가 계약에만 있다"는 사실만으로 🔴를 만들지 않는다 (§7.3 추정 금지)
 * - `diff`: 승인 기록이 있는 파일마다 `git diff <approval.commit> HEAD -- <path>` 헝크. 승인 기록이 없으면 `no-approved-contract`, git 없으면 `no-git`
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BlockGraph, SchemaFile, SchemaSet } from '../adapter/index.js';
import { sha256 } from '../store/fs.js';
import type {
  Anchor,
  CheckFailure,
  CheckRun,
  ContractApproval,
  ContractDiff,
  ContractFile,
  ContractView,
  EnumDef,
  Model,
  Operation,
  Relation,
  RuleId,
  SchemaRef,
  SourceRef,
} from '../types/index.js';
import { makeHeader, source } from './header.js';
import { anchorLink, codeSpan, escapeCell, heading, mdTable, mermaid, shortCommit, sourceBar } from './markdown.js';
import { adapterContextOf, type ViewContext, type ViewGenerator } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 1. 계약 파일 상태 띠
// ---------------------------------------------------------------------------

/** 어댑터 `SchemaFile` + 저장소 승인 기록 → `ContractFile`. `error`면 해시는 코어가 파일을 읽어 센다 (어댑터의 오류 변형에는 해시가 없다) */
export function toContractFile(
  root: string,
  kind: ContractFile['kind'],
  file: SchemaFile<unknown>,
  approval: ContractApproval | undefined,
): ContractFile {
  const out: ContractFile = { path: file.path, kind, exists: file.status !== 'missing', status: 'missing' };
  if (file.status === 'missing') return out;

  if (file.status === 'parsed') {
    out.hash = file.hash;
  } else {
    const anchor: Anchor = { file: file.path };
    if (file.line !== undefined) anchor.line = file.line;
    out.parseError = { message: file.message, anchor };
    try {
      out.hash = sha256(readFileSync(join(root, file.path), 'utf8'));
    } catch {
      // 읽을 수 없으면 해시 없음 — 상태는 승인 기록 유무로만
    }
  }
  if (approval !== undefined) {
    out.approved = { hash: approval.hash, approvedAt: approval.approvedAt, commit: approval.commit };
    if (approval.decision !== undefined) out.approved.decision = approval.decision;
    out.status = out.hash === approval.hash ? 'match' : 'changed';
  } else {
    out.status = 'unapproved';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 블록 소속 — 엔드포인트(핸들러 import) · 모델(repo.ts)
// ---------------------------------------------------------------------------

/** OpenAPI 경로 → Next.js Route Handler 파일. `/payments/{id}` → `src/app/api/payments/[id]/route.ts` */
export function routeFileOf(apiPath: string, appDir = 'src/app/api'): string {
  const segments = apiPath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^\{(.+)\}$/, '[$1]'));
  return [appDir, ...segments, 'route.ts'].join('/');
}

/** route 파일에서 `export async function POST` 등 메서드 핸들러의 줄. 없으면 1 */
function handlerLine(root: string, routeFile: string, method: string): number {
  try {
    const lines = readFileSync(join(root, routeFile), 'utf8').split(/\r?\n/);
    const re = new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`);
    const idx = lines.findIndex((l) => re.test(l));
    return idx === -1 ? 1 : idx + 1;
  } catch {
    return 1;
  }
}

/** 블록 그래프에서 핸들러 파일이 import하는 도메인 블록. 설정에 선언된 블록을 우선하고, 여럿이면 `,`로 잇는다 */
export function handlerBlocks(
  graph: BlockGraph,
  routeFile: string,
  declared: ReadonlySet<string>,
): { blocks: string[]; viaPublic: boolean } {
  const domainIds = new Set(graph.blocks.filter((b) => b.level === 'L1' && b.kind === 'domain').map((b) => b.id));
  const targets = new Map<string, boolean>();
  for (const edge of graph.edges) {
    if (!domainIds.has(edge.to)) continue;
    const sites = edge.imports.filter((site) => site.file === routeFile);
    if (sites.length === 0) continue;
    const prev = targets.get(edge.to) ?? true;
    targets.set(edge.to, prev && sites.every((site) => site.viaPublic));
  }
  let ids = [...targets.keys()].sort();
  const configured = ids.filter((id) => declared.has(id));
  if (configured.length > 0) ids = configured;
  return { blocks: ids, viaPublic: ids.every((id) => targets.get(id) ?? false) };
}

/** 글롭의 고정 접두 디렉토리 (`src/domains/payment/**` → `src/domains/payment`) */
function dirOfGlob(glob: string): string {
  const star = glob.search(/[*?[{]/);
  const prefix = star === -1 ? glob : glob.slice(0, star);
  return prefix.replace(/\/+$/, '');
}

/** `repo.ts`를 가진 L1 도메인 블록들 (첫 구현 (b)) */
export function blocksWithRepo(root: string, graph: BlockGraph): string[] {
  const out: string[] = [];
  for (const block of graph.blocks) {
    if (block.level !== 'L1' || block.kind !== 'domain') continue;
    const has = block.paths.some((glob) => {
      const dir = dirOfGlob(glob);
      return dir.length > 0 && existsSync(join(root, dir, 'repo.ts'));
    });
    if (has) out.push(block.id);
  }
  return out.sort();
}

/** 이름이 같은 OpenAPI 스키마와 Prisma 모델의 필드 이름 집합 차 (기계적 비교만, 6절 "⚠ 계약에 reason 없음") */
export function schemaModelDiff(schema: SchemaRef, model: Model): NonNullable<Operation['schemaModelDiff']>[number] {
  const inSchema = new Set(schema.properties.map((p) => p.name));
  const inModel = new Set(model.fields.map((f) => f.name));
  return {
    schema: schema.name ?? '',
    model: model.name,
    onlyInSchema: [...inSchema].filter((n) => !inModel.has(n)),
    onlyInModel: [...inModel].filter((n) => !inSchema.has(n)),
  };
}

interface BlockInput {
  root: string;
  graph: BlockGraph;
  declared: ReadonlySet<string>;
  models: Model[];
}

/** 어댑터 `Operation` → 소속 블록 · 핸들러 · 스키마↔모델 차이를 채운 `Operation` */
export function resolveOperation(op: Operation, input: BlockInput): Operation {
  const routeFile = routeFileOf(op.path);
  const fromTags = op.block.fromTags ?? (op as { tags?: string[] }).tags?.[0];
  const handler = handlerBlocks(input.graph, routeFile, input.declared);
  const fromHandler = handler.blocks.length > 0 ? handler.blocks.join(',') : undefined;
  const block: Operation['block'] = {
    mismatch: fromTags !== undefined && fromHandler !== undefined && fromTags !== fromHandler,
  };
  if (fromTags !== undefined) block.fromTags = fromTags;
  if (fromHandler !== undefined) block.fromHandler = fromHandler;

  const resolved: Operation = { ...op, anchor: { ...op.anchor }, block };
  const owner = fromHandler ?? fromTags;
  if (owner !== undefined) resolved.anchor.block = owner;

  if (existsSync(join(input.root, routeFile))) {
    const anchor: Anchor = { file: routeFile, line: handlerLine(input.root, routeFile, op.method), block: 'app' };
    resolved.handler = { anchor, viaPublic: handler.blocks.length > 0 && handler.viaPublic };
  }

  const byName = new Map(input.models.map((m) => [m.name, m]));
  const diffs: NonNullable<Operation['schemaModelDiff']> = [];
  const seen = new Set<string>();
  for (const schema of [op.request, ...op.responses.map((r) => r.schema)]) {
    if (schema?.name === undefined || seen.has(schema.name)) continue;
    const model = byName.get(schema.name);
    if (model === undefined) continue;
    seen.add(schema.name);
    const diff = schemaModelDiff(schema, model);
    if (diff.onlyInSchema.length > 0 || diff.onlyInModel.length > 0) diffs.push(diff);
  }
  if (diffs.length > 0) resolved.schemaModelDiff = diffs;
  return resolved;
}

// ---------------------------------------------------------------------------
// 3. 코드 일치 — 최신 CheckRun의 contract 검사
// ---------------------------------------------------------------------------

/** 최신 `CheckRun`에서 `kind === 'contract'` 결과를 집계한다. 없으면 `none` — 추정으로 🟢·🔴를 만들지 않는다 */
export function codeConformanceOf(latest: CheckRun | null): ContractView['codeConformance'] {
  if (latest === null) return { status: 'none', reason: 'not-run' };
  const results = latest.results.filter((r) => r.check.kind === 'contract' && r.outcome !== 'skipped');
  if (results.length === 0) return { status: 'none', reason: 'no-contract-tests' };
  const passed = results.filter((r) => r.outcome === 'pass').length;
  const failures: CheckFailure[] = [];
  for (const r of results) {
    if (r.outcome === 'pass') continue;
    failures.push(r.failure ?? { check: r.check, anchor: {}, message: `${r.outcome}: 실패 상세 없음` });
  }
  const ruleIds = [...new Set(results.flatMap((r) => r.ruleIds))].sort() as RuleId[];
  const lastCheck = { runId: latest.runId, commit: latest.commit, finishedAt: latest.finishedAt };
  if (failures.length === 0) return { status: 'pass', passed, failed: 0, ruleIds, lastCheck };
  return { status: 'fail', passed, failed: failures.length, ruleIds, failures, lastCheck };
}

// ---------------------------------------------------------------------------
// 4. 변경 — git diff 승인 커밋 → HEAD
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** unified diff 텍스트 → 헝크 요약 (`+N −M`, 새 파일 기준 시작 줄, 첫 변경 줄 발췌) */
export function parseHunks(file: string, diffText: string): ContractDiff['hunks'] {
  const hunks: ContractDiff['hunks'] = [];
  let current: ContractDiff['hunks'][number] | undefined;
  for (const line of diffText.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { anchor: { file, line: Number(header[3]) }, added: 0, removed: 0 };
      hunks.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      current.added += 1;
      if (current.excerpt === undefined) current.excerpt = line.slice(0, 120);
    } else if (line.startsWith('-')) {
      current.removed += 1;
      if (current.excerpt === undefined) current.excerpt = line.slice(0, 120);
    }
  }
  return hunks;
}

async function gitDiff(root: string, fromCommit: string, path: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['diff', fromCommit, 'HEAD', '--', path], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// 5. generate
// ---------------------------------------------------------------------------

function majorMinor(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** 파싱된 계약의 출처 한 줄. `openapi 3.1 (openapi.yaml)` · `prisma 6.19.3 (prisma/schema.prisma)` */
function parserSource(file: SchemaFile<unknown>): SourceRef | undefined {
  if (file.status !== 'parsed') return undefined;
  const version = file.tool.name === 'prisma' ? file.tool.version : majorMinor(file.tool.version);
  return source.parser(file.tool.name, version, file.path);
}

export async function generateContractView(ctx: ViewContext): Promise<ContractView> {
  const adapterCtx = adapterContextOf(ctx);
  const schemas: SchemaSet = await ctx.adapter.readSchemas(adapterCtx);
  const graph = await ctx.adapter.extractDependencies(adapterCtx);
  const approvals = await ctx.store.contracts.list();
  const latest = await ctx.store.checks.latest();
  const approvalOf = new Map(approvals.map((a) => [a.path, a]));

  const files: ContractFile[] = [
    toContractFile(ctx.root, 'openapi', schemas.openapi, approvalOf.get(schemas.openapi.path)),
    toContractFile(ctx.root, 'prisma', schemas.prisma, approvalOf.get(schemas.prisma.path)),
    toContractFile(ctx.root, 'asyncapi', schemas.asyncapi, approvalOf.get(schemas.asyncapi.path)),
  ];

  const declared = new Set(Object.keys(ctx.config.blocks ?? {}));
  const codeConformance = codeConformanceOf(latest);
  const now = ctx.now();

  // 출처 표시줄 — 실제로 읽은 것만
  const sources: SourceRef[] = [];
  for (const file of [schemas.prisma, schemas.openapi, schemas.asyncapi]) {
    const ref = parserSource(file);
    if (ref !== undefined) sources.push(ref);
  }
  sources.push(source.parser(graph.tool.name, graph.tool.version, 'src/app/api/**/route.ts'));
  sources.push(source.store('contracts/'));
  if (latest !== null) sources.push(source.execution('plumb check', undefined, `checks/${latest.runId}.json`));
  if (ctx.commit !== undefined) sources.push(source.git(ctx.commit));

  const view: ContractView = {
    header: makeHeader('contract', { commit: ctx.commit, now, sources }),
    files,
    codeConformance,
    diff: { unavailable: 'no-approved-contract' },
  };

  // DB — 모델 소속 블록은 설정 매핑 > repo.ts 블록이 하나뿐일 때
  if (schemas.prisma.status === 'parsed') {
    const repoBlocks = blocksWithRepo(ctx.root, graph);
    const mapping = ctx.config.contracts?.models ?? {};
    const models: Model[] = schemas.prisma.data.models.map((m) => {
      const model: Model = { ...m, anchor: { ...m.anchor } };
      const block = mapping[m.name] ?? (repoBlocks.length === 1 ? repoBlocks[0] : undefined);
      if (block !== undefined) {
        model.block = block;
        model.anchor.block = block;
      }
      return model;
    });
    view.db = { models, enums: schemas.prisma.data.enums, relations: schemas.prisma.data.relations };
  }

  // API — 소속 블록 두 출처 · 핸들러 · 스키마↔모델 차이
  if (schemas.openapi.status === 'parsed') {
    const models = view.db?.models ?? [];
    view.api = {
      operations: schemas.openapi.data.operations.map((op) =>
        resolveOperation(op, { root: ctx.root, graph, declared, models }),
      ),
    };
  }

  if (schemas.asyncapi.status === 'parsed') view.events = schemas.asyncapi.data;

  // 변경 — 승인 기록이 있는 파일만 비교 기준이 있다
  const approvedFiles = files.filter((f) => f.approved !== undefined);
  if (ctx.commit === undefined) {
    view.diff = { unavailable: 'no-git' };
  } else if (approvedFiles.length > 0) {
    const diffs: ContractDiff[] = [];
    for (const file of approvedFiles) {
      const approved = file.approved;
      if (approved === undefined) continue;
      const entry: ContractDiff = {
        file: file.path,
        hunks:
          file.status === 'match' ? [] : parseHunks(file.path, await gitDiff(ctx.root, approved.commit, file.path)),
        codeConformance: codeConformance.status,
      };
      if (approved.decision !== undefined) entry.decision = approved.decision;
      diffs.push(entry);
    }
    view.diff = diffs;
  }

  return view;
}

// ---------------------------------------------------------------------------
// 6. render
// ---------------------------------------------------------------------------

const FILE_STATUS_LABEL: Record<ContractFile['status'], string> = {
  match: '일치 🟢',
  changed: '변경 🔴',
  unapproved: '미승인 ⚠',
  missing: '파일 없음',
};

const KIND_LABEL: Record<ContractFile['kind'], string> = {
  openapi: 'OpenAPI',
  prisma: 'Prisma',
  asyncapi: 'AsyncAPI',
};

function shortHash(hash: string | undefined): string {
  return hash === undefined ? '—' : codeSpan(hash.slice(0, 7));
}

function renderFiles(files: ContractFile[]): string[] {
  const rows = files.map((f) => [
    codeSpan(f.path),
    KIND_LABEL[f.kind],
    FILE_STATUS_LABEL[f.status],
    f.exists ? shortHash(f.hash) : '—',
    f.approved ? shortHash(f.approved.hash) : '—',
    f.approved ? codeSpan(shortCommit(f.approved.commit)) : '—',
    f.approved?.decision ?? '—',
  ]);
  const out = [
    heading(2, '계약 파일'),
    '',
    mdTable(['파일', '종류', '상태', '현재 해시', '승인 해시', '승인 커밋', '승인 결정'], rows),
  ];
  const errors = files.filter((f) => f.parseError !== undefined);
  if (errors.length > 0) {
    out.push('');
    for (const f of errors) {
      const err = f.parseError;
      if (err === undefined) continue;
      out.push(`- 파싱 실패: ${escapeCell(err.message)} · ${anchorLink(err.anchor ?? { file: f.path })}`);
    }
  }
  return out;
}

function relationFieldLabel(field: Model['fields'][number], model: Model, relations: Relation[]): string {
  const rel = relations.find(
    (r) => (r.from === model.name && r.to === field.type) || (r.to === model.name && r.from === field.type),
  );
  if (rel === undefined) return '';
  const card = rel.from === model.name ? rel.cardinality : flip(rel.cardinality);
  const onDelete = rel.onDelete !== undefined && rel.from === model.name ? `, onDelete: ${rel.onDelete}` : '';
  return `→ ${field.type} (${card}${onDelete})`;
}

function flip(card: Relation['cardinality']): Relation['cardinality'] {
  if (card === '1:N') return 'N:1';
  if (card === 'N:1') return '1:N';
  return card;
}

/** Mermaid erDiagram. 관계 필드는 속성에서 빼고 간선으로만 그린다 (와이어프레임과 같다) */
export function renderErDiagram(db: NonNullable<ContractView['db']>): string {
  const modelNames = new Set(db.models.map((m) => m.name));
  const lines = ['erDiagram'];
  for (const rel of db.relations) {
    // from = FK 쪽. Mermaid: 참조되는 쪽(to)을 왼쪽에, `||--o{`는 "하나 ↔ 0개 이상"
    const connector = rel.cardinality === 'N:M' ? '}o--o{' : rel.cardinality === '1:1' ? '||--||' : '||--o{';
    const left = rel.cardinality === '1:N' ? rel.from : rel.to;
    const right = rel.cardinality === '1:N' ? rel.to : rel.from;
    const leftModel = db.models.find((m) => m.name === left);
    const label = leftModel?.fields.find((f) => f.type === right)?.name ?? rel.name ?? '';
    lines.push(`    ${left} ${connector} ${right} : "${label}"`);
  }
  if (db.relations.length > 0) lines.push('');
  for (const model of db.models) {
    lines.push(`    ${model.name} {`);
    for (const field of model.fields) {
      if (modelNames.has(field.type)) continue;
      const keys = [
        field.isId ? 'PK' : '',
        field.isUnique ? 'UK' : '',
        isForeignKey(field.name, model, db.relations) ? 'FK' : '',
      ]
        .filter((k) => k.length > 0)
        .join(',');
      const note = field.isRequired ? '' : ' "nullable"';
      lines.push(`        ${field.type}${field.isList ? '[]' : ''} ${field.name}${keys ? ` ${keys}` : ''}${note}`);
    }
    lines.push('    }');
  }
  return lines.join('\n');
}

function isForeignKey(fieldName: string, model: Model, relations: Relation[]): boolean {
  return relations.some((r) => r.from === model.name && r.fromFields.includes(fieldName));
}

function renderDb(view: ContractView): string[] {
  const out = [heading(2, '데이터 모델')];
  const prismaFile = view.files.find((f) => f.kind === 'prisma');
  if (view.db === undefined) {
    out.push('');
    if (prismaFile?.parseError !== undefined) {
      out.push(
        `파싱 실패: ${escapeCell(prismaFile.parseError.message)} · ${anchorLink(prismaFile.parseError.anchor ?? { file: prismaFile.path })}`,
      );
    } else {
      out.push(`스키마 파일 없음 (${codeSpan(prismaFile?.path ?? 'prisma/schema.prisma')})`);
    }
    return out;
  }
  const { models, enums, relations } = view.db;
  out.push(
    '',
    `모델 ${models.length} · enum ${enums.length} · 관계 ${relations.length} — 스키마는 블록 필터 대상이 아니다`,
  );
  for (const model of models) {
    const block = model.block === undefined ? '소속 블록 알 수 없음' : `블록 ${codeSpan(model.block)}`;
    out.push('', heading(3, `${model.name} — ${anchorLink(model.anchor)} · ${block}`), '');
    const rows = model.fields.map((f) => [
      codeSpan(f.name),
      `${f.type}${f.isList ? '[]' : ''}${f.isRequired ? '' : '?'}`,
      f.isRequired ? '예' : '아니오',
      [f.isId ? 'PK' : '', f.isUnique ? 'UK' : '', isForeignKey(f.name, model, relations) ? 'FK' : '']
        .filter(Boolean)
        .join(' '),
      relationFieldLabel(f, model, relations),
      f.default === undefined ? '' : codeSpan(f.default),
    ]);
    out.push(mdTable(['필드', '타입', '필수', '키', '관계', '기본값'], rows));
  }
  if (enums.length > 0) {
    out.push('', heading(3, 'enum'), '');
    out.push(
      mdTable(
        ['enum', '값', '위치'],
        enums.map((e: EnumDef) => [
          codeSpan(e.name),
          e.values.map(codeSpan).join(' · '),
          e.anchor ? anchorLink(e.anchor) : '',
        ]),
      ),
    );
  }
  out.push('', mermaid(renderErDiagram(view.db)));
  return out;
}

function blockCell(op: Operation): string {
  const { fromTags, fromHandler, mismatch } = op.block;
  if (mismatch) return `🟠 소속 불일치 — 태그 ${codeSpan(fromTags ?? '—')} · 핸들러 ${codeSpan(fromHandler ?? '—')}`;
  const owner = fromHandler ?? fromTags;
  if (owner === undefined) return '—';
  const basis =
    fromTags !== undefined && fromHandler !== undefined ? '태그 · 핸들러' : fromTags !== undefined ? '태그' : '핸들러';
  return `${codeSpan(owner)} (${basis})`;
}

function handlerCell(op: Operation): string {
  if (op.handler === undefined) return 'route 없음';
  return `${anchorLink(op.handler.anchor)} ${op.handler.viaPublic ? '🟢 공개 진입점' : '🔴 내부 파일 import'}`;
}

function responsesCell(op: Operation): string {
  return op.responses.map((r) => (r.schema?.name ? `${r.code} ${r.schema.name}` : r.code)).join(' · ');
}

function renderApi(view: ContractView): string[] {
  const out = [heading(2, 'API')];
  const file = view.files.find((f) => f.kind === 'openapi');
  if (view.api === undefined) {
    out.push('');
    if (file?.parseError !== undefined) {
      out.push(
        `파싱 실패: ${escapeCell(file.parseError.message)} · ${anchorLink(file.parseError.anchor ?? { file: file.path })}`,
      );
    } else {
      out.push(
        `OpenAPI 문서 없음 (${codeSpan(file?.path ?? 'openapi.yaml')}) — Route Handler에서 엔드포인트를 추정하지 않는다`,
      );
    }
    return out;
  }
  const ops = view.api.operations;
  const byBlock = new Map<string, number>();
  for (const op of ops) {
    const owner = op.block.fromHandler ?? op.block.fromTags ?? '(소속 없음)';
    byBlock.set(owner, (byBlock.get(owner) ?? 0) + 1);
  }
  const blockSummary = [...byBlock.entries()].map(([b, n]) => `${b} ${n}`).join(' · ');
  out.push('', `엔드포인트 ${ops.length}${blockSummary ? ` · 블록: ${blockSummary}` : ''}`, '');
  out.push(
    mdTable(
      ['메서드', '경로', 'operationId', '태그', '요청', '응답', '소속 블록', '구현 route'],
      ops.map((op) => [
        codeSpan(op.method),
        anchorLink(op.anchor, op.path),
        op.operationId === undefined ? '—' : codeSpan(op.operationId),
        ((op as { tags?: string[] }).tags ?? (op.block.fromTags ? [op.block.fromTags] : [])).join(', ') || '—',
        op.request?.name ?? (op.request ? '(인라인)' : '—'),
        responsesCell(op),
        blockCell(op),
        handlerCell(op),
      ]),
    ),
  );
  const diffs = ops.flatMap((op) => (op.schemaModelDiff ?? []).map((d) => ({ op, d })));
  if (diffs.length > 0) {
    out.push('', heading(3, '스키마 ↔ 모델 필드 차이 ⚠ (이름이 같은 것만 기계적 비교)'), '');
    const seen = new Set<string>();
    for (const { d } of diffs) {
      if (seen.has(d.schema)) continue;
      seen.add(d.schema);
      const only = [
        d.onlyInSchema.length > 0 ? `계약에만: ${d.onlyInSchema.map(codeSpan).join(', ')}` : '',
        d.onlyInModel.length > 0 ? `모델에만: ${d.onlyInModel.map(codeSpan).join(', ')}` : '',
      ].filter(Boolean);
      out.push(`- ${codeSpan(d.schema)} ↔ 모델 ${codeSpan(d.model)} — ${only.join(' · ')}`);
    }
  }
  return out;
}

function renderEvents(view: ContractView): string[] {
  const out = [heading(2, '이벤트')];
  const file = view.files.find((f) => f.kind === 'asyncapi');
  if (view.events === undefined) {
    out.push(
      '',
      file?.parseError
        ? `파싱 실패: ${escapeCell(file.parseError.message)}`
        : `이벤트 계약 없음 (${codeSpan(file?.path ?? 'asyncapi.yaml')} 없음)`,
    );
    return out;
  }
  const rows = view.events.channels.flatMap((c) =>
    c.messages.length === 0
      ? [[codeSpan(c.name), '—', '—']]
      : c.messages.map((m) => [codeSpan(c.name), codeSpan(m.name), m.payload?.name ?? (m.payload ? '(인라인)' : '—')]),
  );
  out.push('', mdTable(['채널', '메시지', 'payload'], rows));
  return out;
}

function renderConformance(view: ContractView): string[] {
  const out = [heading(2, '계약 ↔ 코드'), ''];
  const cc = view.codeConformance;
  if (cc.status === 'none') {
    out.push(
      cc.reason === 'no-contract-tests'
        ? '⬜ 계약 테스트 없음 — 상태 판정 불가. 규칙에 `checks[].kind: contract`인 검사가 없다'
        : '⬜ 검사 없음 — `plumb check`가 아직 실행되지 않았다',
    );
    if (view.api !== undefined && view.api.operations.length > 0) {
      out.push('', '계약에 정의된 응답 (검사 없음 — 구현 여부를 판정하지 않는다):', '');
      out.push(
        mdTable(
          ['엔드포인트', '응답 코드', '상태'],
          view.api.operations.map((op) => [
            `${op.method} ${op.path}`,
            op.responses.map((r) => r.code).join(' · '),
            '계약에 정의됨 · 검사 없음',
          ]),
        ),
      );
    }
    return out;
  }
  const total = cc.passed + cc.failed;
  const where = `${codeSpan(shortCommit(cc.lastCheck.commit))} · ${cc.lastCheck.finishedAt}`;
  if (cc.status === 'pass') {
    out.push(`🟢 코드 일치 — 계약 테스트 ${cc.passed}/${total} 통과 (${where})`);
  } else {
    out.push(
      `🔴 코드 불일치 — 계약 테스트 ${cc.failed}/${total} 실패 (${where}). 계약 변경 승인 직후의 불일치는 정상 상태다 — 파이프라인이 돌아 🟢가 된다 (기획안 §5.4)`,
      '',
      mdTable(
        ['검사', '위치', '메시지'],
        cc.failures.map((f) => [codeSpan(f.check.ref), anchorLink(f.anchor), escapeCell(f.message)]),
      ),
    );
  }
  if (cc.ruleIds.length > 0) out.push('', `규칙: ${cc.ruleIds.map(codeSpan).join(' · ')}`);
  return out;
}

function renderDiff(view: ContractView): string[] {
  const out = [heading(2, '변경'), ''];
  if (!Array.isArray(view.diff)) {
    out.push(
      view.diff.unavailable === 'no-git'
        ? 'git 이력 없음 — 해시 비교(일치/변경)만 가능하다'
        : '승인된 계약 없음 — 비교 기준 없음',
    );
    return out;
  }
  const head = view.header.commit === undefined ? 'HEAD' : codeSpan(shortCommit(view.header.commit));
  for (const d of view.diff) {
    const file = view.files.find((f) => f.path === d.file);
    const from = file?.approved ? codeSpan(shortCommit(file.approved.commit)) : '?';
    const decision = d.decision === undefined ? '' : ` · 승인 ${d.decision}`;
    const added = d.hunks.reduce((n, h) => n + h.added, 0);
    const removed = d.hunks.reduce((n, h) => n + h.removed, 0);
    out.push(heading(3, `${codeSpan(d.file)} — ${from} → ${head}${decision}`), '');
    if (d.hunks.length === 0) {
      out.push('변경 없음 (승인 해시와 일치)');
    } else {
      out.push(`헝크 ${d.hunks.length} · +${added} −${removed}`, '');
      out.push(
        mdTable(
          ['위치', '+', '−', '발췌'],
          d.hunks.map((h) => [
            anchorLink(h.anchor),
            String(h.added),
            String(h.removed),
            h.excerpt === undefined ? '' : codeSpan(h.excerpt),
          ]),
        ),
      );
    }
    out.push('');
  }
  while (out[out.length - 1] === '') out.pop();
  return out;
}

export function renderContractView(view: ContractView): string {
  const sections = [
    [heading(1, '데이터 모델 / 계약'), '', sourceBar(view.header.sources)],
    renderFiles(view.files),
    renderDb(view),
    renderApi(view),
    renderEvents(view),
    renderConformance(view),
    renderDiff(view),
  ];
  return `${sections.map((s) => s.join('\n')).join('\n\n')}\n`;
}

/** 데이터 모델 / 계약 View 생성기. `plumb views`(#60)가 {@link ViewGenerator}로 돌린다 */
export const contractView: ViewGenerator<ContractView> = {
  name: 'contract',
  generate: generateContractView,
  render: renderContractView,
};
