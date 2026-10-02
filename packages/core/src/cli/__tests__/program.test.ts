import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ORDER,
  createProgram,
  NOT_IMPLEMENTED_EXIT_CODE,
  readPackageVersion,
  STUB_COMMANDS,
} from '../program.js';

const EXPECTED_COMMANDS = ['init', 'rule', 'approve', 'run', 'check', 'views', 'ui', 'open'];
/** M3(#32)에서 구현된 명령. 나머지는 자리 표시 */
const IMPLEMENTED = ['rule', 'approve'];
const STUBS = EXPECTED_COMMANDS.filter((name) => !IMPLEMENTED.includes(name));

/** 테스트용 프로그램. 종료 대신 기록하고, 출력은 버퍼에 모은다 */
function testProgram(options: { version?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const program = createProgram({
    version: options.version,
    exit: (code) => exits.push(code),
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
  })
    .exitOverride()
    .configureOutput({
      writeOut: (str) => out.push(str),
      writeErr: (str) => err.push(str),
    });
  return { program, out, err, exits };
}

describe('plumb --help', () => {
  it('하위 명령 여덟 개가 이 순서로 보인다', () => {
    expect([...COMMAND_ORDER]).toEqual(EXPECTED_COMMANDS);
    expect(STUB_COMMANDS.map((stub) => stub.name)).toEqual(STUBS);

    const { program } = testProgram();
    const help = program.helpInformation();

    for (const name of EXPECTED_COMMANDS) {
      expect(help).toMatch(new RegExp(`^ {2}${name}\\b`, 'm'));
    }
    const positions = EXPECTED_COMMANDS.map((name) => help.search(new RegExp(`^ {2}${name}\\b`, 'm')));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('전역 옵션 --target <dir>이 보인다', () => {
    const { program } = testProgram();
    expect(program.helpInformation()).toMatch(/^ {2}--target <dir>/m);
  });

  it('rule 아래에 list · show · propose · reject가 있다', () => {
    const { program } = testProgram();
    const rule = program.commands.find((c) => c.name() === 'rule');
    expect(rule?.commands.map((c) => c.name())).toEqual(['list', 'show', 'propose', 'reject']);
  });

  it('--help는 stdout에 쓰고 commander.helpDisplayed로 끝난다', async () => {
    const { program, out } = testProgram();

    const error = await program.parseAsync(['--help'], { from: 'user' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommanderError);
    expect((error as CommanderError).code).toBe('commander.helpDisplayed');
    expect((error as CommanderError).exitCode).toBe(0);
    expect(out.join('')).toContain('Usage: plumb');
  });
});

describe('plumb --version', () => {
  it('package.json의 version을 출력한다', async () => {
    const { program, out } = testProgram();

    const error = await program.parseAsync(['--version'], { from: 'user' }).catch((e: unknown) => e);

    expect((error as CommanderError).code).toBe('commander.version');
    expect(out.join('').trim()).toBe(readPackageVersion());
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('미구현 하위 명령', () => {
  it.each(STUBS)('plumb %s → stderr 한 줄 + exit 2', async (name) => {
    const { program, err, exits } = testProgram();

    await program.parseAsync([name], { from: 'user' });

    const stub = STUB_COMMANDS.find((s) => s.name === name);
    expect(err).toEqual([`plumb ${name}: 아직 구현되지 않음 (${stub?.milestone})\n`]);
    expect(exits).toEqual([NOT_IMPLEMENTED_EXIT_CODE]);
    expect(NOT_IMPLEMENTED_EXIT_CODE).toBe(2);
  });

  it('마일스톤 번호는 ROADMAP과 같다', () => {
    const byName = Object.fromEntries(STUB_COMMANDS.map((stub) => [stub.name, stub.milestone]));
    expect(byName).toEqual({
      init: 'M10',
      run: 'M6',
      check: 'M5',
      views: 'M8',
      ui: 'M3',
      open: 'M8',
    });
  });

  it('--target은 하위 명령 앞에서 전역 옵션으로 읽힌다', async () => {
    const { program, exits } = testProgram();

    await program.parseAsync(['--target', './service', 'check'], { from: 'user' });

    expect(program.opts().target).toBe('./service');
    expect(exits).toEqual([2]);
  });

  it('모르는 명령은 commander.unknownCommand', async () => {
    const { program } = testProgram();

    const error = await program.parseAsync(['deploy'], { from: 'user' }).catch((e: unknown) => e);

    expect((error as CommanderError).code).toBe('commander.unknownCommand');
  });
});
