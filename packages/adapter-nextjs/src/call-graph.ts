/**
 * 정적 호출 그래프 (이슈 #59, view-flow 2.2 B안 · 4.0 "호출 단위의 해상도"). 흐름도 두 안의 공통 재료 —
 * A안에서는 스팬에 없는 노드(점선), B안에서는 본체.
 *
 * TypeScript 컴파일러 API로 대상 레포를 읽는다 (dependency-cruiser는 모듈 수준이라 심볼 수준이 안 나온다 — view-flow 6절 11번):
 *   `src/app/api/**\/route.ts`의 export `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS` 함수 본문 → 호출하는 식별자 → import 추적
 *   → 블록 공개 진입점(`src/domains/<d>/index.ts`가 re-export하는 함수) → 그 본문의 호출 중 같은 블록 내부 함수 **한 단계**
 *   (`config.flow.internalDepth`, 기본 1) → `repo.ts`의 `prisma.<model>.<op>` → 외부 시스템 노드 `ext:db:<model>.<op>`.
 *
 * 결과는 진입점당 `FlowNode` 트리 하나 (`kind: entry|public|internal|external|emit`, `anchor.file:line`, `evidence: 'static'`).
 * 식별자 해석은 체커의 심볼을 따르되, 인터페이스 타입으로 좁혀진 변수(`const domain: PaymentModule = payment`)는 초기화식의
 * 값 흐름(네임스페이스 import → 모듈 export)을 따라간다 — 타입 선언이 아니라 구현 위치가 필요하기 때문이다.
 *
 * 못 보는 것 (낙관적 오류 — 있는 연결을 없다고 할 수 있다, view-flow 2.3): 동적 `import()` · DI로 주입된 구현(인터페이스까지만) ·
 * 이벤트 핸들러 연결(`emit`은 보이고 `handlerUnknown`) · 미들웨어 체인 · 문자열로 조립한 호출. 그래서 B안 화면은 이 안내를 항상 띄운다.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AdapterContext, Anchor, FlowNode, StaticCallGraph, ToolInfo } from '@plumb/core';
import picomatch from 'picomatch';
import ts from 'typescript';
import { BlockClassifier } from './extract-dependencies.js';

export interface CallGraphOptions {
  /** 진입점 글롭 (루트 기준). 기본 `config.flow.entryGlob` → `src/app/api/**\/route.ts` */
  entryGlob?: string[];
  /** 공개 진입점 아래 내부 호출 깊이. 기본 `config.flow.internalDepth` → 1 */
  internalDepth?: number;
  /** 테스트 파일 글롭. 기본 testbed `vitest.config.ts`의 include와 같다 */
  testGlob?: string[];
  /** 걷는 소스 디렉토리. 기본 `src` · `test` */
  sourceDirs?: string[];
}

export const DEFAULT_ENTRY_GLOB = ['src/app/api/**/route.ts'];
export const DEFAULT_TEST_GLOB = ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.spec.ts'];
export const DEFAULT_SOURCE_DIRS = ['src', 'test'];
export const DEFAULT_INTERNAL_DEPTH = 1;

/** Next.js Route Handler가 export하는 HTTP 메서드 이름 */
export const HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.pgdata', '.work', 'coverage']);

// ---------------------------------------------------------------------------
// 파일 수집 · 라우트 경로
// ---------------------------------------------------------------------------

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/** `dirs` 아래 `.ts` · `.tsx` 파일 (루트 기준 posix 상대 경로, 정렬) */
export function listSourceFiles(root: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(abs, name);
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(toPosix(relative(root, full)));
    }
  };
  for (const dir of dirs) visit(join(root, dir));
  return out;
}

/**
 * Route Handler 파일 경로 → 표시 경로. `src/app/api/refunds/route.ts` → `/refunds`.
 * `app/` 뒤의 디렉토리를 세그먼트로 삼고, 라우트 그룹 `(group)`은 떼고, 선두 `api`는 뗀다 (testbed `openapi.yaml` `servers.url: /api` —
 * OpenAPI `paths`와 같은 꼴로 맞추기 위해. 데이터 모델/계약 View(#58)가 `Operation.path`와 조인한다). `[id]` → `{id}`.
 */
