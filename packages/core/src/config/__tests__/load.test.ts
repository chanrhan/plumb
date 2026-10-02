import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_NAME,
  ConfigError,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
} from '../index.js';

/** 이전 작업공간의 설정 예시 (`git show 0274a13:plumb.config.json`) */
const VALID_CONFIG = {
  service: './service',
  store: './plumb-store',
  work: './.work',
  adapter: 'nextjs',
  node: '22',
  roles: {
    'test-writer': { model: 'model-a', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'model-a', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'model-a', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'model-a', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  diffSearch: { numRuns: 1000, seed: 20261001 },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(root: string, content: unknown): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, CONFIG_FILE_NAME);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

describe('loadConfig', () => {
  it('정상 파일: --target 폴더의 설정을 읽고 path · root를 돌려준다', async () => {
    const path = await writeConfig(dir, VALID_CONFIG);

    const loaded = await loadConfig({ target: dir });

    expect(loaded.path).toBe(path);
    expect(loaded.root).toBe(dir);
    expect(loaded.config.service).toBe('./service');
    expect(loaded.config.adapter).toBe('nextjs');
    expect(loaded.config.roles.implementer).toEqual({ model: 'model-a', maxTurns: 80, maxBudgetUsd: 5 });
    expect(loaded.config.diffSearch).toEqual({ numRuns: 1000, seed: 20261001 });
  });

  it('타입이 optional로 둔 필드에만 기본값을 채운다', async () => {
    const { work: _work, store: _store, ...withoutOptional } = VALID_CONFIG;
    await writeConfig(dir, withoutOptional);

    const { config } = await loadConfig({ target: dir });

    expect(config.work).toBe('./.work');
    expect(config.store).toBeUndefined();
    expect(config.checks).toEqual({ stability: 3 });
    expect(config.reviewQueue).toEqual({ maxUnconfirmed: 20, maxDays: 14 });
    expect(config.run).toBeUndefined();
  });

  it('상대 --target은 cwd 기준으로 푼다', async () => {
    await writeConfig(join(dir, 'repo'), VALID_CONFIG);

    const loaded = await loadConfig({ target: 'repo', cwd: dir });

    expect(loaded.root).toBe(join(dir, 'repo'));
  });

  it('필수 필드 누락 → ConfigValidationError, 메시지에 `경로: 메시지` 줄', async () => {
    const { roles: _roles, ...withoutRoles } = VALID_CONFIG;
    const path = await writeConfig(dir, { ...withoutRoles, stopBlockLimit: 'five' });

    const error = await loadConfig({ target: dir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toBeInstanceOf(ConfigError);
    const validation = error as ConfigValidationError;
    expect(validation.path).toBe(path);
    expect(validation.issues.map((issue) => issue.path.join('.')).sort()).toEqual(['roles', 'stopBlockLimit']);
    expect(validation.message).toContain(`${path}: 설정이 스키마에 맞지 않는다`);
    expect(validation.message).toMatch(/^ {2}roles: /m);
    expect(validation.message).toMatch(/^ {2}stopBlockLimit: /m);
  });

  it('알 수 없는 키 → 스키마 오류 (오타를 조용히 넘기지 않는다)', async () => {
    await writeConfig(dir, { ...VALID_CONFIG, stopBlokLimit: 5 });

    const error = await loadConfig({ target: dir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).message).toMatch(/^ {2}stopBlokLimit: /m);
  });

  it('JSON 파싱 오류 → ConfigParseError (스키마 오류와 다른 클래스)', async () => {
    const path = await writeConfig(dir, '{ "service": ');

    const error = await loadConfig({ target: dir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigParseError);
    expect(error).not.toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigParseError).path).toBe(path);
    expect((error as ConfigParseError).cause).toBeInstanceOf(SyntaxError);
  });

  it('--target 폴더가 없음 → ConfigNotFoundError', async () => {
    const missing = join(dir, 'no-such-dir');

    const error = await loadConfig({ target: missing }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigNotFoundError);
    expect((error as ConfigNotFoundError).message).toContain(missing);
    expect((error as ConfigNotFoundError).searched).toEqual([missing]);
  });

  it('--target 폴더는 있지만 설정 파일이 없음 → ConfigNotFoundError (위로 탐색하지 않는다)', async () => {
    await writeConfig(dir, VALID_CONFIG);
    const child = join(dir, 'child');
    await mkdir(child);

    const error = await loadConfig({ target: child }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigNotFoundError);
    expect((error as ConfigNotFoundError).message).toContain(CONFIG_FILE_NAME);
  });

  it('target 없음: cwd에서 위로 올라가며 첫 설정 파일을 찾고 그 폴더가 root', async () => {
    const path = await writeConfig(dir, VALID_CONFIG);
    const deep = join(dir, 'src', 'domains', 'pay');
    await mkdir(deep, { recursive: true });

    const loaded = await loadConfig({ cwd: deep });

    expect(loaded.path).toBe(path);
    expect(loaded.root).toBe(dir);
  });

  it('위로 탐색: 가장 가까운 파일이 이긴다', async () => {
    await writeConfig(dir, VALID_CONFIG);
    const nested = join(dir, 'nested');
    const nearer = await writeConfig(nested, { ...VALID_CONFIG, service: './nearer' });

    const loaded = await loadConfig({ cwd: join(nested, 'deeper-not-existing') });

    expect(loaded.path).toBe(nearer);
    expect(loaded.config.service).toBe('./nearer');
  });

  it('위로 탐색해도 없음 → ConfigNotFoundError, searched에 탐색 경로가 순서대로', async () => {
    const start = join(dir, 'a', 'b');
    await mkdir(start, { recursive: true });

    const error = await loadConfig({ cwd: start }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigNotFoundError);
    const notFound = error as ConfigNotFoundError;
    expect(notFound.searched.slice(0, 3)).toEqual([start, join(dir, 'a'), dir]);
    expect(notFound.message).toContain('--target');
  });
});
