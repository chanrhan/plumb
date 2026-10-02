/**
 * `extractDependencies()` — dependency-cruiser JSON + `plumb.config.json blocks` → 블록 그래프 JSON (이슈 #45, 기획안 §4.2 · §12).
 *
 * 입력은 `depcruise src --config .dependency-cruiser.cjs --output-type json`의 `modules[]`(파일) · `dependencies[].resolved`(import 끝점).
 * 어댑터는 그것을 블록 경계로 **접기만** 한다 — 판정(필수 검사 결과 · 규칙 상태)은 코어가 한다.
 *
 * 파일 → 블록 (순서대로 첫 번째가 이긴다):
 *   (1) `config.blocks[<id>].include` 글롭에 맞으면 그 블록
 *   (2) `src/domains/<d>/**` → 블록 `<d>` (설정에 없어도 — `declared: false`)
 *   (3) `src/app/**` → `app` (`kind: 'entry'`, view-architecture 6절 6번)
 *   (4) `src/lib/**` → `lib` (공유 코드. `BlockKind`에 'shared'가 없어 `kind: 'domain'` + `shared: true`)
 *   (5) 그 외 → **미분류** (`unclassified[]`. `config.ignore` 글롭은 제외)
 * `node_modules` · 외부 패키지는 파일이 아니라 `externals: { [pkg]: fromBlocks[] }`로 따로 센다 (의존성 View 재료).
 *
 * L0 노드는 설정·인프라 **파일에서 감지된 것만** 만든다 (`prisma/schema.prisma` datasource · `docker-compose.yml` services).
 * `process.env.*` 참조 스캔은 M8 (view-architecture 6절 4번) — 지금은 하지 않는다. 환경변수 **이름**만 다루고 값은 읽지 않는다.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AdapterContext,
  BlockConfig,
  BlockEdge,
  BlockGraph,
  BlockNode,
  Evidence,
  ImportSite,
  InfraEdge,
  InfraKind,
  PlumbConfig,
  Risk,
  ToolInfo,
} from '@plumb/core';
import picomatch from 'picomatch';

// ---------------------------------------------------------------------------
// 타입 — 코어 `BlockGraph`의 상위집합. 더한 필드는 PR의 "타입 보완 후보"
// ---------------------------------------------------------------------------

/**
 * 간선이 허용되는 근거. `config` = `blocks[from].dependsOn`에 `to`가 있다 · `entry` = `app → *`는 항상 허용 (§4.4 "app은 공개
 * 진입점만 import") · `shared` = `* → lib`는 항상 허용. `null`이면 미선언 (`declared: false`).
 */
export type DeclaredBy = 'config' | 'entry' | 'shared';

/** L1 블록 노드 + 이 어댑터가 더한 필드 */
export interface NextjsBlockNode extends BlockNode {
  /** `config.blocks`에 선언된 블록인가. 디렉토리 기본 규칙으로만 발견된 블록(`src/domains/<d>` · `app` · `lib`)은 `false` */
  declared: boolean;
  /** `config.blocks[id].risk` 그대로 */
  risk?: Risk;
  /** 공유 코드 블록(`lib`). 모든 파일이 공개 진입점이고 누구나 의존해도 된다 */
  shared?: boolean;
}

/** L1 간선 + 허용 근거 */
export interface NextjsBlockEdge extends BlockEdge {
  declaredBy: DeclaredBy | null;
}

/** 이 어댑터의 블록 그래프. 코어 `BlockGraph`에 대입 가능하다 */
export interface NextjsBlockGraph extends BlockGraph {
  blocks: NextjsBlockNode[];
  edges: NextjsBlockEdge[];
  /** 외부 패키지 → 그것을 import하는 블록 ID. 미분류 파일의 import는 `'unclassified'` */
  externals: Record<string, string[]>;
  /** `reports/depcruise.json`을 재사용했으면 그 경로 (루트 기준). 직접 실행했으면 없음 */
  reusedReport?: string;
}

// ---------------------------------------------------------------------------
// dependency-cruiser JSON — 쓰는 필드만
// ---------------------------------------------------------------------------