export function routePathOf(file: string): string {
  const posixFile = toPosix(file);
  const appIdx = posixFile.search(/(^|\/)app\//);
  const afterApp = appIdx === -1 ? posixFile : posixFile.slice(posixFile.indexOf('app/', appIdx) + 'app/'.length);
  const segments = afterApp
    .split('/')
    .slice(0, -1) // route.ts
    .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s))
    .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '{$1*}').replace(/^\[(.+)\]$/, '{$1}'));
  if (segments[0] === 'api') segments.shift();
  return `/${segments.join('/')}`;
}

// ---------------------------------------------------------------------------
// 컴파일러 설정
// ---------------------------------------------------------------------------

function compilerOptionsOf(root: string): ts.CompilerOptions {
  const configPath = join(root, 'tsconfig.json');
  let options: ts.CompilerOptions = {};
  if (existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
      options = parsed.options;
    }
  }
  return {
    ...options,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    declaration: false,
    tsBuildInfoFile: undefined,
    allowJs: options.allowJs ?? false,
    // 타입 검사는 하지 않는다 — 심볼 해석만 쓴다
    noResolve: false,
  };
}

// ---------------------------------------------------------------------------
// 그래프 만들기
// ---------------------------------------------------------------------------

interface Builder {
  root: string;
  checker: ts.TypeChecker;
  program: ts.Program;
  classifier: BlockClassifier;
  /** 블록 → 공개 진입점 파일이 export하는 선언 */
  publicDecls: Map<string, Map<ts.Declaration, string>>;
  internalDepth: number;
  symbols: Record<string, Anchor>;
  warnings: string[];
}

function relFile(b: Builder, sf: ts.SourceFile): string {
  return toPosix(relative(b.root, sf.fileName));
}

function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function anchorOf(b: Builder, node: ts.Node, block?: string): Anchor {
  const anchor: Anchor = { file: relFile(b, node.getSourceFile()), line: lineOf(node) };
  if (block) anchor.block = block;
  return anchor;
}

function deref(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function declOf(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/** 함수 모양 선언의 이름과 본문. `function f() {}` · `const f = () => {}` · `const f = function () {}` · 메서드 */
function functionOf(decl: ts.Declaration): { name: string; body: ts.Node } | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
    return decl.name && decl.body ? { name: decl.name.getText(), body: decl.body } : undefined;
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
    const init = decl.initializer;
    if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
      return { name: decl.name.text, body: init.body };
    }
  }
  return undefined;
}

/** 모듈(SourceFile) 심볼이면 그것 — 네임스페이스 import(`import * as payment`)의 끝 */
function moduleSymbolOf(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  const decl = declOf(symbol);
  if (decl && ts.isSourceFile(decl)) return symbol;
  if (symbol.flags & ts.SymbolFlags.ValueModule && symbol.exports && symbol.exports.size > 0) return symbol;
  return undefined;
}

/**
 * 식 → 가리키는 값의 선언. 식별자는 alias를 벗기고, 변수면 초기화식을 따라간다 (타입 주석이 인터페이스여도 값은 import한 모듈이다).
 * `obj.prop`는 `obj`를 모듈로 풀어 그 export `prop`를 찾는다.
 */
function resolveValue(b: Builder, expr: ts.Expression, depth = 0): ts.Declaration | undefined {
  if (depth > 8) return undefined;
  const { checker } = b;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return resolveValue(b, expr.expression, depth + 1);
  }
  if (ts.isIdentifier(expr)) {
    const symbol = deref(checker, checker.getSymbolAtLocation(expr));
    const decl = declOf(symbol);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = decl.initializer;
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
        const via = resolveValue(b, init, depth + 1);
        if (via) return via;
      }
    }
    return decl;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const owner = resolveModule(b, expr.expression, depth + 1);
    if (owner) {
      const exported = checker.getExportsOfModule(owner).find((s) => s.name === expr.name.text);
      return declOf(deref(checker, exported));
    }
    return declOf(deref(checker, checker.getSymbolAtLocation(expr.name)));
  }
  return undefined;
}

