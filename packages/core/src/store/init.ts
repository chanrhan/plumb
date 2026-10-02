/**
 * 저장소 초기화. 폴더를 만들고 빈 `rules.yaml`(`rules: []`)과 `meta.json`을 쓴다. 이미 있으면 그대로 둔다 (멱등).
 */

import { access, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { ValidationError } from './errors.js';
import { readJsonFile, sha256, writeFileAtomic, writeJsonAtomic } from './fs.js';
import { STORE_VERSION, type StorePaths, storeDirectories } from './paths.js';
import { serializeRulesDocument } from './rules.js';

/** `meta.json` — 저장소 버전 · 프로젝트 · 생성 시각 */
export interface StoreMeta {
  version: typeof STORE_VERSION;
  project: string;
  createdAt: string;
}

export const storeMetaSchema = z
  .object({
    version: z.literal(STORE_VERSION),
    project: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict() satisfies z.ZodType<StoreMeta, z.ZodTypeDef, unknown>;

/** `initStore`가 쓰는 빈 `rules.yaml` 텍스트. 승인 기록이 없을 때 `status()`가 이 해시와 비교한다 */
export const EMPTY_RULES_YAML = serializeRulesDocument([]);
export const EMPTY_RULES_HASH = sha256(EMPTY_RULES_YAML);

export interface InitStoreOptions {
  /** 생성 시각. 테스트가 바꾼다 */
  now?: () => Date;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 폴더 생성 + 빈 `rules.yaml` + `meta.json`. 있으면 건드리지 않는다. 돌려주는 값은 (기존 또는 새) meta */
export async function initStore(paths: StorePaths, options: InitStoreOptions = {}): Promise<StoreMeta> {
  for (const dir of storeDirectories(paths)) {
    await mkdir(dir, { recursive: true });
  }

  if (!(await exists(paths.rules))) {
    await writeFileAtomic(paths.rules, EMPTY_RULES_YAML);
  }

  if (await exists(paths.meta)) {
    return readStoreMeta(paths);
  }
  const meta: StoreMeta = {
    version: STORE_VERSION,
    project: paths.project,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await writeJsonAtomic(paths.meta, meta);
  return meta;
}

/** `meta.json`. `initStore` 뒤에만 부른다 — 없거나 모양이 다르면 {@link ValidationError} */
export async function readStoreMeta(paths: StorePaths): Promise<StoreMeta> {
  const raw = await readJsonFile(paths.meta);
  const result = storeMetaSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${paths.meta}: meta.json이 없거나 스키마에 맞지 않는다`, result.error.issues);
  }
  return result.data;
}
