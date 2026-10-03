import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDeclarationStubs } from '../stubs.js';

describe('generateDeclarationStubs', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-stubs-'));
    await mkdir(join(dir, 'src', 'domains'), { recursive: true });
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          declaration: false,
          incremental: true,
        },
        include: ['src/**/*.ts'],
      }),
    );
    await writeFile(
      join(dir, 'src', 'domains', 'refund.ts'),
      'export interface RefundInput { paymentId: string; at: Date }\nexport function refund(input: RefundInput): boolean { return input.paymentId.length > 0 }\n',
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('noEmit · declaration:false · incremental 설정을 덮어쓰고 .d.ts만 낸다 — 본문은 없다', async () => {
    const out = join(dir, '.work', 'test-writer', 'stubs');
    const result = await generateDeclarationStubs({ serviceRoot: dir, outDir: out });
    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual(['src/domains/refund.d.ts']);
    const dts = await readFile(join(out, 'src', 'domains', 'refund.d.ts'), 'utf8');
    expect(dts).toContain('export declare function refund(input: RefundInput): boolean;');
    expect(dts).not.toContain('paymentId.length');
  }, 30_000);
});
