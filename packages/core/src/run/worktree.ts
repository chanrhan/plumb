/**
 * 실행용 git worktree (이슈 #86, 기획안 §8.6 "역할별 worktree", `RunState.worktree`).
 * 역할은 원본이 아니라 `<work>/<runId>/repo/<서비스 상대경로>`에서 일한다 — 중단해도 테스트 파일과 구현이 거기 남고 원본은 깨끗하다.
 *
 * worktree에는 gitignore된 것이 없다. 테스트가 돌려면 `node_modules`(pnpm 심링크 구조 포함)와 `.env*`가 필요하므로
 *   · 원본의 `node_modules` 디렉토리들(깊이 ≤ 3, node_modules 안쪽 제외)을 같은 상대 경로에 **심링크**
 *   · 서비스 루트의 `.env*` 파일을 복사
 * 한다. 첫 슬라이스의 방법이다 — 어댑터별 준비 훅은 M10.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Worktree {
  /** 저장소 최상위의 worktree 경로 */
  repoRoot: string;
  /** 역할 cwd = worktree 안의 서비스 루트 */
  serviceRoot: string;
  /** 원본 HEAD */
  commit: string;
  /** 심링크한 node_modules 상대 경로들 (로그용) */
  linkedNodeModules: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export async function gitToplevel(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--show-toplevel']);
}

async function findNodeModules(root: string, depth: number, rel = ''): Promise<string[]> {
  if (depth < 0) return [];
  const here = join(root, rel);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(here, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === 'node_modules') {
      out.push(join(rel, e.name));
      continue;
    }
    if (e.name.startsWith('.') || e.name === 'dist') continue;
    out.push(...(await findNodeModules(root, depth - 1, join(rel, e.name))));
  }
  return out;
}

export interface CreateWorktreeInput {
  /** 원본 서비스 루트(절대) */
  serviceRoot: string;
  /** worktree를 만들 디렉토리(절대). 보통 `<work>/<runId>/repo` */
  dir: string;
  /** node_modules 탐색 깊이. 기본 3 */
  nodeModulesDepth?: number;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
  const origTop = await gitToplevel(input.serviceRoot);
  const relService = relative(origTop, resolve(input.serviceRoot));
  const commit = await git(origTop, ['rev-parse', 'HEAD']);
  await mkdir(dirname(input.dir), { recursive: true });
  await git(origTop, ['worktree', 'add', '--detach', input.dir, 'HEAD']);

  const linked: string[] = [];
  for (const nm of await findNodeModules(origTop, input.nodeModulesDepth ?? 3)) {
    const target = join(input.dir, nm);
    try {
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(origTop, nm), target, 'dir');
      linked.push(nm.split(sep).join('/'));
    } catch {
      /* 이미 있거나 만들 수 없음 — 건너뛴다 */
    }
  }
  const serviceRoot = relService === '' ? input.dir : join(input.dir, relService);
  try {
    for (const e of await readdir(resolve(input.serviceRoot))) {
      if (e.startsWith('.env')) await copyFile(join(input.serviceRoot, e), join(serviceRoot, e));
    }
  } catch {
    /* .env 없음 */
  }
  return { repoRoot: input.dir, serviceRoot, commit, linkedNodeModules: linked };
}

/** worktree 제거. 역할이 남긴 변경은 함께 사라지므로 **중단된 실행에는 부르지 않는다**(파일을 남겨야 한다) */
export async function removeWorktree(serviceRoot: string, wt: Pick<Worktree, 'repoRoot'>): Promise<void> {
  const origTop = await gitToplevel(serviceRoot);
  try {
    await git(origTop, ['worktree', 'remove', '--force', wt.repoRoot]);
  } catch {
    await rm(wt.repoRoot, { recursive: true, force: true });
    await git(origTop, ['worktree', 'prune']).catch(() => undefined);
  }
}

/** worktree 안의 변경 요약(`git status --short`). 비어 있으면 역할이 아무것도 바꾸지 않았다 */
export async function worktreeChanges(wt: Pick<Worktree, 'repoRoot'>): Promise<string[]> {
  // porcelain: 두 글자 상태 + 공백 + 경로 (`git status --short`는 앞 공백을 잘라 버릴 수 있다)
  // `git()`은 trim하므로 앞 공백(` M`)이 사라진다 — 여기서는 원문을 쓴다
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: wt.repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/\r$/, ''));
}

/** `worktreeChanges` 한 줄에서 경로만 (` M src/a.ts` · `?? b.ts` · `R  a -> b`는 새 이름) */
export function changedPath(line: string): string {
  const p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  return arrow >= 0 ? p.slice(arrow + 4) : p;
}

/**
 * 역할이 남긴 변경을 worktree 안에서 커밋한다 — 커밋은 하네스가 한다(implementer 프롬프트 "커밋은 하네스가"). 변경이 없으면 null.
 * ⑤ 위반 주입의 worktree는 이 HEAD에서 갈라진다(구현 + 인수 테스트 포함). `RunState.commits`의 원자료
 */
export async function commitWorktree(
  wt: Pick<Worktree, 'repoRoot'>,
  message: string,
): Promise<{ from: string; to: string } | null> {
  const from = await git(wt.repoRoot, ['rev-parse', 'HEAD']);
  if ((await worktreeChanges(wt)).length === 0) return null;
  await git(wt.repoRoot, ['add', '-A']);
  await git(wt.repoRoot, ['-c', 'user.name=plumb', '-c', 'user.email=plumb@localhost', 'commit', '-q', '-m', message]);
  const to = await git(wt.repoRoot, ['rev-parse', 'HEAD']);
  return { from, to };
}
