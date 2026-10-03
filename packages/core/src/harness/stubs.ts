/**
 * 타입 선언 스텁 (이슈 #76, 기획안 §8.2). test-writer는 `src/**`를 읽지 못하므로 구현의 **시그니처만** `.d.ts`로 본다.
 * 대상 서비스의 `tsc`로 `--declaration --emitDeclarationOnly`를 돌려 `.work/test-writer/stubs/`에 낸다.
 * 서비스 tsconfig의 `noEmit` · `declaration: false` · `incremental`은 CLI 플래그로 덮어쓴다.
 */

import { execFile } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StubsInput {
  /** 대상 서비스 루트 (tsconfig.json이 있는 곳) */
  serviceRoot: string;
  /** 출력 디렉토리. 보통 `.work/test-writer/stubs` */
  outDir: string;
  /** 기본 `tsconfig.json` */
  tsconfig?: string;
  /** 기본: 서비스의 `node_modules/typescript/bin/tsc`, 없으면 core가 가진 typescript */
  tscPath?: string;
}

export interface StubsResult {
  outDir: string;
  /** 생성된 `.d.ts` 상대 경로 (정렬) */
  files: string[];
  exitCode: number;
  /** tsc 진단. 타입 오류가 있어도 선언은 대부분 나온다 — 비어 있지 않으면 노트에 적는다 */
  diagnostics: string;
}

export async function resolveTsc(serviceRoot: string): Promise<string> {
  const local = join(serviceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    await access(local);
    return local;
  } catch {
    return createRequire(import.meta.url).resolve('typescript/bin/tsc');
  }
}

async function listDts(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listDts(p, base)));
    else if (entry.name.endsWith('.d.ts'))
      out.push(
        p
          .slice(base.length + 1)
          .split('\\')
          .join('/'),
      );
  }
  return out.sort();
}

export async function generateDeclarationStubs(input: StubsInput): Promise<StubsResult> {
  const serviceRoot = resolve(input.serviceRoot);
  const outDir = resolve(input.outDir);
  await mkdir(outDir, { recursive: true });
  const tsc = input.tscPath ?? (await resolveTsc(serviceRoot));
  const args = [
    tsc,
    '-p',
    input.tsconfig ?? 'tsconfig.json',
    '--declaration',
    '--emitDeclarationOnly',
    '--noEmit',
    'false',
    '--incremental',
    'false',
    '--outDir',
    outDir,
    // 서비스 루트를 rootDir로 — 출력이 소스 배치를 그대로 비춘다 (`src/domains/x.ts` → `src/domains/x.d.ts`)
    '--rootDir',
    serviceRoot,
  ];
  let exitCode = 0;
  let diagnostics = '';
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: serviceRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    diagnostics = `${stdout}${stderr}`.trim();
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = typeof e.code === 'number' ? e.code : 1;
    diagnostics = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  }
  return { outDir, files: await listDts(outDir), exitCode, diagnostics };
}
