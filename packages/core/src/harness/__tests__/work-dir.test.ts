import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORK_DIR, ensureRoleWorkDir, resolveWorkRoot, roleWorkDir } from '../work-dir.js';

describe('work-dir', () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('config.work가 없으면 <루트>/.work, 상대 경로면 루트 기준, 절대 경로면 그대로', () => {
    expect(resolveWorkRoot({}, '/svc')).toBe(join('/svc', DEFAULT_WORK_DIR));
    expect(resolveWorkRoot({ work: './tmp/work' }, '/svc')).toBe('/svc/tmp/work');
    expect(resolveWorkRoot({ work: '/abs/work' }, '/svc')).toBe('/abs/work');
  });

  it('역할 디렉토리와 disputes 하위를 만든다 (Dispute.file 경로)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'plumb-work-'));
    const paths = await ensureRoleWorkDir(tmp, 'implementer');
    expect(paths).toEqual(roleWorkDir(tmp, 'implementer'));
    expect(paths.disputesDir).toBe(join(tmp, 'implementer', 'disputes'));
    expect((await stat(paths.disputesDir)).isDirectory()).toBe(true);
    // 두 번 불러도 괜찮다
    await expect(ensureRoleWorkDir(tmp, 'implementer')).resolves.toEqual(paths);
  });
});