export interface DepcruiseDependency {
  /** 해석된 경로 (루트 기준 상대. node_modules는 `../../node_modules/...`일 수 있다) */
  resolved: string;
  /** import 문에 적힌 지정자 (`@/domains/payment` · `./repo` · `@prisma/client`) */
  module: string;
  dependencyTypes?: string[];
  coreModule?: boolean;
  couldNotResolve?: boolean;
}

export interface DepcruiseModule {
  source: string;
  dependencies: DepcruiseDependency[];
  coreModule?: boolean;
  couldNotResolve?: boolean;
}

export interface DepcruiseJson {
  modules: DepcruiseModule[];
  summary?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 옵션
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** `depcruise`에 넘길 소스 디렉토리. 기본 `src` */
  srcDir?: string;
  /** dependency-cruiser 설정 파일. 기본 `.dependency-cruiser.cjs` */
  configFile?: string;
  /** #44의 `runStaticChecks`가 남긴 JSON. 소스보다 새것이면 다시 돌리지 않고 읽는다. 기본 `reports/depcruise.json` */
  reportPath?: string;
  /** `false`면 항상 직접 실행한다. 기본 `true` */
  reuseReport?: boolean;
  /** 현재 시각 (테스트용) */
  now?: () => Date;
}

const DEFAULTS = {
  srcDir: 'src',
  configFile: '.dependency-cruiser.cjs',
  reportPath: 'reports/depcruise.json',
} as const;

const TOOL_NAME = 'dependency-cruiser';

const INFRA_KINDS: readonly InfraKind[] = ['db', 'cache', 'queue', 'external-api'];

/** 클라이언트 패키지 → 인프라 종류 (어댑터 내장 표. `config.services[*].clientPackages`가 덧붙는다) */
const CLIENT_PACKAGES: Record<string, InfraKind> = {
  '@prisma/client': 'db',
  pg: 'db',
  postgres: 'db',
  mysql2: 'db',
  mongodb: 'db',
  mongoose: 'db',
  ioredis: 'cache',
  redis: 'cache',
  amqplib: 'queue',
  kafkajs: 'queue',
  bullmq: 'queue',
};

/** Prisma `provider` → 표시 이름 */
const PRISMA_PROVIDER_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  cockroachdb: 'CockroachDB',
};

// ---------------------------------------------------------------------------
// 1. 파일 → 블록
// ---------------------------------------------------------------------------

interface BlockSeed {
  id: string;
  kind: NextjsBlockNode['kind'];
  paths: string[];
  /** 명시 공개 진입점. `shared`면 모든 파일이 공개 */
  public: string[];
  declared: boolean;
  risk?: Risk;
  shared?: boolean;
  dependsOn: string[];
  match: (file: string) => boolean;
  files: string[];
}

