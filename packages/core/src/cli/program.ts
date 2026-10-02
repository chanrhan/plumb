/**
 * `plumb` 명령 트리 (기획안 §4.3). 진입점 `index.ts`와 분리해 테스트가 `exitOverride()`로 파싱만 검증할 수 있게 한다.
 *
 * 하위 명령은 이름만 등록한다. 본체는 각 마일스톤에서 채운다 (`docs/ROADMAP.md`). 그때까지는 stderr에
 * "아직 구현되지 않음 (M?)" 한 줄을 쓰고 exit 2 — 0(성공)도 1(실패)도 아닌 "할 수 없음"이다.
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';

/** 아직 구현되지 않은 하위 명령. `milestone`은 ROADMAP의 마일스톤 */
export interface StubCommand {
  name: string;
  description: string;
  milestone: string;
}

/** 등록 순서 = `--help` 출력 순서. 첫 슬라이스 흐름(승인 → 실행 → 검사 → View) 순으로 적는다 */
export const STUB_COMMANDS: readonly StubCommand[] = [
  { name: 'init', description: '대상 레포에 plumb.config.json을 만든다', milestone: 'M10' },
  { name: 'rule', description: '규칙을 만들거나 고친다', milestone: 'M3' },
  { name: 'approve', description: '규칙을 승인한다', milestone: 'M3' },
  { name: 'run', description: '승인된 규칙으로 파이프라인을 실행한다', milestone: 'M6' },
  { name: 'check', description: '전체 검사를 돌려 규칙별 상태를 기록한다', milestone: 'M5' },
  { name: 'views', description: 'View 6개를 다시 만든다', milestone: 'M8' },
  { name: 'ui', description: '로컬 UI 서버를 띄운다', milestone: 'M3' },
  { name: 'open', description: 'View를 브라우저로 연다', milestone: 'M8' },
];

/** 미구현 명령의 종료 코드 */
export const NOT_IMPLEMENTED_EXIT_CODE = 2;

export interface CreateProgramOptions {
  /** `--version`에 쓸 버전. 기본은 `@plumb/core` package.json의 `version` */
  version?: string;
  /** 미구현 명령이 끝날 때 부른다. 기본 `process.exit`. 테스트는 기록만 하는 함수로 바꾼다 */
  exit?: (code: number) => void;
  /** 미구현 메시지를 쓸 곳. 기본 `process.stderr` */
  stderr?: { write(chunk: string): unknown };
}

/** 미구현 명령이 stderr에 쓰는 한 줄 */
export function notImplementedMessage(command: StubCommand): string {
  return `plumb ${command.name}: 아직 구현되지 않음 (${command.milestone})`;
}

/** `@plumb/core`의 package.json 버전. src/cli·dist/cli 어디서 실행하든 두 단계 위가 패키지 루트다 */
export function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

/** `plumb` 프로그램을 만든다. `parseAsync`는 호출자가 한다 */
export function createProgram(options: CreateProgramOptions = {}): Command {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const stderr = options.stderr ?? process.stderr;

  const program = new Command('plumb')
    .description('요구사항을 규칙으로 승인하고, 에이전트 실행과 검사 결과를 View로 남긴다')
    .version(options.version ?? readPackageVersion())
    .option('--target <dir>', '대상 루트 (plumb.config.json이 있는 폴더). 없으면 현재 폴더에서 위로 탐색');

  for (const stub of STUB_COMMANDS) {
    program
      .command(stub.name)
      .description(`${stub.description} (${stub.milestone})`)
      .action(() => {
        stderr.write(`${notImplementedMessage(stub)}\n`);
        exit(NOT_IMPLEMENTED_EXIT_CODE);
      });
  }

  return program;
}
