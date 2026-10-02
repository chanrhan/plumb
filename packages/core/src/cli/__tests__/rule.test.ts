/**
 * 이슈 #32 "완료 증거" 시나리오를 CLI로: 임시 폴더에 `plumb.config.json`을 쓰고 `createProgram()`을 `exitOverride()`로 돌린다.
 * propose → list(⬜ · 잠정 1) → approve → list(승인) → `rules.yaml` 손으로 수정 → list 상단 변조 경보 → `--strict` exit 4.
 * reject 사유 없음 exit 2. 고위험 relax 제안 approve → exit 3.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Proposal, Rule } from '../../types/index.js';
import { generateProposalId } from '../commands/rule.js';
import { displayWidth, padColumn } from '../commands/shared.js';
import { createProgram } from '../program.js';

/** 기획안 §5.2 예시 규칙 (testbed 제안 파일과 같은 내용) */
const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: [],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
  decision: 'D-0001',
};

const CONFIG = {
  service: '.',
  store: './.plumb-store',
  work: './.work',
  adapter: 'nextjs',
  node: '22',
  roles: {
    'test-writer': { model: 'default', maxTurns: 60, maxBudgetUsd: 3 },
    implementer: { model: 'default', maxTurns: 80, maxBudgetUsd: 5 },
    injector: { model: 'default', maxTurns: 30, maxBudgetUsd: 2 },
    'rule-drafter': { model: 'default', maxTurns: 1, maxBudgetUsd: 0.5 },
  },
  stopBlockLimit: 5,
  blocks: {
    payment: { include: ['src/domains/payment/**'], risk: 'high' },
    auth: { include: ['src/domains/auth/**'] },
  },
};

let dir: string;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plumb-cli-'));
  await writeFile(join(dir, 'plumb.config.json'), JSON.stringify(CONFIG, null, 2));
  clock = new Date('2026-10-02T09:00:00.000Z');
});

afterEach(() => rm(dir, { recursive: true, force: true }));

/** 1초씩 흐르는 시계 — 기록 순서가 `at`에 남는다 */
function now(): Date {
  clock = new Date(clock.getTime() + 1000);
  return clock;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `plumb --target <dir> ...`를 한 번 돌린다. exit는 기록만 */
async function plumb(...args: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const program = createProgram({
    exit: (code) => exits.push(code),
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    cwd: dir,
    env: { USER: 'tester' },
    now,
  })
    .exitOverride()
    .configureOutput({
      writeOut: (str) => out.push(str),
      writeErr: (str) => err.push(str),
    });
  await program.parseAsync(['--target', dir, ...args], { from: 'user' });
  return { code: exits.at(-1) ?? 0, stdout: out.join(''), stderr: err.join('') };
}

/** 제안 파일을 쓴다. 일부러 깨진 입력도 넣을 수 있게 타입은 `unknown` */
async function writeProposalFile(name: string, proposal: unknown): Promise<string> {
  await mkdir(join(dir, 'plumb', 'proposals'), { recursive: true });
  const path = join(dir, 'plumb', 'proposals', `${name}.json`);
  await writeFile(path, JSON.stringify(proposal, null, 2));
  return path;
}

const ADD_PROPOSAL: Proposal = {
  id: 'p-0001',
  ruleId: REFUND_RULE.id,
  changeKind: 'add',
  proposedBy: 'cli',
  proposedAt: '2026-10-01T05:00:00.000Z',
  after: REFUND_RULE,
  requiresPriorApproval: false,
  applied: 'provisional',
};

/** 표에서 규칙 ID로 시작하는 행 */
function row(stdout: string, id: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith(id));
  if (line === undefined) throw new Error(`표에 ${id} 행이 없다:\n${stdout}`);
  return line;
}