/** 글롭 `src/domains/payment/**`의 글롭 문자 앞 디렉토리 → `src/domains/payment` */
function dirOfGlob(glob: string): string {
  const dir = glob.split(/[*?[{(]/, 1)[0] ?? '';
  return dir.replace(/\/+$/, '');
}

/**
 * 공개 진입점을 루트 기준 경로로. `config.blocks[id].public`의 기본값은 `['index.ts']`(블록 디렉토리 기준 파일 이름) —
 * `/`가 없는 항목은 각 `include` 글롭의 디렉토리에 붙이고, `/`가 있는 항목은 루트 기준 경로(글롭 가능)로 본다.
 */
export function resolvePublic(include: string[], publicEntries: string[] = ['index.ts']): string[] {
  const result: string[] = [];
  for (const entry of publicEntries) {
    if (entry.includes('/')) {
      result.push(entry);
      continue;
    }
    for (const glob of include) {
      const dir = dirOfGlob(glob);
      if (dir) result.push(`${dir}/${entry}`);
    }
  }
  return [...new Set(result)];
}

function seedFromConfig(id: string, cfg: BlockConfig): BlockSeed {
  return {
    id,
    kind: 'domain',
    paths: [...cfg.include],
    public: resolvePublic(cfg.include, cfg.public),
    declared: true,
    risk: cfg.risk,
    dependsOn: cfg.dependsOn ?? [],
    match: picomatch(cfg.include, { dot: true }),
    files: [],
  };
}

function seedDefault(id: string, kind: NextjsBlockNode['kind'], dir: string, shared = false): BlockSeed {
  const glob = `${dir}/**`;
  return {
    id,
    kind,
    paths: [glob],
    public: shared || kind === 'entry' ? [] : [`${dir}/index.ts`],
    declared: false,
    shared: shared || undefined,
    dependsOn: [],
    match: picomatch(glob, { dot: true }),
    files: [],
  };
}

/** 파일 분류기. 설정 블록을 먼저 만들고, 디렉토리 기본 규칙으로 발견한 블록은 뒤에 붙인다 */
export class BlockClassifier {
  readonly seeds = new Map<string, BlockSeed>();
  private readonly configOrder: string[] = [];
  private readonly ignore: (file: string) => boolean;

  constructor(readonly config: PlumbConfig) {
    for (const [id, cfg] of Object.entries(config.blocks ?? {})) {
      this.seeds.set(id, seedFromConfig(id, cfg));
      this.configOrder.push(id);
    }
    this.ignore = config.ignore?.length ? picomatch(config.ignore, { dot: true }) : () => false;
  }

  /** 글롭 매칭이 아니라 디렉토리 기본 규칙으로 블록을 찾았을 때, 그 블록이 없으면 만든다 */
  private ensure(id: string, make: () => BlockSeed): string {
    if (!this.seeds.has(id)) this.seeds.set(id, make());
    return id;
  }

  /** 블록 ID 또는 `null`(미분류) */
  blockOf(file: string): string | null {
    for (const id of this.configOrder) {
      const seed = this.seeds.get(id);
      if (seed?.match(file)) return id;
    }
    const domain = /^src\/domains\/([^/]+)\//.exec(file);
    if (domain?.[1]) {
      const d = domain[1];
      return this.ensure(d, () => seedDefault(d, 'domain', `src/domains/${d}`));
    }
    if (file.startsWith('src/app/')) return this.ensure('app', () => seedDefault('app', 'entry', 'src/app'));
    if (file.startsWith('src/lib/')) return this.ensure('lib', () => seedDefault('lib', 'domain', 'src/lib', true));
    return null;
  }

  isIgnored(file: string): boolean {
    return this.ignore(file);
  }

  /** `to` 블록의 공개 진입점인가 (`shared` 블록은 전부 공개) */
  isPublic(blockId: string, file: string): boolean {
    const seed = this.seeds.get(blockId);
    if (!seed) return false;
    if (seed.shared) return true;
    return seed.public.includes(file) || (seed.public.length > 0 && picomatch(seed.public, { dot: true })(file));
  }
}

// ---------------------------------------------------------------------------
// 2. 그래프 접기 (순수 함수 — fs 없음)
// ---------------------------------------------------------------------------

/** `next/server` → `next`, `@prisma/client/x` → `@prisma/client` */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}

function isExternal(path: string, dep?: DepcruiseDependency): boolean {
  if (dep?.dependencyTypes?.includes('npm')) return true;
  return /(^|\/)node_modules\//.test(path);
}

function isCore(dep: DepcruiseDependency): boolean {
  return dep.coreModule === true || dep.dependencyTypes?.includes('core') === true;
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

export interface FoldInput {
  config: PlumbConfig;
  depcruise: DepcruiseJson;
  /** `file`에서 `specifier`를 import하는 줄 번호. 못 찾으면 1 */
  lineOf: (file: string, specifier: string) => number;
}

export interface FoldResult {
  blocks: NextjsBlockNode[];
  edges: NextjsBlockEdge[];
  unclassified: string[];
  externals: Record<string, string[]>;
  /** (블록, 패키지) 쌍 — L0 간선의 원료 */
  packageImports: Array<{ block: string; pkg: string }>;
}

/** depcruise `modules[]`를 블록 노드 · 간선 · 미분류 · 외부 패키지로 접는다 */
export function foldModules({ config, depcruise, lineOf }: FoldInput): FoldResult {
  const classifier = new BlockClassifier(config);
  const unclassified = new Set<string>();
  const externals = new Map<string, Set<string>>();
  const packageImports = new Map<string, { block: string; pkg: string }>();
  const edges = new Map<string, NextjsBlockEdge>();

  // 1) 파일 → 블록 (파일 수 · 미분류)
  const assignment = new Map<string, string | null>();
  for (const mod of depcruise.modules) {
    const file = toPosix(mod.source);
    if (mod.coreModule || mod.couldNotResolve || isExternal(file)) continue;
    const block = classifier.blockOf(file);
    assignment.set(file, block);
    if (block) classifier.seeds.get(block)?.files.push(file);
    else if (!classifier.isIgnored(file)) unclassified.add(file);
  }

  // 2) 의존 → 간선 · 외부 패키지
  for (const mod of depcruise.modules) {
    const from = toPosix(mod.source);
    if (!assignment.has(from)) continue;
    const fromBlock = assignment.get(from) ?? null;
    for (const dep of mod.dependencies) {
      const to = toPosix(dep.resolved);
      if (isCore(dep)) continue;
      if (isExternal(to, dep)) {
        const pkg = packageNameOf(dep.module);
        const owner = fromBlock ?? 'unclassified';
        if (!externals.has(pkg)) externals.set(pkg, new Set());
        externals.get(pkg)?.add(owner);
        if (fromBlock) packageImports.set(`${fromBlock}\u0000${pkg}`, { block: fromBlock, pkg });
        continue;
      }
      if (dep.couldNotResolve || !fromBlock) continue;
      const toBlock = assignment.has(to) ? (assignment.get(to) ?? null) : classifier.blockOf(to);
      if (!toBlock || toBlock === fromBlock) continue;

      const key = `${fromBlock}\u0000${toBlock}`;
      let edge = edges.get(key);
      if (!edge) {
        const declaredBy = declaredByOf(classifier, fromBlock, toBlock);
        edge = { from: fromBlock, to: toBlock, count: 0, declared: declaredBy !== null, declaredBy, imports: [] };
        edges.set(key, edge);
      }
      const site: ImportSite = {
        file: from,
        line: lineOf(from, dep.module),
        specifier: dep.module,
        viaPublic: classifier.isPublic(toBlock, to),
      };
      edge.imports.push(site);
      edge.count += 1;
    }
  }

  const blocks: NextjsBlockNode[] = [...classifier.seeds.values()].map((seed) => {
    const files = [...new Set(seed.files)].sort();
    const node: NextjsBlockNode = {
      id: seed.id,
      level: 'L1',
      kind: seed.kind,
      paths: seed.paths,
      public: seed.shared ? files : seed.public,
      files: files.length,
      declared: seed.declared,
    };
    if (seed.risk) node.risk = seed.risk;
    if (seed.shared) node.shared = true;
    return node;
  });

  const sortedEdges = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const edge of sortedEdges) {
    edge.imports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  const externalsRecord: Record<string, string[]> = {};
  for (const pkg of [...externals.keys()].sort()) {
    externalsRecord[pkg] = [...(externals.get(pkg) ?? [])].sort();
  }

  return {
    blocks,
    edges: sortedEdges,
    unclassified: [...unclassified].sort(),
    externals: externalsRecord,
    packageImports: [...packageImports.values()].sort(
      (a, b) => a.block.localeCompare(b.block) || a.pkg.localeCompare(b.pkg),
    ),
  };
}

function declaredByOf(classifier: BlockClassifier, from: string, to: string): DeclaredBy | null {
  const fromSeed = classifier.seeds.get(from);
  const toSeed = classifier.seeds.get(to);
  if (fromSeed?.dependsOn.includes(to)) return 'config';
  if (fromSeed?.kind === 'entry') return 'entry';
  if (toSeed?.shared) return 'shared';
  return null;
}

// ---------------------------------------------------------------------------
// 3. L0 — 설정·인프라 파일에서 감지된 것만
// ---------------------------------------------------------------------------

export interface L0Input {
  /** `prisma/schema.prisma` 본문. 파일이 없으면 생략 */
  prisma?: { path: string; text: string };
  /** `docker-compose.yml` 본문. 파일이 없으면 생략 */
  compose?: { path: string; text: string };
}

export interface L0Result {
  nodes: NextjsBlockNode[];
  undetectedInfra: InfraKind[];
}

function evidenceAt(file: string, line: number, excerpt: string): Evidence {
  return { anchor: { file, line }, excerpt: excerpt.trim(), source: 'parser' };
}

/** `datasource db { provider = "postgresql" url = env("DATABASE_URL") }` → L0 `db` 노드 */
function detectPrisma(prisma: { path: string; text: string }): NextjsBlockNode | null {
  const lines = prisma.text.split(/\r?\n/);
  let inDatasource = false;
  let depth = 0;
  let provider: { value: string; line: number } | undefined;
  let envVar: { name: string; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!inDatasource) {
      if (/^\s*datasource\s+\w+\s*\{/.test(line)) {
        inDatasource = true;
        depth = 1;
      }
      continue;
    }
    const prov = /^\s*provider\s*=\s*"([^"]+)"/.exec(line);
    if (prov?.[1] && !provider) provider = { value: prov[1], line: i + 1 };
    const env = /^\s*url\s*=\s*env\("([^"]+)"\)/.exec(line);
    if (env?.[1] && !envVar) envVar = { name: env[1], line: i + 1 };
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) break;
  }
  if (!provider) return null;
  const node: NextjsBlockNode = {
    id: 'db',
    level: 'L0',
    kind: 'db',
    paths: [],
    public: [],
    files: 0,
    declared: false,
    label: PRISMA_PROVIDER_LABELS[provider.value] ?? provider.value,
    evidence: [evidenceAt(prisma.path, provider.line, lines[provider.line - 1] ?? '')],
  };
  if (envVar) {
    node.envVars = [envVar.name];
    node.evidence?.push(evidenceAt(prisma.path, envVar.line, `url = env("${envVar.name}")`));
  }
  return node;
}

