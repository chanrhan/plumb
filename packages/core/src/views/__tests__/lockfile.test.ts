/**
 * pnpm lockfile 파서 (#56). 1) 레포 루트의 **실제** `pnpm-lock.yaml`에서 `importers['examples/testbed']`를 읽는다 —
 * testbed는 모노레포 안이라 자기 lockfile이 없고 위로 올라가 찾아야 한다. 2) 가짜 lockfile 문자열로 도달 가능성 · 줄 번호 ·
 * npm/yarn unsupported · 파일 없음 missing을 확인한다.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findLockfile,
  LockfileParseError,
  parsePnpmLock,
  reachableFrom,
  splitSnapshotKey,
  stripPeerSuffix,
  transitiveCountOf,
  UnsupportedLockfileError,
} from '../lockfile.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const TESTBED = join(REPO_ROOT, 'examples', 'testbed');

/** 최소 v9 lockfile: a(prod) → b → c, d(dev) → c, e는 아무도 안 쓴다 */
const FAKE_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0(peer@2.0.0)
      '@scope/local':
        specifier: workspace:*
        version: link:../local
    devDependencies:
      d:
        specifier: ^4
        version: 4.1.0

packages:

  a@1.0.0:
    resolution: {integrity: sha512-x}

snapshots:

  a@1.0.0(peer@2.0.0):
    dependencies:
      b: 2.0.0
    optionalDependencies:
      peer: 2.0.0

  b@2.0.0:
    dependencies:
      c: 3.0.0

  c@3.0.0: {}

  d@4.1.0:
    dependencies:
      c: 3.0.0

  e@5.0.0: {}

  peer@2.0.0: {}
