/**
 * `rule` · `approve` 하위 명령의 공통부 (이슈 #32). 입출력을 주입받아 테스트가 stdout · exit code를 잡을 수 있게 한다.
 *
 * 흐름은 모든 명령이 같다: `--target` → `loadConfig` → `openStore(config, root)` → `init()`(멱등) → 본체.
 * 종료 코드: 0 성공 · 1 설정 · 저장소 오류 · 2 입력 문제(사유 없음, 제안 여럿, 스키마 위반, 없는 규칙) · 3 사전 승인 필요(M10) ·
 * 4 `rule list --strict`에서 변조 증거. `check --strict`(#47)는 🔴 있음 4 · 변조 5 · 러너 실패 6 (`commands/check.ts`).
 */

import type { Command } from 'commander';
import type { AdapterLoader } from '../../adapter/load.js';
import { ConfigError, type LoadedConfig, loadConfig, type ParsedPlumbConfig } from '../../config/index.js';
import {
  openStore,
  ProposalNotFoundError,
  RuleNotFoundError,
  type Store,
  StoreError,
  ValidationError,
} from '../../store/index.js';
import type { ApprovalState, Proposal, Rule, RuleKind } from '../../types/index.js';
import type { ViewGeneratorMap } from '../../views/registry.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INPUT = 2;
export const EXIT_PRIOR_APPROVAL = 3;
export const EXIT_TAMPERED = 4;

export interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** 명령이 쓰는 입출력. `createProgram`이 채운다 */
export interface CliContext {
  stdout: Writer;
  stderr: Writer;
  exit: (code: number) => void;
  /** 설정 파일 탐색 시작점. 기본 `process.cwd()` */
  cwd?: string;
  /** `--by` 기본값 등에 쓰는 환경변수. 기본 `process.env` */
  env: NodeJS.ProcessEnv;
  /** 저장소 기본 위치(`~/.plumb/stores/`)의 홈. 기본 `os.homedir()` */
  home?: string;
  /** 기록 시각. 테스트가 바꾼다 */
  now?: () => Date;
  /** 어댑터 로더 (`plumb check` · `plumb views`). 기본 `adapter/load.ts`의 `loadAdapter`. 테스트는 가짜 어댑터를 넣는다 */
  loadAdapter?: AdapterLoader;
  /** View 생성기 표 (`plumb views` · `check --views`). 기본 `views/registry.ts`의 `VIEW_GENERATORS`. 테스트는 가짜를 넣는다 */
  viewGenerators?: ViewGeneratorMap;
}

export interface OpenedStore {
  loaded: LoadedConfig;
  config: ParsedPlumbConfig;
  store: Store;
}

/** `--target` → 설정 → 저장소. 저장소 폴더가 없으면 만든다 (`init`은 멱등) */
export async function openTargetStore(ctx: CliContext, target: string | undefined): Promise<OpenedStore> {
  const loaded = await loadConfig({ target, cwd: ctx.cwd });
  const options = {
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  };
  const store = openStore(loaded.config, loaded.root, options);
  await store.init();
  return { loaded, config: loaded.config, store };
}

/** 하위 명령의 전역 옵션(`plumb --target <dir> rule list`)을 읽는다 */
export function targetOf(command: Command): string | undefined {
  const opts = command.optsWithGlobals<{ target?: string }>();
  return opts.target;
}

/**
 * 명령 본체를 감싼다. 본체는 종료 코드를 돌려주고, 던진 오류는 종류별로 stderr 한 줄 + 종료 코드로 바뀐다.
 * 0이 아닐 때만 `exit`를 부른다 — 성공은 자연 종료(출력 버퍼가 잘리지 않도록)
 */
export async function runCommand(ctx: CliContext, body: () => Promise<number>): Promise<void> {
  let code: number;
  try {
    code = await body();
  } catch (error) {
    code = reportError(ctx, error);
  }
  if (code !== EXIT_OK) ctx.exit(code);
}