/** 식이 가리키는 모듈 심볼 (네임스페이스 import 또는 그것을 담은 변수) */
function resolveModule(b: Builder, expr: ts.Expression, depth: number): ts.Symbol | undefined {
  if (depth > 8) return undefined;
  const { checker } = b;
  if (ts.isIdentifier(expr)) {
    const raw = checker.getSymbolAtLocation(expr);
    const symbol = deref(checker, raw);
    const asModule = moduleSymbolOf(symbol);
    if (asModule) return asModule;
    const decl = declOf(symbol);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return resolveModule(b, decl.initializer, depth + 1);
    }
    return undefined;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr))
    return resolveModule(b, expr.expression, depth + 1);
  return undefined;
}

/** 본문 안의 모든 호출식 (소스 순서). 콜백 안의 호출도 이 함수의 호출로 본다 */
function callsIn(body: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return calls;
}

const PRISMA_CALL = /(?:^|[.)\s])prisma(?:\(\))?\.(\$?\w+)\.(\w+)$/;

/** `prisma().refund.create(...)` · `prisma.payment.update(...)` → `{ model, op }`. `$transaction` 같은 `$` 메서드는 안 센다 (인자 안의 호출이 따로 잡힌다) */
export function prismaOperationOf(calleeText: string): { model: string; op: string } | undefined {
  const match = PRISMA_CALL.exec(calleeText.replace(/\s+/g, ''));
  if (!match?.[1] || !match[2] || match[1].startsWith('$')) return undefined;
  return { model: match[1], op: match[2] };
}

/** `emit('topic')` · `bus.publish('topic')` → topic */
function emitTopicOf(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  if (!/^(emit|publish|dispatch)$/.test(name)) return undefined;
  const first = call.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : undefined;
}

function pushUnique(children: FlowNode[], node: FlowNode): FlowNode {
  const existing = children.find((c) => c.id === node.id && c.kind === node.kind);
  if (existing) return existing;
  children.push(node);
  return node;
}

interface Target {
  kind: 'public' | 'internal';
  block: string;
  name: string;
  decl: ts.Declaration;
  body: ts.Node;
}

/** 호출식의 대상이 블록 안 함수면 분류. 블록 밖(lib · node_modules · 라우트 자신)은 undefined */
function classifyCallee(b: Builder, call: ts.CallExpression): Target | undefined {
  const decl = resolveValue(b, call.expression);
  if (!decl) return undefined;
  const fn = functionOf(decl);
  if (!fn) return undefined;
  const file = relFile(b, decl.getSourceFile());
  if (file.startsWith('../') || /(^|\/)node_modules\//.test(file)) return undefined;
  const block = b.classifier.blockOf(file);
  if (!block) return undefined;
  const seed = b.classifier.seeds.get(block);
  if (seed?.kind !== 'domain' || seed.shared) return undefined;
  const publicName = b.publicDecls.get(block)?.get(decl);
  return {
    kind: publicName !== undefined ? 'public' : 'internal',
    block,
    name: publicName ?? fn.name,
    decl,
    body: fn.body,
  };
}

/**
 * 함수 본문의 호출 → 자식 노드. `depth`는 공개 진입점 아래 내부 깊이 (공개 진입점 본문 = 0).
 * 공개 → 공개는 깊이와 무관하게 따라간다 (블록 경계를 넘는 흐름). 내부는 `internalDepth`까지만.
 */
function childrenOf(b: Builder, body: ts.Node, depth: number, visiting: ReadonlySet<string>): FlowNode[] {
  const children: FlowNode[] = [];
  for (const call of callsIn(body)) {
    const calleeText = call.expression.getText();
    const prisma = prismaOperationOf(calleeText);
    if (prisma) {
      const id = `ext:db:${prisma.model}.${prisma.op}`;
      const node = pushUnique(children, {
        id,
        kind: 'external',
        label: `db: ${prisma.model}.${prisma.op}`,
        anchor: anchorOf(b, call),
        children: [],
        evidence: 'static',
        external: { system: 'db', operation: `${prisma.model}.${prisma.op}` },
      });
      b.symbols[id] ??= { ...(node.anchor as Anchor) };
      continue;
    }
    const topic = emitTopicOf(call);
    if (topic) {
      const id = `event:${topic}`;
      pushUnique(children, {
        id,
        kind: 'emit',
        label: `emit ${topic}`,
        anchor: anchorOf(b, call),
        children: [],
        evidence: 'static',
        handlerUnknown: true,
      });
      b.symbols[id] ??= anchorOf(b, call);
      continue;
    }
    const target = classifyCallee(b, call);
    if (!target) continue;
    const id = `${target.block}.${target.name}`;
    if (visiting.has(id)) continue; // 재귀 · 순환
    if (target.kind === 'internal' && depth >= b.internalDepth) continue; // 한 단계 규칙 (view-flow 4.0)

    const anchor = anchorOf(b, target.decl, target.block);
    b.symbols[id] ??= { ...anchor };
    const nextDepth = target.kind === 'public' ? 0 : depth + 1;
    const node = pushUnique(children, {
      id,
      kind: target.kind,
      label: id,
      anchor,
      children: [],
      evidence: 'static',
    });
    if (node.children.length === 0) {
      node.children = childrenOf(b, target.body, nextDepth, new Set([...visiting, id]));
    }
  }
  return children;
}

/** 파일이 export하는 HTTP 메서드 함수 (`export async function POST` · `export const GET = …`) */
function routeHandlersOf(sf: ts.SourceFile): Array<{ method: string; decl: ts.Declaration; body: ts.Node }> {
  const out: Array<{ method: string; decl: ts.Declaration; body: ts.Node }> = [];
  const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      const fn = functionOf(statement);
      if (fn && HTTP_METHODS.has(fn.name)) out.push({ method: fn.name, decl: statement, body: fn.body });
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const fn = functionOf(decl);
        if (fn && HTTP_METHODS.has(fn.name)) out.push({ method: fn.name, decl, body: fn.body });
      }
    }
  }
  return out;
}