/** compose `image:` → 인프라 종류. 알려진 이미지가 아니면 `external-api` */
export function infraKindOfImage(image: string): InfraKind {
  const name = image.split('/').pop()?.split(':')[0]?.toLowerCase() ?? '';
  if (/^(postgres|postgis|timescale|mysql|mariadb|mongo|cockroach|mssql|percona)/.test(name)) return 'db';
  if (/^(redis|valkey|memcached|keydb)/.test(name)) return 'cache';
  if (/^(rabbitmq|kafka|redpanda|nats|activemq|zookeeper)/.test(name)) return 'queue';
  return 'external-api';
}

interface ComposeService {
  name: string;
  image: string;
  line: number;
}

/** `services:` 아래 2단 들여쓰기의 서비스 이름과 그 `image:`만 읽는다 (YAML 전체 파서 없이) */
export function parseComposeServices(text: string): ComposeService[] {
  const lines = text.split(/\r?\n/);
  const services: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services\s*:/.test(line);
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      const name = /^\s{2}([\w.-]+)\s*:/.exec(line)?.[1];
      current = name ? { name, image: '', line: i + 1 } : null;
      if (current) services.push(current);
      continue;
    }
    if (current && indent > 2 && !current.image) {
      const image = /^\s+image\s*:\s*["']?([^"'\s]+)["']?/.exec(line)?.[1];
      if (image) {
        current.image = image;
        current.line = i + 1;
      }
    }
  }
  return services.filter((s) => s.image);
}