describe('plumb rule · approve — propose → approve → tamper', () => {
  it('빈 저장소: list는 "정상 · 미확인 0건"과 비어 있음 안내, exit 0', async () => {
    const r = await plumb('rule', 'list');
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('보호 저장소 정상 · 미확인 0건');
    expect(r.stdout).toContain('규칙 아직 없음');
    // init이 저장소를 만들었다
    expect(await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8')).toBe('version: 1\nrules: []\n');
  });

  it('propose → list(⬜ · 잠정 · ⚠ · ⚡) → approve → list(승인) → 변조 → 경보 → --strict exit 4', async () => {
    const file = await writeProposalFile('pay.refund-window', ADD_PROPOSAL);

    // propose: proposals/에 기록, rules.yaml은 그대로
    const proposed = await plumb('rule', 'propose', '--file', file);
    expect(proposed.code).toBe(0);
    expect(proposed.stdout).toContain('제안 기록: pay.refund-window ← p-0001 (추가 · provisional)');
    const written = JSON.parse(
      await readFile(join(dir, '.plumb-store', 'proposals', 'pay.refund-window', 'p-0001.json'), 'utf8'),
    );
    expect(written).toEqual(ADD_PROPOSAL);
    expect(await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8')).toBe('version: 1\nrules: []\n');

    // list: 상단 정상 · 미확인 1건 · 최장 1일, 행은 ⬜ 잠정 ⚠ ⚡
    const listed = await plumb('rule', 'list');
    expect(listed.code).toBe(0);
    expect(listed.stdout.split('\n')[0]).toBe('보호 저장소 정상 · 미확인 1건 · 최장 1일');
    const provisional = row(listed.stdout, 'pay.refund-window');
    expect(provisional).toContain('payment');
    expect(provisional).toContain('biz');
    expect(provisional).toContain('⬜');
    expect(provisional).toContain('잠정');
    expect(provisional).toContain('⚠');
    expect(provisional).toContain('⚡');

    // --json
    const json = JSON.parse((await plumb('rule', 'list', '--json')).stdout);
    expect(json.store.status).toBe('ok');
    expect(json.unconfirmed).toBe(1);
    expect(json.rules).toHaveLength(1);
    expect(json.rules[0]).toMatchObject({
      id: 'pay.refund-window',
      block: 'payment',
      blockKnown: true,
      kind: 'business',
      status: 'unchecked',
      approval: 'provisional',
      highRisk: true,
      inRules: false,
      openProposals: 1,
    });

    // approve: 제안이 하나라 --proposal 생략
    const approved = await plumb('approve', 'pay.refund-window', '--by', 'test');
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('승인: pay.refund-window ← p-0001 (추가 · by test)');
    expect(approved.stdout).toContain('보호 저장소 정상 · 미확인 0건');
    const yamlText = await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8');
    expect(yamlText).toContain('- id: pay.refund-window');
    expect(yamlText).toContain('7일');
    const approvals = (await readFile(join(dir, '.plumb-store', 'approvals', 'pay.refund-window.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(approvals).toHaveLength(1);
    expect(JSON.parse(approvals[0] ?? '')).toMatchObject({ action: 'approve', by: 'test', proposalId: 'p-0001' });

    // list: 승인 · ⚡ · 미확인 없음
    const afterApprove = await plumb('rule', 'list');
    expect(afterApprove.stdout.split('\n')[0]).toBe('보호 저장소 정상 · 미확인 0건');
    const approvedRow = row(afterApprove.stdout, 'pay.refund-window');
    expect(approvedRow).toContain('승인');
    expect(approvedRow).toContain('⚡');
    expect(approvedRow).not.toContain('⚠');
    expect(approvedRow).not.toContain('잠정');

    // show
    const shown = await plumb('rule', 'show', 'pay.refund-window');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('진술: WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다');
    expect(shown.stdout).toContain('출처: plan:PAY-02');
    expect(shown.stdout).toContain('의존 없음');
    expect(shown.stdout).toContain('test/acceptance/refund-window.property.spec.ts — 파일 없음');
    expect(shown.stdout).toContain('결정: D-0001 (파일 없음)');
    expect(shown.stdout).toContain('p-0001  추가  applied');
    expect(shown.stdout).toMatch(/approve {2}p-0001 {2}by test/);

    // 승인 없이 rules.yaml을 고친다 → 상단 변조 경보, 조회라 exit 0
    await writeFile(join(dir, '.plumb-store', 'rules.yaml'), yamlText.replace('7일', '30일'));
    const tampered = await plumb('rule', 'list');
    expect(tampered.code).toBe(0);
    expect(tampered.stdout.split('\n')[0]).toBe('⚠ 변조 증거: rules.yaml이 마지막 승인 이후 바뀜 · 미확인 0건');
    expect(row(tampered.stdout, 'pay.refund-window')).toContain('승인');

    // --strict → exit 4
    const strict = await plumb('rule', 'list', '--strict');
    expect(strict.code).toBe(4);
    expect(strict.stdout.split('\n')[0]).toContain('변조 증거');
    const strictJson = await plumb('rule', 'list', '--strict', '--json');
    expect(strictJson.code).toBe(4);
    expect(JSON.parse(strictJson.stdout).store.status).toBe('tampered');
  });

  it('approve: 대기 중인 제안이 없으면 exit 2, 여럿이면 목록과 exit 2, --proposal로 고르면 승인', async () => {
    const none = await plumb('approve', 'pay.refund-window');
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('처리 대기 중인 제안이 없다');

    await plumb('rule', 'propose', '--file', await writeProposalFile('a', ADD_PROPOSAL));
    await plumb(
      'rule',
      'propose',
      '--file',
      await writeProposalFile('b', { ...ADD_PROPOSAL, id: 'p-0002', proposedAt: '2026-10-01T06:00:00.000Z' }),
    );

    const many = await plumb('approve', 'pay.refund-window');
    expect(many.code).toBe(2);
    expect(many.stderr).toContain('대기 중인 제안이 2개다');
    expect(many.stderr).toContain('p-0001');
    expect(many.stderr).toContain('p-0002');
    expect(await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8')).toBe('version: 1\nrules: []\n');

    const picked = await plumb('approve', 'pay.refund-window', '--proposal', 'p-0002');
    expect(picked.code).toBe(0);
    expect(picked.stdout).toContain('← p-0002');
    // --by 기본값은 env USER
    const line = JSON.parse(
      (await readFile(join(dir, '.plumb-store', 'approvals', 'pay.refund-window.jsonl'), 'utf8')).trim(),
    );
    expect(line.by).toBe('tester');
    // 남은 p-0001은 add인데 규칙이 이미 있다 → 코어 ValidationError → exit 2
    const dup = await plumb('approve', 'pay.refund-window', '--proposal', 'p-0001');
    expect(dup.code).toBe(2);
    expect(dup.stderr).toContain('이미 rules.yaml에 있다');
  });

  it('reject: 사유 없으면 exit 2, 있으면 기각 기록 · rules.yaml 불변', async () => {
    await plumb('rule', 'propose', '--file', await writeProposalFile('a', ADD_PROPOSAL));

    const noReason = await plumb('rule', 'reject', 'pay.refund-window', '--proposal', 'p-0001');
    expect(noReason.code).toBe(2);
    expect(noReason.stderr).toContain('기각 사유가 없다');
    const blank = await plumb('rule', 'reject', 'pay.refund-window', '--proposal', 'p-0001', '--reason', '   ');
    expect(blank.code).toBe(2);
    // 실패한 기각은 아무것도 남기지 않는다
    expect((await plumb('rule', 'list')).stdout).toContain('잠정');

    const rejected = await plumb(
      'rule',
      'reject',
      'pay.refund-window',
      '--proposal',
      'p-0001',
      '--reason',
      '14일로 재검토',
    );
    expect(rejected.code).toBe(0);
    expect(rejected.stdout).toContain('기각: pay.refund-window ← p-0001 (by tester) · 사유: 14일로 재검토');
    expect(await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8')).toBe('version: 1\nrules: []\n');
    const listed = await plumb('rule', 'list');
    expect(listed.stdout.split('\n')[0]).toBe('보호 저장소 정상 · 미확인 0건');
    expect(row(listed.stdout, 'pay.refund-window')).toContain('기각');
  });

  it('고위험 relax 제안 approve → 사전 승인 메시지, exit 3, 아무것도 쓰지 않음', async () => {
    await plumb('rule', 'propose', '--file', await writeProposalFile('add', ADD_PROPOSAL));
    await plumb('approve', 'pay.refund-window', '--by', 'test');
    const yamlBefore = await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8');

    // requiresPriorApproval · applied를 비우면 propose가 §9.1 판정으로 채운다
    const relaxFile = await writeProposalFile('relax', {
      id: 'p-0002',
      ruleId: REFUND_RULE.id,
      changeKind: 'relax',
      before: REFUND_RULE,
      after: { ...REFUND_RULE, statement: 'WHEN 환불 요청이 결제 후 30일을 초과하면 THE SYSTEM SHALL 요청을 거절한다' },
    });
    const proposed = await plumb('rule', 'propose', '--file', relaxFile);
    expect(proposed.code).toBe(0);
    expect(proposed.stdout).toContain('(완화 · pending)');
    expect(proposed.stdout).toContain('사전 승인 필요');
    const stored = JSON.parse(
      await readFile(join(dir, '.plumb-store', 'proposals', 'pay.refund-window', 'p-0002.json'), 'utf8'),
    );
    expect(stored).toMatchObject({ proposedBy: 'cli', requiresPriorApproval: true, applied: 'pending' });

    const approved = await plumb('approve', 'pay.refund-window', '--by', 'test');
    expect(approved.code).toBe(3);
    expect(approved.stderr).toContain('사전 승인 필요(고위험 완화·삭제·경계 변경) — M10에서 결정 단위 승인');
    expect(await readFile(join(dir, '.plumb-store', 'rules.yaml'), 'utf8')).toBe(yamlBefore);
    const approvals = (await readFile(join(dir, '.plumb-store', 'approvals', 'pay.refund-window.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(approvals).toHaveLength(1);

    // 승인 전까지 기존 규칙 유효: 목록은 7일 규칙, 승인 상태는 잠정(열린 제안)
    const json = JSON.parse((await plumb('rule', 'list', '--json')).stdout);
    expect(json.rules[0]).toMatchObject({ approval: 'provisional', pendingProposal: 'p-0002', inRules: true });
    expect(json.rules[0].statement).toContain('7일');
  });

  it('propose: 스키마 위반은 exit 2, id 없으면 p-<타임스탬프> 생성, 처리된 제안 ID 재사용은 exit 2', async () => {
    const bad = await plumb(
      'rule',
      'propose',
      '--file',
      await writeProposalFile('bad', { ruleId: 'nodot', changeKind: 'add', after: null }),
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('스키마에 맞지 않는다');

    const missing = await plumb('rule', 'propose', '--file', join(dir, 'nope.json'));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('제안 JSON을 읽을 수 없다');

    const {
      id: _id,
      proposedBy: _by,
      proposedAt: _at,
      applied: _applied,
      requiresPriorApproval: _rpa,
      ...bare
    } = ADD_PROPOSAL;
    const generated = await plumb('rule', 'propose', '--file', await writeProposalFile('bare', bare), '--json');
    expect(generated.code).toBe(0);
    const out = JSON.parse(generated.stdout);
    expect(out.proposal.id).toMatch(/^p-\d{17}$/);
    expect(out.proposal).toMatchObject({ proposedBy: 'cli', applied: 'provisional', requiresPriorApproval: false });
    expect(generateProposalId(new Date('2026-10-02T09:00:00.123Z'))).toBe('p-20261002090000123');

    await plumb('approve', 'pay.refund-window');
    const reuse = await plumb(
      'rule',
      'propose',
      '--file',
      await writeProposalFile('again', { ...bare, id: out.proposal.id }),
    );
    expect(reuse.code).toBe(2);
    expect(reuse.stderr).toContain('이미 처리됐다 (applied)');
  });

  it('show: 없는 규칙은 exit 2 · --json은 types/api.ts RuleDetailResponse 모양', async () => {
    const none = await plumb('rule', 'show', 'pay.nothing');
    expect(none.code).toBe(2);

    await plumb('rule', 'propose', '--file', await writeProposalFile('a', ADD_PROPOSAL));
    const json = JSON.parse((await plumb('rule', 'show', 'pay.refund-window', '--json')).stdout);
    expect(json.rule).toBeUndefined();
    expect(json.approval).toBe('provisional');
    expect(json.proposal.id).toBe('p-0001');
    expect(json.checks).toEqual([
      { check: { kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }, exists: false },
    ]);
    expect(json.decision).toEqual({ id: 'D-0001', exists: false });
    expect(json.highRisk).toBe(true);
  });

  it('설정 파일이 없으면 exit 1', async () => {
    await rm(join(dir, 'plumb.config.json'));
    const r = await plumb('rule', 'list');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('plumb.config.json');
  });
});

describe('표 열 폭', () => {
  it('한글 · 상태 이모지는 2칸', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('승인')).toBe(4);
    expect(displayWidth('⬜')).toBe(2);
    expect(displayWidth('⚡')).toBe(2);
    expect(padColumn('승인', 6)).toBe('승인  ');
    expect(padColumn('pay.refund-window-very-long', 10)).toBe('pay.refun…');
  });
});
