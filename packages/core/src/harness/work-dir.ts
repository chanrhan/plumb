/**
 * 역할 작업 디렉토리 `.work/<role>/` (기획안 §8.6, `PlumbConfig.work`). `resolveStoreRoot`와 같은 규칙:
 * `config.work`가 상대 경로면 대상 루트 기준, 없으면 `<루트>/.work`.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PlumbConfig, Role } from '../types/index.js';

export const DEFAULT_WORK_DIR = '.work';

export function resolveWorkRoot(config: Pick<PlumbConfig, 'work'>, targetRoot: string): string {
  const root = resolve(targetRoot);
  return config.work !== undefined && config.work.length > 0
    ? resolve(root, config.work)
    : join(root, DEFAULT_WORK_DIR);
}

export interface RoleWorkDir {
  dir: string;
  /** 이의 제기 파일 `.work/<role>/disputes/d-<id>.md` (타입 `Dispute.file`) */
  disputesDir: string;
}

export function roleWorkDir(workRoot: string, role: Role): RoleWorkDir {
  const dir = join(workRoot, role);
  return { dir, disputesDir: join(dir, 'disputes') };
}

export async function ensureRoleWorkDir(workRoot: string, role: Role): Promise<RoleWorkDir> {
  const paths = roleWorkDir(workRoot, role);
  await mkdir(paths.disputesDir, { recursive: true });
  return paths;
}
