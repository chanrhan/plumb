/**
 * `plumb.config.json` 로더 (기획안 §4.5). 설정 파일이 있는 폴더가 대상 루트다.
 * 다른 위치에서 실행할 때는 `--target <dir>`로 그 폴더를 가리킨다. 없으면 cwd에서 위로 올라가며 찾는다.
 *
 * 오류는 세 종류로 나뉘며 각각 다른 클래스다 — 호출자(CLI, UI 서버)가 `instanceof`로 구분해 메시지와 종료 코드를 정한다.
 */

import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ZodIssue } from 'zod';
import { type ParsedPlumbConfig, plumbConfigSchema } from './schema.js';

export const CONFIG_FILE_NAME = 'plumb.config.json';

export interface LoadConfigOptions {
  /** 대상 루트. 상대 경로면 `cwd` 기준. 주어지면 이 폴더의 설정 파일만 본다 (위로 탐색하지 않는다) */
  target?: string;
  /** 탐색 시작점. 기본 `process.cwd()` */
  cwd?: string;
}

export interface LoadedConfig {
  config: ParsedPlumbConfig;
  /** 읽은 설정 파일의 절대 경로 */
  path: string;
  /** 설정 파일이 있는 폴더 = 대상 루트 */
  root: string;
}

/** 설정 오류의 공통 조상. `instanceof ConfigError`로 "설정 문제"를 한 번에 잡는다 */
export class ConfigError extends Error {
  override readonly name: string = 'ConfigError';
}

/** 설정 파일을 찾지 못했다. `--target` 폴더가 없거나, 탐색한 폴더 어디에도 파일이 없다 */
export class ConfigNotFoundError extends ConfigError {
  override readonly name = 'ConfigNotFoundError';
  constructor(
    message: string,
    /** 살펴본 폴더들. 위로 탐색했으면 시작점부터 루트까지 */
    readonly searched: readonly string[],
  ) {
    super(message);
  }
}

/** 파일은 있지만 JSON이 아니다 */
export class ConfigParseError extends ConfigError {
  override readonly name = 'ConfigParseError';
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`${path}: JSON을 읽을 수 없다 — ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** JSON은 맞지만 스키마에 어긋난다. 메시지에 위반 하나당 `경로: 메시지` 한 줄 */
export class ConfigValidationError extends ConfigError {
  override readonly name = 'ConfigValidationError';
  constructor(
    readonly path: string,
    readonly issues: readonly ZodIssue[],
  ) {
    super(`${path}: 설정이 스키마에 맞지 않는다\n${issues.map((issue) => `  ${formatIssue(issue)}`).join('\n')}`);
  }
}

/** zod issue 하나를 `경로: 메시지`로. 경로가 비면 `(루트)`. 알 수 없는 키는 그 키 이름을 경로로 쓴다 */
export function formatIssue(issue: ZodIssue): string {
  const path =
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key].join('.')).join(', ')
      : issue.path.join('.');
  return `${path || '(루트)'}: ${issue.message}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `target`이 있으면 그 폴더의 파일, 없으면 `cwd`에서 위로 올라가며 첫 파일. 못 찾으면 {@link ConfigNotFoundError} */
export async function findConfigFile(options: LoadConfigOptions = {}): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());

  if (options.target !== undefined) {
    const root = resolve(cwd, options.target);
    if (!(await exists(root))) {
      throw new ConfigNotFoundError(`--target 폴더가 없다: ${root}`, [root]);
    }
    const file = join(root, CONFIG_FILE_NAME);
    if (!(await exists(file))) {
      throw new ConfigNotFoundError(`${root}에 ${CONFIG_FILE_NAME}이 없다`, [root]);
    }
    return file;
  }

  const searched: string[] = [];
  let dir = cwd;
  for (;;) {
    searched.push(dir);
    const file = join(dir, CONFIG_FILE_NAME);
    if (await exists(file)) return file;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigNotFoundError(
    `${cwd}에서 위로 올라가며 ${CONFIG_FILE_NAME}을 찾지 못했다. 설정 파일이 있는 폴더에서 실행하거나 --target <dir>을 준다`,
    searched,
  );
}

/** 설정 파일 하나를 읽고 검증한다 */
export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(path, error);
  }
  const result = plumbConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(path, result.error.issues);
  }
  return { config: result.data, path, root: dirname(path) };
}

/** 찾기 + 읽기 + 검증. 오류는 {@link ConfigNotFoundError} · {@link ConfigParseError} · {@link ConfigValidationError} 중 하나 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const path = await findConfigFile(options);
  return loadConfigFile(path);
}
