import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeContractPath, ValidationError } from '../index.js';
import { makeTempStore, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('store.contracts', () => {
  it('approve → contracts/<경로 slug>.json (원자적, 임시 파일 없음), get · list로 읽힌다', async () => {
    const record = await t.store.contracts.approve({
      path: 'prisma/schema.prisma',
      hash: HASH_A,
      commit: 'a1b2c3d4e5f6a7b8',
      decision: 'D-0001',
      by: 'cli:chanrhan',
    });
    expect(record).toEqual({
      path: 'prisma/schema.prisma',
      hash: HASH_A,
      approvedAt: '2026-10-02T09:00:02.000Z',
      commit: 'a1b2c3d4e5f6a7b8',
      decision: 'D-0001',
      by: 'cli:chanrhan',
    });

    expect(await readdir(t.store.paths.contractsDir)).toEqual(['prisma__schema.prisma.json']);
    const onDisk = JSON.parse(await readFile(t.store.paths.contract('prisma/schema.prisma'), 'utf8'));
    expect(onDisk).toEqual(record);

    expect(await t.store.contracts.get('prisma/schema.prisma')).toEqual(record);
    expect(await t.store.contracts.get('./prisma/schema.prisma')).toEqual(record);
    expect(await t.store.contracts.get('openapi.yaml')).toBeUndefined();
    expect(await t.store.contracts.list()).toEqual([record]);
  });

  it('같은 파일을 다시 승인하면 덮어쓴다 · list는 경로순 · decision 없으면 키 없음', async () => {
    await t.store.contracts.approve({ path: 'prisma/schema.prisma', hash: HASH_A, commit: 'c1', by: 'ui' });
    await t.store.contracts.approve({ path: './openapi.yaml', hash: HASH_A, commit: 'c1', by: 'ui' });
    const second = await t.store.contracts.approve({
      path: 'prisma/schema.prisma',
      hash: HASH_B,
      commit: 'c2',
      by: 'ui',
    });

    expect(second).not.toHaveProperty('decision');
    expect(second.approvedAt).toBe('2026-10-02T09:00:04.000Z');
    const list = await t.store.contracts.list();
    expect(list.map((r) => [r.path, r.hash, r.commit])).toEqual([
      ['openapi.yaml', HASH_A, 'c1'],
      ['prisma/schema.prisma', HASH_B, 'c2'],
    ]);
    expect(await readdir(t.store.paths.contractsDir)).toEqual(['openapi.yaml.json', 'prisma__schema.prisma.json']);
  });

  it('입력 검증: 해시 모양 · 빈 경로 · 결정 ID · 경로 이탈 → ValidationError, 파일은 안 생긴다', async () => {
    await expect(
      t.store.contracts.approve({ path: 'openapi.yaml', hash: 'deadbeef', commit: 'c1', by: 'ui' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.contracts.approve({ path: '', hash: HASH_A, commit: 'c1', by: 'ui' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      t.store.contracts.approve({
        path: 'openapi.yaml',
        hash: HASH_A,
        commit: 'c1',
        by: 'ui',
        decision: 'X-1' as `D-${string}`,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      t.store.contracts.approve({ path: '../outside.yaml', hash: HASH_A, commit: 'c1', by: 'ui' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(t.store.paths.contractsDir)).toEqual([]);
  });

  it('깨진 기록 파일은 읽을 때 ValidationError — 조용히 건너뛰지 않는다', async () => {
    await t.store.contracts.approve({ path: 'openapi.yaml', hash: HASH_A, commit: 'c1', by: 'ui' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(t.store.paths.contract('openapi.yaml'), JSON.stringify({ path: 'openapi.yaml', hash: 'x' }));
    await expect(t.store.contracts.get('openapi.yaml')).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.contracts.list()).rejects.toBeInstanceOf(ValidationError);
  });

  it('normalizeContractPath: ./ 와 역슬래시', () => {
    expect(normalizeContractPath('./openapi.yaml')).toBe('openapi.yaml');
    expect(normalizeContractPath('/openapi.yaml')).toBe('openapi.yaml');
    expect(normalizeContractPath('prisma\\schema.prisma')).toBe('prisma/schema.prisma');
  });
});