/** 블록 공개 진입점 파일이 export하는 함수 선언 → export 이름 (`export { refund } from './payment'`를 체커가 풀어준다) */
function publicDeclsOf(b: Builder): Map<string, Map<ts.Declaration, string>> {
  const result = new Map<string, Map<ts.Declaration, string>>();
  for (const [block, seed] of b.classifier.seeds) {
    if (seed.kind !== 'domain' || seed.shared) continue;
    const map = new Map<ts.Declaration, string>();
    for (const publicFile of seed.public) {
      const sf = b.program.getSourceFile(join(b.root, publicFile));
      if (!sf) continue;
      const moduleSymbol = b.checker.getSymbolAtLocation(sf);
      if (!moduleSymbol) continue;
      for (const exported of b.checker.getExportsOfModule(moduleSymbol)) {
        const decl = declOf(deref(b.checker, exported));
        if (decl && functionOf(decl)) map.set(decl, exported.name);
      }
    }
    result.set(block, map);
  }
  return result;
}

/** 테스트 파일의 import → 공개 진입점 노드 ID → 테스트 파일. B안 "참조됨"의 재료 (view-flow 3절 "진입점의 테스트 있음/없음") */
function testRefsOf(b: Builder, testFiles: readonly string[]): Record<string, string[]> {
  const refs = new Map<string, Set<string>>();
  const add = (id: string, file: string) => {
    if (!refs.has(id)) refs.set(id, new Set());
    refs.get(id)?.add(file);
  };
  for (const file of testFiles) {
    const sf = b.program.getSourceFile(join(b.root, file));
    if (!sf) continue;
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
      const moduleSymbol = b.checker.getSymbolAtLocation(statement.moduleSpecifier);
      const target = declOf(moduleSymbol);
      if (!target || !ts.isSourceFile(target)) continue;
      const targetFile = relFile(b, target);
      const block = b.classifier.blockOf(targetFile);
      if (!block || !b.classifier.isPublic(block, targetFile)) continue;
      const publicNames = new Set(b.publicDecls.get(block)?.values() ?? []);
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (publicNames.has(name)) add(`${block}.${name}`, file);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        for (const name of publicNames) add(`${block}.${name}`, file);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const id of [...refs.keys()].sort()) out[id] = [...(refs.get(id) ?? [])].sort();
  return out;
}

/**
 * 정적 호출 그래프. `ctx.root` 밖은 읽지 않는다. 진입점 파일이 없으면 `entries: []` (view-flow 5절 "진입점 0개").
 * TS 파싱 자체가 안 되면 예외 — 코어가 `FlowView.graphError`에 적는다.
 */
