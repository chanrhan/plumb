/**
 * `plumb open` (이슈 #60, README 2.2) — 이유 없음 exit 2(기록 없음) · IDE 명령 실패해도 `code-opens.jsonl`에 `failed`로 기록 ·
 * 템플릿 `{file}` `{line}` 치환 · `--view`가 있으면 머리말 커밋을 `viewCommit`에.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCommand, renderIdeCommand } from '../../ide/open.js';
import { openStore } from '../../store/index.js';
import type { CodeOpenRecord, View } from '../../types/index.js';
import { makeHeader } from '../../views/header.js';
import { parseOpenTarget } from '../commands/open.js';
import { createProgram } from '../program.js';

const ROLE = { model: 'default', maxTurns: 1, maxBudgetUsd: 0 };
const BASE_CONFIG = {
  service: '.',
  store: './.plumb-store',
  adapter: 'nextjs',
  roles: { 'test-writer': ROLE, implementer: ROLE, injector: ROLE, 'rule-drafter': ROLE },
  stopBlockLimit: 5,
};

/** 어디에도 없는 명령 — ENOENT */
const MISSING_IDE = 'plumb-no-such-ide-xyz --goto {file}:{line}';
/** 실제로 도는 명령: node가 인자만 받고 0으로 끝난다 */
const NODE_IDE = `${process.execPath} --eval 0 {file}:{line}`;

let dir: string;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-open-cli-'));
  clock = new Date('2026-10-02T09:00:00.000Z');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function writeConfig(ide: string | undefined): Promise<void> {
  await writeFile(
    join(dir, 'plumb.config.json'),
    JSON.stringify({ ...BASE_CONFIG, ...(ide === undefined ? {} : { ide }) }),
  );
}

function now(): Date {
  clock = new Date(clock.getTime() + 1000);
  return clock;
}

async function plumb(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const program = createProgram({
    exit: (code) => exits.push(code),
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    cwd: dir,
    env: {},
    now,
  })
    .exitOverride()
    .configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  await program.parseAsync(args, { from: 'user' });
  return { code: exits[0] ?? 0, stdout: out.join(''), stderr: err.join('') };
}