`;

describe('findLockfile — 모노레포: 위로 올라가 workspace 루트 lockfile을 찾는다', () => {
  it('examples/testbed → 루트 pnpm-lock.yaml + importers["examples/testbed"]', async () => {
    const location = await findLockfile(TESTBED);
    expect(location).toEqual({
      status: 'found',
      format: 'pnpm',
      path: join(REPO_ROOT, 'pnpm-lock.yaml'),
      importerKey: 'examples/testbed',
      workspaceRoot: REPO_ROOT,
    });
  });

  it('레포 루트 자체는 importerKey "."', async () => {
    const location = await findLockfile(REPO_ROOT);
    expect(location).toMatchObject({ status: 'found', importerKey: '.', path: join(REPO_ROOT, 'pnpm-lock.yaml') });
  });
});

describe('parsePnpmLock — 실제 lockfile, importers["examples/testbed"]', () => {
  it('next · @prisma/client는 prod 직접, vitest · prisma는 dev 직접, 간접 > 0', async () => {
    const text = await readFile(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    const lock = parsePnpmLock(text, 'examples/testbed');

    expect(lock.version).toBe('9.0');
    expect(lock.importerKey).toBe('examples/testbed');
    expect(lock.direct.next).toMatchObject({ scope: 'prod', specifier: '^15' });
    expect(lock.direct.next?.version).toMatch(/^15\.\d+\.\d+$/);
    expect(lock.direct.next?.snapshotKey?.startsWith('next@15.')).toBe(true);
    expect(lock.direct['@prisma/client']).toMatchObject({ scope: 'prod', specifier: '^6' });
    expect(lock.direct['@prisma/client']?.version).toMatch(/^6\.\d+\.\d+$/);
    expect(lock.direct.vitest).toMatchObject({ scope: 'dev', specifier: '^3.2.7' });
    expect(lock.direct.prisma).toMatchObject({ scope: 'dev' });
    // 피어 접미사는 뗀다
    for (const entry of Object.values(lock.direct)) expect(entry.version).not.toContain('(');
    // 직접 의존의 줄 번호는 lockfile 안의 그 키 줄이다
    const lines = text.split('\n');
    expect(lines[(lock.direct.next?.line ?? 0) - 1]?.trim()).toBe('next:');
    expect(lines[(lock.direct['@prisma/client']?.line ?? 0) - 1]?.trim()).toBe("'@prisma/client':");

    expect(lock.transitive.length).toBeGreaterThan(0);
    expect(lock.transitive.some((key) => key.startsWith('@next/env@'))).toBe(true);
    // 직접 의존은 간접 목록에 없다
    for (const entry of Object.values(lock.direct)) {
      if (entry.snapshotKey) expect(lock.transitive).not.toContain(entry.snapshotKey);
    }
    expect(transitiveCountOf(lock.direct.next?.snapshotKey, lock.packages)).toBeGreaterThan(0);
  });

  it('없는 importer 키는 LockfileParseError', async () => {
    const text = await readFile(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(() => parsePnpmLock(text, 'examples/does-not-exist')).toThrow(LockfileParseError);
  });
});

describe('parsePnpmLock — 가짜 lockfile', () => {
  it('직접 · scope · 줄 번호 · link: 의존은 스냅샷 키 없음', () => {
    const lock = parsePnpmLock(FAKE_LOCK, '.');
    expect(Object.keys(lock.direct)).toEqual(['@scope/local', 'a', 'd']);
    expect(lock.direct.a).toEqual({
      specifier: '^1.0.0',
      version: '1.0.0',
      snapshotKey: 'a@1.0.0(peer@2.0.0)',
      scope: 'prod',
      line: 10,
    });
    expect(lock.direct.d).toMatchObject({ scope: 'dev', version: '4.1.0', snapshotKey: 'd@4.1.0' });
    expect(lock.direct['@scope/local']).toMatchObject({ version: 'link:../local' });
    expect(lock.direct['@scope/local']?.snapshotKey).toBeUndefined();
  });

  it('간접 = 직접에서 도달 가능한 스냅샷 키 집합 (깊이 제한 없음, 중복 없음, 미도달 e 제외)', () => {
    const lock = parsePnpmLock(FAKE_LOCK, '.');
    expect(lock.transitive).toEqual(['b@2.0.0', 'c@3.0.0', 'peer@2.0.0']);
    expect(transitiveCountOf('a@1.0.0(peer@2.0.0)', lock.packages)).toBe(3);
    expect(transitiveCountOf('d@4.1.0', lock.packages)).toBe(1);
    expect(transitiveCountOf(undefined, lock.packages)).toBe(0);
    expect([...reachableFrom(['nope@0.0.0'], lock.packages)]).toEqual(['nope@0.0.0']);
    expect(lock.packages['b@2.0.0']).toMatchObject({ name: 'b', version: '2.0.0', deps: { c: 'c@3.0.0' } });
  });

  it('lockfileVersion 6(pnpm 8)은 UnsupportedLockfileError', () => {
    const v6 = FAKE_LOCK.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'");
    expect(() => parsePnpmLock(v6, '.')).toThrow(UnsupportedLockfileError);
    try {
      parsePnpmLock(v6, '.', '/x/pnpm-lock.yaml');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedLockfileError);
      expect((error as UnsupportedLockfileError).format).toBe('pnpm lockfile v6.0');
      expect((error as UnsupportedLockfileError).path).toBe('/x/pnpm-lock.yaml');
    }
  });

  it('헬퍼: 피어 접미사 · 스냅샷 키 분리', () => {
    expect(stripPeerSuffix('6.19.3(prisma@6.19.3(typescript@5.9.3))')).toBe('6.19.3');
    expect(stripPeerSuffix('19.3.0')).toBe('19.3.0');
    expect(splitSnapshotKey('@prisma/client@6.19.3(prisma@6.19.3)')).toEqual({
      name: '@prisma/client',
      version: '6.19.3(prisma@6.19.3)',
    });
    expect(splitSnapshotKey('next@15.5.27')).toEqual({ name: 'next', version: '15.5.27' });
  });
});

describe('findLockfile — npm · yarn은 unsupported, 아무것도 없으면 missing', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'plumb-lockfile-'));
    dirs.push(dir);
    return dir;
  }

  it('package-lock.json → unsupported npm', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    expect(await findLockfile(root)).toEqual({
      status: 'unsupported',
      format: 'npm',
      path: join(root, 'package-lock.json'),
    });
  });

  it('yarn.lock → unsupported yarn', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(await findLockfile(root)).toEqual({ status: 'unsupported', format: 'yarn', path: join(root, 'yarn.lock') });
  });

  it('lockfile도 워크스페이스도 없으면 missing (tmp 위로 올라가도 pnpm-workspace.yaml이 없다)', async () => {
    const root = await tempRoot();
    expect(await findLockfile(root)).toEqual({ status: 'missing' });
  });

  it('자기 lockfile이 있으면 상위를 보지 않는다', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'pnpm-lock.yaml'), FAKE_LOCK);
    expect(await findLockfile(root)).toMatchObject({
      status: 'found',
      importerKey: '.',
      path: join(root, 'pnpm-lock.yaml'),
    });
  });
});
