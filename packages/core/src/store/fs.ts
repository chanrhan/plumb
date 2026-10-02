/**
 * 저장소 파일 입출력 공통. 모듈 내부용 — `store/index.ts`가 재export하지 않는다.
 *
 * - 파일 쓰기는 원자적이다: 같은 폴더에 임시 파일을 쓰고 `rename`한다. 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다
 * - jsonl은 `appendFile`로 한 줄씩 덧붙인다. 1인용 도구라 잠금은 없다 (screens/README 3.4)
 */

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/** 임시 파일에 쓴 뒤 rename. 실패하면 임시 파일을 지우고 다시 던진다 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 없으면 `undefined` */
export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

/** 없으면 빈 배열. 빈 줄은 건너뛴다 */
export async function readJsonLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** 폴더 안의 파일 이름(확장자 필터). 폴더가 없으면 빈 배열 */
export async function listFiles(dir: string, extension: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

/** 폴더 안의 하위 폴더 이름. 폴더가 없으면 빈 배열 */
export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

/** 키를 정렬한 JSON — 같은 내용이면 같은 해시 (제안 해시 · 409 판정) */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
