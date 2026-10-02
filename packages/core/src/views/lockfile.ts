/**
 * pnpm lockfile 파서 (이슈 #56, view-dependencies 3절 "직접 패키지" · "간접 패키지").
 *
 * - {@link findLockfile}: 대상 루트의 `pnpm-lock.yaml`. 없으면 위로 올라가며 `pnpm-workspace.yaml`이 있는 워크스페이스 루트의
 *   lockfile을 찾고 `importers[<루트 상대 경로>]`를 쓴다 (testbed는 모노레포 안이라 자기 lockfile이 없다).
 *   `package-lock.json` · `yarn.lock`은 `unsupported`로 표시만 한다 — 빈 표를 그리지 않는다 (view-dependencies 5절)
 * - {@link parsePnpmLock}: lockfileVersion 9 형식. `importers[key].dependencies/devDependencies`가 직접 의존,
 *   `snapshots[<name@version(peers)>].dependencies/optionalDependencies`로 트리를 복원해 직접에서 **도달 가능한** 스냅샷 키의
 *   집합이 간접 의존이다 (깊이 제한 없음). lockfile 엔트리의 줄 번호는 YAML 노드 위치에서 읽는다 (`file:line` 점프)
 *
 * `package.json`만으로 버전을 추정하지 않는다 — specifier는 범위이지 버전이 아니다 (view-dependencies 5절).
 */

import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isMap, isScalar, LineCounter, type Node, parseDocument, type YAMLMap } from 'yaml';

export const PNPM_LOCKFILE = 'pnpm-lock.yaml';
export const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

/** 지원하는 lockfileVersion 주 버전. pnpm 9·10이 쓴다 (`'9.0'`) */
export const SUPPORTED_PNPM_LOCKFILE_MAJOR = 9;

/** lockfile 탐색 결과. `found`의 `path`는 절대 경로, `importerKey`는 `importers`의 키 (`'.'` 또는 워크스페이스 상대 경로) */
export type LockfileLocation =
  | { status: 'found'; format: 'pnpm'; path: string; importerKey: string; workspaceRoot: string }
  | { status: 'unsupported'; format: 'npm' | 'yarn'; path: string }
  | { status: 'missing' };

export interface LockfileDirectEntry {
  /** `package.json`에 적힌 범위 (`^6`) */
  specifier: string;
  /** 해석된 버전. 피어 접미사(`(react@19.3.0)`)를 뗀 것 (`6.19.3`) */
  version: string;
  /** 스냅샷 키 (`@prisma/client@6.19.3(prisma@6.19.3(typescript@5.9.3))(typescript@5.9.3)`). `link:` 의존은 없음 */
  snapshotKey?: string;
  scope: 'prod' | 'dev';
  /** lockfile 안의 줄 (1부터). `importers[key].dependencies.<name>` 키의 줄 */
  line: number;
}

export interface LockfileSnapshot {
  name: string;
  version: string;
  /** 의존 이름 → 스냅샷 키 (`link:`는 제외) */
  deps: Record<string, string>;
  line: number;
}

export interface ParsedPnpmLock {
  /** `lockfileVersion` 원문 (`'9.0'`) */
  version: string;
  importerKey: string;
  /** 직접 의존. 이름 순 */
  direct: Record<string, LockfileDirectEntry>;
  /** 스냅샷 키 → 메타. 전체 lockfile (워크스페이스 전체) */
  packages: Record<string, LockfileSnapshot>;
  /** 직접 의존에서 도달 가능한 스냅샷 키 중 직접이 아닌 것. 키 순 */
  transitive: string[];
}