async function records(): Promise<CodeOpenRecord[]> {
  const text = await readFile(join(dir, '.plumb-store', 'code-opens.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CodeOpenRecord);
}

describe('템플릿 치환', () => {
  it('{file} {line}을 치환하고 셸 없이 argv로 나눈다', () => {
    expect(renderIdeCommand('code --goto {file}:{line}', { file: 'src/a.ts', line: 30 })).toEqual([
      'code',
      '--goto',
      'src/a.ts:30',
    ]);
    expect(renderIdeCommand('idea --line {line} {file}', { file: 'src/a.ts', line: 7 })).toEqual([
      'idea',
      '--line',
      '7',
      'src/a.ts',
    ]);
  });

  it('줄이 없으면 :{line} 꼬리와 {line} 토큰을 지운다', () => {
    expect(renderIdeCommand('code --goto {file}:{line}', { file: 'src/a.ts' })).toEqual(['code', '--goto', 'src/a.ts']);
    expect(renderIdeCommand('idea --line {line} {file}', { file: 'src/a.ts' })).toEqual(['idea', '--line', 'src/a.ts']);
    expect(formatCommand(['code', '--goto', 'my file.ts:1'])).toBe('code --goto "my file.ts:1"');
  });

  it('<file>:<line> 파싱 — 줄 없으면 전체가 파일', () => {
    expect(parseOpenTarget('src/domains/payment/payment.ts:30')).toEqual({
      file: 'src/domains/payment/payment.ts',
      line: 30,
    });
    expect(parseOpenTarget('src/a.ts')).toEqual({ file: 'src/a.ts' });
    expect(parseOpenTarget('C:\\x\\a.ts:12')).toEqual({ file: 'C:\\x\\a.ts', line: 12 });
    expect(parseOpenTarget('  ')).toBeNull();
  });
});

describe('plumb open', () => {
  it('--reason이 없으면 exit 2, 아무것도 기록하지 않는다 · 모르는 이유도 exit 2', async () => {
    await writeConfig(NODE_IDE);

    const noReason = await plumb('open', 'src/a.ts:30');
    expect(noReason.code).toBe(2);
    expect(noReason.stderr).toBe(
      'plumb open: --reason <view-error|missing-info|debugging-env> 이 필요하다 — 이유를 고르지 않으면 열리지 않는다\n',
    );

    const badReason = await plumb('open', 'src/a.ts:30', '--reason', 'curious');
    expect(badReason.code).toBe(2);

    const badView = await plumb('open', 'src/a.ts:30', '--reason', 'missing-info', '--view', 'nope');
    expect(badView.code).toBe(2);
    expect(badView.stderr).toContain('모르는 View 이름 "nope"');

    expect(await records()).toEqual([]);
  });

  it('IDE 명령이 없어도(ENOENT) 기록은 failed로 남고 exit 1', async () => {
    await writeConfig(MISSING_IDE);

    const result = await plumb(
      'open',
      'src/domains/payment/payment.ts:30',
      '--reason',
      'missing-info',
      '--note',
      '경계 확인',
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'plumb open: IDE를 열지 못함: plumb-no-such-ide-xyz --goto src/domains/payment/payment.ts:30',
    );
    expect(result.stdout).toContain('(result: failed)');

    const [record, ...rest] = await records();
    expect(rest).toEqual([]);
    expect(record).toEqual({
      // init()이 시계를 한 번 썼다 → :02
      at: '2026-10-02T09:00:02.000Z',
      item: 'src/domains/payment/payment.ts:30',
      file: 'src/domains/payment/payment.ts',
      line: 30,
      reason: 'missing-info',
      note: '경계 확인',
      result: {
        status: 'failed',
        command: 'plumb-no-such-ide-xyz --goto src/domains/payment/payment.ts:30',
        error: '명령을 찾을 수 없다: plumb-no-such-ide-xyz',
      },
    });
    // View 밖에서 불렀다 — view 키 없음
    expect(record).not.toHaveProperty('view');
  });

  it('명령이 0으로 끝나면 opened · 템플릿이 치환된 command · --view/--item/--json · viewCommit', async () => {
    await writeConfig(NODE_IDE);
    const store = openStore(BASE_CONFIG, dir);
    await store.init();
    const view = {
      header: makeHeader('verification', {
        commit: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
        now: new Date('2026-10-02T08:00:00.000Z'),
        sources: [],
      }),
    } as unknown as View;
    await store.views.write('verification', view, '# 검증');

    const result = await plumb(
      'open',
      'src/a.ts:30',
      '--reason',
      'view-error',
      '--view',
      'verification',
      '--item',
      'pay.refund-window',
      '--json',
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout) as { record: CodeOpenRecord; path: string };
    expect(body.path).toBe(join(dir, '.plumb-store', 'code-opens.jsonl'));
    expect(body.record).toMatchObject({
      view: 'verification',
      item: 'pay.refund-window',
      file: 'src/a.ts',
      line: 30,
      reason: 'view-error',
      viewCommit: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
      result: { status: 'opened', command: `${process.execPath} --eval 0 src/a.ts:30` },
    });
    expect(body.record).not.toHaveProperty('note');

    expect(await store.codeOpens.count('verification', '2026-10-02T08:00:00.000Z')).toBe(1);
    expect(await store.codeOpens.count('verification', '2026-10-02T10:00:00.000Z')).toBe(0);
    expect(await store.codeOpens.count('architecture')).toBe(0);
  });

  it('ide 설정이 없으면 기본 템플릿 code --goto — 이 환경에 code가 없으면 failed로 기록된다', async () => {
    await writeConfig(undefined);
    const result = await plumb('open', 'src/a.ts', '--reason', 'debugging-env');
    const [record] = await records();
    expect(record?.result.command).toBe('code --goto src/a.ts');
    expect(record).not.toHaveProperty('line');
    expect([0, 1]).toContain(result.code);
  });
});