/** L0 노드 집합. DB는 Prisma와 compose 근거를 하나로 합친다 (view-architecture 3절 "두 근거가 모두 있으면 하나로") */
export function detectL0(input: L0Input): L0Result {
  const nodes: NextjsBlockNode[] = [];
  const db = input.prisma ? detectPrisma(input.prisma) : null;
  if (db) nodes.push(db);

  if (input.compose) {
    for (const service of parseComposeServices(input.compose.text)) {
      const kind = infraKindOfImage(service.image);
      const label = service.image.split('/').pop()?.split(':')[0] ?? service.image;
      const evidence = evidenceAt(input.compose.path, service.line, `image: ${service.image}`);
      if (kind === 'db') {
        const existing = nodes.find((n) => n.kind === 'db');
        if (existing) {
          existing.evidence = [...(existing.evidence ?? []), evidence];
          continue;
        }
        nodes.push({
          id: 'db',
          level: 'L0',
          kind,
          paths: [],
          public: [],
          files: 0,
          declared: false,
          label,
          evidence: [evidence],
        });
        continue;
      }
      const id = nodes.some((n) => n.id === service.name) ? `${service.name}-${kind}` : service.name;
      nodes.push({
        id,
        level: 'L0',
        kind,
        paths: [],
        public: [],
        files: 0,
        declared: false,
        label,
        evidence: [evidence],
      });
    }
  }

  const undetectedInfra = INFRA_KINDS.filter((kind) => !nodes.some((n) => n.kind === kind));
  return { nodes, undetectedInfra };
}