export class LockfileParseError extends Error {
  override readonly name: string = 'LockfileParseError';
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** 지원하지 않는 lockfile 버전(pnpm 6·8 등). `unsupported` 표시의 재료 */
export class UnsupportedLockfileError extends LockfileParseError {
  override readonly name = 'UnsupportedLockfileError';
  constructor(
    readonly format: string,
    path?: string,
  ) {
    super(`지원하지 않는 lockfile: ${format}`, path);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/**
 * 대상 루트의 lockfile을 찾는다. 순서: `root/pnpm-lock.yaml` → `root/package-lock.json`·`yarn.lock`(unsupported) →
 * 상위 디렉토리 중 `pnpm-workspace.yaml`과 `pnpm-lock.yaml`이 함께 있는 곳(모노레포. `importerKey`는 그곳 기준 상대 경로) → missing.
 */
export async function findLockfile(root: string): Promise<LockfileLocation> {
  const absRoot = resolve(root);
  const own = join(absRoot, PNPM_LOCKFILE);
  if (await exists(own))
    return { status: 'found', format: 'pnpm', path: own, importerKey: '.', workspaceRoot: absRoot };

  const npm = join(absRoot, 'package-lock.json');
  if (await exists(npm)) return { status: 'unsupported', format: 'npm', path: npm };
  const yarn = join(absRoot, 'yarn.lock');
  if (await exists(yarn)) return { status: 'unsupported', format: 'yarn', path: yarn };

  let dir = dirname(absRoot);
  while (dir !== dirname(dir)) {
    const lock = join(dir, PNPM_LOCKFILE);
    if ((await exists(join(dir, PNPM_WORKSPACE_FILE))) && (await exists(lock))) {
      return {
        status: 'found',
        format: 'pnpm',
        path: lock,
        importerKey: toPosix(relative(dir, absRoot)),
        workspaceRoot: dir,
      };
    }
    dir = dirname(dir);
  }
  return { status: 'missing' };
}

// ---------------------------------------------------------------------------
// 파싱
// ---------------------------------------------------------------------------

/** `6.19.3(prisma@6.19.3(typescript@5.9.3))` → `6.19.3` */
export function stripPeerSuffix(version: string): string {
  const paren = version.indexOf('(');
  return paren === -1 ? version : version.slice(0, paren);
}

/** 스냅샷 키 `@scope/name@1.2.3(peer@x)` → `{ name, version }`. 이름의 `@`는 맨 앞에만 올 수 있다 */
export function splitSnapshotKey(key: string): { name: string; version: string } {
  const at = key.indexOf('@', 1);
  if (at === -1) return { name: key, version: '' };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function scalarString(node: unknown): string | undefined {
  if (isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  return undefined;
}

function lineOf(node: Node | null | undefined, counter: LineCounter): number {
  const offset = node?.range?.[0];
  return offset === undefined ? 0 : counter.linePos(offset).line;
}

/** `dependencies:` 맵 → 이름 → 스냅샷 키. `link:` · `file:` 등 스냅샷이 없는 참조는 뺀다 */
function depsOf(map: YAMLMap | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isMap(map)) return out;
  for (const pair of map.items) {
    const name = scalarString(pair.key);
    const version = scalarString(pair.value);
    if (name === undefined || version === undefined) continue;
    if (version.startsWith('link:') || version.startsWith('file:')) continue;
    out[name] = `${name}@${version}`;
  }
  return out;
}

/**
 * `pnpm-lock.yaml` 본문 → 직접 · 스냅샷 · 도달 가능한 간접 의존.
 * lockfileVersion이 9가 아니면 {@link UnsupportedLockfileError}, `importers[importerKey]`가 없으면 {@link LockfileParseError}.
 */
export function parsePnpmLock(text: string, importerKey = '.', path?: string): ParsedPnpmLock {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  if (doc.errors.length > 0) {
    throw new LockfileParseError(`pnpm-lock.yaml 파싱 실패: ${doc.errors[0]?.message ?? '알 수 없음'}`, path);
  }
  const rootMap = doc.contents;
  if (!isMap(rootMap)) throw new LockfileParseError('pnpm-lock.yaml 최상위가 맵이 아니다', path);

  const version = scalarString(rootMap.get('lockfileVersion', true));
  if (version === undefined) throw new UnsupportedLockfileError('lockfileVersion 없음', path);
  const major = Number.parseInt(version, 10);
  if (major !== SUPPORTED_PNPM_LOCKFILE_MAJOR) throw new UnsupportedLockfileError(`pnpm lockfile v${version}`, path);

  const importers = rootMap.get('importers', true);
  const importer = isMap(importers) ? importers.get(importerKey, true) : undefined;
  if (!isMap(importer)) {
    // `importers: { '.': {} }` 처럼 빈 맵(`{}`)은 isMap이지만 의존이 없다. 키 자체가 없으면 오류
    const hasKey = isMap(importers) && importers.has(importerKey);
    if (!hasKey) throw new LockfileParseError(`pnpm-lock.yaml에 importers['${importerKey}']가 없다`, path);
  }

  const direct: Record<string, LockfileDirectEntry> = {};
  const readScope = (field: 'dependencies' | 'devDependencies', scope: 'prod' | 'dev') => {
    const map = isMap(importer) ? importer.get(field, true) : undefined;
    if (!isMap(map)) return;
    for (const pair of map.items) {
      const name = scalarString(pair.key);
      if (name === undefined || !isMap(pair.value)) continue;
      const specifier = scalarString(pair.value.get('specifier', true)) ?? '';
      const resolved = scalarString(pair.value.get('version', true)) ?? '';
      const entry: LockfileDirectEntry = {
        specifier,
        version: stripPeerSuffix(resolved),
        scope,
        line: lineOf(pair.key as Node, counter),
      };
      if (!resolved.startsWith('link:') && !resolved.startsWith('file:') && resolved.length > 0)
        entry.snapshotKey = `${name}@${resolved}`;
      direct[name] = entry;
    }
  };
  readScope('dependencies', 'prod');
  readScope('devDependencies', 'dev');

  const packages: Record<string, LockfileSnapshot> = {};
  const snapshots = rootMap.get('snapshots', true);
  if (isMap(snapshots)) {
    for (const pair of snapshots.items) {
      const key = scalarString(pair.key);
      if (key === undefined) continue;
      const { name, version: snapVersion } = splitSnapshotKey(key);
      const body = isMap(pair.value) ? pair.value : undefined;
      packages[key] = {
        name,
        version: stripPeerSuffix(snapVersion),
        deps: {
          ...depsOf(body?.get('dependencies', true) as YAMLMap | undefined),
          ...depsOf(body?.get('optionalDependencies', true) as YAMLMap | undefined),
        },
        line: lineOf(pair.key as Node, counter),
      };
    }
  }

  const directKeys = new Set(
    Object.values(direct)
      .map((entry) => entry.snapshotKey)
      .filter((key): key is string => key !== undefined),
  );
  const reachable = reachableFrom([...directKeys], packages);
  const transitive = [...reachable].filter((key) => !directKeys.has(key)).sort();

  const sortedDirect: Record<string, LockfileDirectEntry> = {};
  for (const name of Object.keys(direct).sort()) sortedDirect[name] = direct[name] as LockfileDirectEntry;

  return { version, importerKey, direct: sortedDirect, packages, transitive };
}

/** 시작 키들에서 `deps`를 따라 도달 가능한 스냅샷 키 전체 (시작 키 포함). lockfile에 없는 키는 그 자리에서 멈춘다 */
export function reachableFrom(start: readonly string[], packages: Record<string, LockfileSnapshot>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = packages[key];
    if (snapshot === undefined) continue;
    for (const dep of Object.values(snapshot.deps)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/** 패키지 하나의 간접 의존 수 (자기 자신 제외) */
export function transitiveCountOf(snapshotKey: string | undefined, packages: Record<string, LockfileSnapshot>): number {
  if (snapshotKey === undefined) return 0;
  return Math.max(0, reachableFrom([snapshotKey], packages).size - 1);
}