export async function buildCallGraph(ctx: AdapterContext, options: CallGraphOptions = {}): Promise<StaticCallGraph> {
  const { root, config } = ctx;
  const entryGlob = options.entryGlob ?? config.flow?.entryGlob ?? DEFAULT_ENTRY_GLOB;
  const testGlob = options.testGlob ?? DEFAULT_TEST_GLOB;
  const internalDepth = options.internalDepth ?? config.flow?.internalDepth ?? DEFAULT_INTERNAL_DEPTH;
  const sourceDirs = options.sourceDirs ?? DEFAULT_SOURCE_DIRS;

  const files = listSourceFiles(root, sourceDirs);
  const isEntry = picomatch(entryGlob, { dot: true });
  const isTest = picomatch(testGlob, { dot: true });
  const entryFiles = files.filter((f) => isEntry(f));
  const testFiles = files.filter((f) => isTest(f));

  const classifier = new BlockClassifier(config);
  for (const file of files) classifier.blockOf(file); // 디렉토리 기본 규칙의 블록(src/domains/<d>)을 발견시킨다
  const publicFiles = [...classifier.seeds.values()]
    .flatMap((seed) => seed.public)
    .filter((f) => existsSync(join(root, f)));

  const rootNames = [...new Set([...entryFiles, ...testFiles, ...publicFiles])].map((f) => join(root, f));
  const program = ts.createProgram({ rootNames, options: compilerOptionsOf(root) });
  const checker = program.getTypeChecker();

  const b: Builder = {
    root,
    checker,
    program,
    classifier,
    publicDecls: new Map(),
    internalDepth,
    symbols: {},
    warnings: [],
  };
  b.publicDecls = publicDeclsOf(b);

  const syntaxErrors = program
    .getSyntacticDiagnostics()
    .filter((d) => d.file && !d.file.fileName.includes('node_modules'));
  if (syntaxErrors.length > 0) {
    const first = syntaxErrors[0];
    const where = first?.file ? `${relFile(b, first.file)}:${lineOf(first.file)}` : '?';
    throw new Error(
      `TS 파싱 오류 ${syntaxErrors.length}건 — ${where}: ${ts.flattenDiagnosticMessageText(first?.messageText ?? '', ' ')}`,
    );
  }

  const entries: FlowNode[] = [];
  for (const file of entryFiles) {
    const sf = program.getSourceFile(join(root, file));
    if (!sf) continue;
    const handlers = routeHandlersOf(sf);
    if (handlers.length === 0) b.warnings.push(`${file}: export된 HTTP 메서드 함수가 없다`);
    const path = routePathOf(file);
    for (const handler of handlers) {
      const id = `entry:${handler.method} ${path}`;
      const anchor = anchorOf(b, handler.decl, classifier.blockOf(file) ?? 'app');
      b.symbols[id] = { ...anchor };
      entries.push({
        id,
        kind: 'entry',
        label: `${handler.method} ${path}`,
        anchor,
        children: childrenOf(b, handler.body, 0, new Set([id])),
        evidence: 'static',
      });
    }
  }
  entries.sort((a, b2) => a.label.localeCompare(b2.label));

  b.warnings.push('정적 그래프는 동적 import · DI 구현 · 이벤트 핸들러 연결 · 미들웨어 순서를 보지 못한다');

  const tool: ToolInfo = { name: 'typescript', version: ts.version };
  return { tool, entries, symbols: b.symbols, testRefs: testRefsOf(b, testFiles), warnings: b.warnings };
}

/** 그래프의 모든 노드 ID (중복 없이, 깊이 우선 순서) */
export function allNodeIds(graph: StaticCallGraph): string[] {
  const ids: string[] = [];
  const visit = (node: FlowNode) => {
    if (!ids.includes(node.id)) ids.push(node.id);
    for (const child of node.children) visit(child);
  };
  for (const entry of graph.entries) visit(entry);
  return ids;
}

/** 디버깅 · 테스트용 한 줄 요약: `POST /refunds → payment.refund → payment.insertRefund → ext:db:refund.create` */
export function chainsOf(node: FlowNode): string[] {
  if (node.children.length === 0) return [node.label];
  return node.children.flatMap((child) => chainsOf(child).map((chain) => `${node.label} → ${chain}`));
}