/** (블록, 클라이언트 패키지) → L0 간선. 대상 종류의 노드가 감지되지 않았으면 간선도 만들지 않는다 (추정 금지) */
export function infraEdgesOf(
  packageImports: Array<{ block: string; pkg: string }>,
  l0: NextjsBlockNode[],
  config: PlumbConfig,
): InfraEdge[] {
  const table: Record<string, InfraKind> = { ...CLIENT_PACKAGES };
  for (const service of Object.values(config.services ?? {})) {
    for (const pkg of service.clientPackages) table[pkg] = service.kind;
  }
  const edges: InfraEdge[] = [];
  for (const { block, pkg } of packageImports) {
    const kind = table[pkg];
    if (!kind) continue;
    const target = l0.find((n) => n.kind === kind);
    if (!target) continue;
    edges.push({ from: block, to: target.id, via: { kind: 'package', name: pkg }, blocks: [block] });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// 4. 입력 — depcruise 실행 또는 #44 보고서 재사용
// ---------------------------------------------------------------------------

async function newestMtime(path: string): Promise<number> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    newest = Math.max(newest, await newestMtime(join(path, entry.name)));
  }
  return newest;
}

/** 보고서가 소스(`srcDir/**`) · depcruise 설정 · `tsconfig.json` · `package.json`보다 새것인가 */
export async function isReportFresh(
  root: string,
  reportPath: string,
  srcDir: string,
  configFile: string,
): Promise<boolean> {
  const report = join(root, reportPath);
  if (!existsSync(report)) return false;
  const reportMtime = (await stat(report)).mtimeMs;
  const inputs = [join(root, srcDir), join(root, configFile), join(root, 'tsconfig.json'), join(root, 'package.json')];
  for (const input of inputs) {
    if ((await newestMtime(input)) > reportMtime) return false;
  }
  return true;
}

function isDepcruiseJson(value: unknown): value is DepcruiseJson {
  return typeof value === 'object' && value !== null && Array.isArray((value as { modules?: unknown }).modules);
}

interface Spawned {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(command: string, args: string[], cwd: string): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}

/** `node_modules/.bin/depcruise <src> --config <file> --output-type json` (셸 없이, `cwd: root`). 위반이 있어도 JSON은 나온다 */
async function runDepcruise(root: string, srcDir: string, configFile: string): Promise<DepcruiseJson> {
  const bin = join(root, 'node_modules', '.bin', 'depcruise');
  if (!existsSync(bin)) {
    throw new Error(`dependency-cruiser가 대상에 설치되어 있지 않다: ${bin}`);
  }
  const result = await run(bin, [srcDir, '--config', configFile, '--output-type', 'json'], root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    const tail = result.stderr.split('\n').filter(Boolean).slice(-20).join('\n');
    throw new Error(`dependency-cruiser 출력이 JSON이 아니다 (exit ${result.exitCode}):\n${tail}`);
  }
  if (!isDepcruiseJson(parsed)) {
    throw new Error(`dependency-cruiser JSON에 modules[]가 없다 (exit ${result.exitCode})`);
  }
  return parsed;
}

