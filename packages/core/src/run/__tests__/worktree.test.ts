/**
 * 병합 게이트 ① (이슈 #134, 결정 #122) — 임시 git 레포에서 `createRunBranch` · `listRunBranches` · `pruneRunBranches`.
 * worktree 생성 자체(`createWorktree`)는 실제 레포가 필요한 첫 슬라이스 검증(env/local)에 맡긴다.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunBranch, listRunBranches, pruneRunBranches, runBranchName } from '../worktree.js';

const exec = promisify(execFile);
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

async function sh(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec('git', [...ID, ...args], { cwd, env: { ...process.env, ...env } });
  return stdout.trim();
}

/** 파일 하나 바꿔 커밋하고 sha를 돌려준다. `date`가 있으면 committer 시각을 고정 */
async function commit(cwd: string, file: string, body: string, message: string, date?: string): Promise<string> {
  await writeFile(join(cwd, file), body);
  await sh(cwd, ['add', '-A']);
  const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {};
  await sh(cwd, ['commit', '-q', '-m', message], env);
  return sh(cwd, ['rev-parse', 'HEAD']);
}

describe('createRunBranch · listRunBranches · pruneRunBranches (임시 git 레포)', () => {
  let dir: string;
  let repo: string;
  let base: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-branch-'));
    repo = join(dir, 'repo');
    await exec('git', ['init', '-q', '-b', 'main', repo]);
    base = await commit(repo, 'a.txt', 'a\n', 'init');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('runBranchName: plumb/<run-id>', () => {
    expect(runBranchName('r-0005')).toBe('plumb/r-0005');
  });

  it('새 브랜치를 sha에 만들고, 이미 있으면 -f로 옮긴다 (같은 run-id 재실행)', async () => {
    // 역할 결과 커밋을 흉내: 다른 브랜치(detached worktree 대신)에서 커밋하고 main으로 돌아온다
    await sh(repo, ['checkout', '-q', '-b', 'work']);
    const first = await commit(repo, 'b.txt', 'b\n', '②③ 결과');
    await sh(repo, ['checkout', '-q', 'main']);

    const made = await createRunBranch(repo, 'plumb/r-0001', first);
    expect(made).toEqual({ name: 'plumb/r-0001', sha: first });
    expect(await sh(repo, ['rev-parse', 'refs/heads/plumb/r-0001'])).toBe(first);
    // main은 움직이지 않았다 — 자동 머지 없음
    expect(await sh(repo, ['rev-parse', 'main'])).toBe(base);

    await sh(repo, ['checkout', '-q', 'work']);
    const second = await commit(repo, 'b.txt', 'bb\n', '②③ 결과 2');
    await sh(repo, ['checkout', '-q', 'main']);
    const moved = await createRunBranch(repo, 'plumb/r-0001', second);
    expect(moved.sha).toBe(second);
    expect(await sh(repo, ['rev-parse', 'refs/heads/plumb/r-0001'])).toBe(second);
    expect(await sh(repo, ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).toBe('plumb/r-0001');
  });

  it('서비스 루트가 레포 하위 폴더여도 toplevel에서 만든다 · 없는 객체면 예외', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(repo, 'services', 'web'), { recursive: true });
    const made = await createRunBranch(join(repo, 'services', 'web'), 'plumb/r-0002', base);
    expect(made.sha).toBe(base);
    await expect(createRunBranch(repo, 'plumb/r-0003', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow();
    expect(await listRunBranches(repo)).toMatchObject([{ name: 'plumb/r-0002', sha: base, merged: true }]);
  });

  describe('prune', () => {
    let mergedSha: string;
    let unmergedSha: string;
    beforeEach(async () => {
      // plumb/r-0001: main의 조상(= 머지됨). plumb/r-0002: main에서 갈라진 커밋(머지 안 됨), 오래된 날짜
      mergedSha = base;
      await createRunBranch(repo, 'plumb/r-0001', mergedSha);
      await sh(repo, ['checkout', '-q', '-b', 'work']);
      unmergedSha = await commit(repo, 'c.txt', 'c\n', '②③ 결과', '2026-01-01T00:00:00Z');
      await sh(repo, ['checkout', '-q', 'main']);
      await createRunBranch(repo, 'plumb/r-0002', unmergedSha);
      // main이 앞으로 간다 — r-0001은 여전히 조상, r-0002는 여전히 갈라져 있다
      await commit(repo, 'a.txt', 'aa\n', 'main 전진');
    });

    it('listRunBranches: 이름 순 · merged 플래그 · committer 시각', async () => {
      const list = await listRunBranches(repo);
      expect(list.map((b) => [b.name, b.merged])).toEqual([
        ['plumb/r-0001', true],
        ['plumb/r-0002', false],
      ]);
      expect(list[1]?.committedAt.startsWith('2026-01-01T00:00:00')).toBe(true);
    });

    it('기본(옵션 없음) = 머지된 것만 지운다. 머지 안 된 브랜치는 남는다', async () => {
      const pruned = await pruneRunBranches({ serviceRoot: repo });
      expect(pruned).toMatchObject([{ name: 'plumb/r-0001', reason: 'merged', deleted: true }]);
      expect(await sh(repo, ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).toBe('plumb/r-0002');
    });

    it('dry-run: 목록만 내고 지우지 않는다', async () => {
      const pruned = await pruneRunBranches({ serviceRoot: repo, merged: true, dryRun: true });
      expect(pruned).toMatchObject([{ name: 'plumb/r-0001', reason: 'merged', deleted: false }]);
      expect((await sh(repo, ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).split('\n')).toEqual([
        'plumb/r-0001',
        'plumb/r-0002',
      ]);
    });

    it('older-than: 머지 여부와 무관하게 N일 지난 끝 커밋의 브랜치를 지운다. 머지된 것은 --merged를 같이 줘야 함께', async () => {
      const now = () => new Date('2026-10-06T00:00:00Z');
      const onlyOld = await pruneRunBranches({ serviceRoot: repo, olderThanDays: 30, dryRun: true, now });
      expect(onlyOld).toMatchObject([{ name: 'plumb/r-0002', reason: 'older-than' }]);
      const notOldEnough = await pruneRunBranches({ serviceRoot: repo, olderThanDays: 3650, dryRun: true, now });
      expect(notOldEnough).toEqual([]);
      const both = await pruneRunBranches({ serviceRoot: repo, merged: true, olderThanDays: 30, now });
      expect(both.map((b) => [b.name, b.reason, b.deleted])).toEqual([
        ['plumb/r-0001', 'merged', true],
        ['plumb/r-0002', 'older-than', true],
      ]);
      expect(await sh(repo, ['branch', '--list', 'plumb/*', '--format=%(refname:short)'])).toBe('');
      // 다른 브랜치(main · work)는 건드리지 않는다
      expect((await sh(repo, ['branch', '--format=%(refname:short)'])).split('\n').sort()).toEqual(['main', 'work']);
    });
  });
});