export function reportError(ctx: CliContext, error: unknown): number {
  if (error instanceof ConfigError) {
    ctx.stderr.write(`plumb: ${error.message}\n`);
    return EXIT_ERROR;
  }
  if (
    error instanceof ValidationError ||
    error instanceof RuleNotFoundError ||
    error instanceof ProposalNotFoundError
  ) {
    ctx.stderr.write(`plumb: ${error.message}\n`);
    return EXIT_INPUT;
  }
  if (error instanceof StoreError) {
    ctx.stderr.write(`plumb: ${error.message}\n`);
    return EXIT_ERROR;
  }
  ctx.stderr.write(`plumb: ${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT_ERROR;
}

export function writeJson(ctx: CliContext, value: unknown): void {
  ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 표시
// ---------------------------------------------------------------------------

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** TTY일 때만 색을 입힌다 (`NO_COLOR` 존중). 파이프 · 테스트에서는 그대로 */
export function paint(ctx: CliContext, color: 'red' | 'yellow', text: string): string {
  if (ctx.stdout.isTTY !== true || ctx.env.NO_COLOR !== undefined) return text;
  return `${color === 'red' ? RED : YELLOW}${text}${RESET}`;
}

/** 터미널 열 폭. 한글 · CJK · 전각 · 상태 이모지는 2칸, 나머지 1칸 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x26a1 || // ⚡
    cp === 0x2b1c || // ⬜
    (cp >= 0x1f300 && cp <= 0x1faff) // 🟢 🟡 🟠 🔴 등
  );
}

/** 열 폭에 맞춰 오른쪽을 공백으로 채운다. 넘치면 `…`로 자른다 */
export function padColumn(text: string, width: number): string {
  if (displayWidth(text) <= width) return text + ' '.repeat(width - displayWidth(text));
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char) > width - 1) break;
    out += char;
  }
  out += '…';
  return out + ' '.repeat(Math.max(0, width - displayWidth(out)));
}

export interface Column<T> {
  header: string;
  width: number;
  cell(row: T): string;
}

/** 열 폭 고정 표. 머리 한 줄 + 구분선 + 행 */
export function renderTable<T>(columns: Column<T>[], rows: T[]): string {
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => padColumn(cell, columns[i]?.width ?? 0))
      .join('  ')
      .trimEnd();
  const out = [line(columns.map((c) => c.header)), columns.map((c) => '─'.repeat(c.width)).join('  ')];
  for (const row of rows) out.push(line(columns.map((c) => c.cell(row))));
  return `${out.join('\n')}\n`;
}

export const KIND_SHORT: Record<RuleKind, string> = { architecture: 'arch', technical: 'tech', business: 'biz' };

export const APPROVAL_LABEL: Record<ApprovalState | 'unknown', string> = {
  provisional: '잠정',
  approved: '승인',
  rejected: '기각',
  unknown: '기록없음',
};

export const CHANGE_KIND_LABEL: Record<Proposal['changeKind'], string> = {
  add: '추가',
  strengthen: '강화',
  relax: '완화',
  delete: '삭제',
  boundary: '경계 변경',
};

/** `⚡`: 규칙 `risk: high` 또는 설정에서 그 블록이 고위험 (work-approve 3.1) */
export function isHighRiskRule(rule: Rule, config: Pick<ParsedPlumbConfig, 'blocks'>): boolean {
  return rule.risk === 'high' || (rule.block !== undefined && config.blocks?.[rule.block]?.risk === 'high');
}

/** 처리되지 않은 제안 (잠정 적용 · 사전 승인 대기) */
export function isOpenProposal(proposal: Proposal): boolean {
  return proposal.applied === 'provisional' || proposal.applied === 'pending';
}

/** 승인자 기본값: OS 사용자 이름, 없으면 `developer` */
export function defaultApprover(ctx: CliContext): string {
  return ctx.env.USER ?? ctx.env.USERNAME ?? 'developer';
}

/** 저장소 상태 한 줄 (`rule list` 상단 · `approve` 뒤). 변조면 빨간 줄 */
export function statusLine(
  ctx: CliContext,
  status: { status: 'ok' | 'tampered' | 'unverified'; unconfirmed: number; longestPendingDays: number | null },
): string {
  const tail = [`미확인 ${status.unconfirmed}건`];
  if (status.longestPendingDays !== null) tail.push(`최장 ${status.longestPendingDays}일`);
  switch (status.status) {
    case 'ok':
      return ['보호 저장소 정상', ...tail].join(' · ');
    case 'tampered':
      return paint(ctx, 'red', ['⚠ 변조 증거: rules.yaml이 마지막 승인 이후 바뀜', ...tail].join(' · '));
    case 'unverified':
      return paint(ctx, 'yellow', ['⚠ 미확인 저장소: 승인 기록 없이 rules.yaml에 내용이 있음', ...tail].join(' · '));
  }
}