async function readReport(root: string, reportPath: string): Promise<DepcruiseJson | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, reportPath), 'utf8'));
    return isDepcruiseJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 대상에 설치된 dependency-cruiser 버전 (`node_modules/dependency-cruiser/package.json`). 못 찾으면 `unknown` */
export function depcruiseVersion(root: string): string {
  try {
    const text = readFileSync(join(root, 'node_modules', 'dependency-cruiser', 'package.json'), 'utf8');
    const pkg = JSON.parse(text) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function gitHead(root: string): Promise<string | undefined> {
  try {
    const result = await run('git', ['rev-parse', 'HEAD'], root);
    const sha = result.stdout.trim();
    return result.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function readIfExists(root: string, rel: string): Promise<{ path: string; text: string } | undefined> {
  const abs = join(root, rel);
  if (!existsSync(abs)) return undefined;
  return { path: rel, text: await readFile(abs, 'utf8') };
}

/** `file` 안에서 `specifier`를 따옴표로 감싼 첫 줄. 파일을 한 번만 읽는다 */
function makeLineFinder(root: string): (file: string, specifier: string) => number {
  const cache = new Map<string, string[]>();
  return (file, specifier) => {
    if (file.startsWith('../')) return 1;
    let lines = cache.get(file);
    if (!lines) {
      try {
        // 동기 읽기 — 간선이 있는 파일만, 루트 안만 읽는다
        lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
      } catch {
        lines = [];
      }
      cache.set(file, lines);
    }
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`['"\`]${escaped}['"\`]`);
    const idx = lines.findIndex((l) => re.test(l));
    return idx === -1 ? 1 : idx + 1;
  };
}

// ---------------------------------------------------------------------------
// 5. 진입점
// ---------------------------------------------------------------------------

/**
 * 의존성 추출 → 블록 그래프. `ctx.root` 밖은 읽지 않는다.
 * 실패(도구 없음 · 출력이 JSON이 아님)는 예외 — "이전 성공 결과를 대신 돌려주지" 않는다 (`ArchitectureView.extractionError`는 코어가).
 */
export async function extractDependencies(
  ctx: AdapterContext,
  options: ExtractOptions = {},
): Promise<NextjsBlockGraph> {
  const { root, config } = ctx;
  const srcDir = options.srcDir ?? DEFAULTS.srcDir;
  const configFile = options.configFile ?? DEFAULTS.configFile;
  const reportPath = options.reportPath ?? DEFAULTS.reportPath;
  const now = options.now ?? (() => new Date());

  let depcruise: DepcruiseJson | null = null;
  let reusedReport: string | undefined;
  if (options.reuseReport !== false && (await isReportFresh(root, reportPath, srcDir, configFile))) {
    depcruise = await readReport(root, reportPath);
    if (depcruise) reusedReport = reportPath;
  }
  if (!depcruise) depcruise = await runDepcruise(root, srcDir, configFile);

  const folded = foldModules({ config, depcruise, lineOf: makeLineFinder(root) });

  const composePath = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((p) =>
    existsSync(join(root, p)),
  );
  const l0 = detectL0({
    prisma: await readIfExists(root, config.contracts?.prisma ?? 'prisma/schema.prisma'),
    compose: composePath ? await readIfExists(root, composePath) : undefined,
  });

  const tool: ToolInfo = { name: TOOL_NAME, version: depcruiseVersion(root) };
  const commit = await gitHead(root);

  const graph: NextjsBlockGraph = {
    generatedAt: now().toISOString(),
    ...(commit ? { commit } : {}),
    tool,
    blocks: [...folded.blocks, ...l0.nodes],
    edges: folded.edges,
    infraEdges: infraEdgesOf(folded.packageImports, l0.nodes, config),
    undetectedInfra: l0.undetectedInfra,
    unclassified: folded.unclassified,
    externals: folded.externals,
    ...(reusedReport ? { reusedReport } : {}),
  };
  return graph;
}
