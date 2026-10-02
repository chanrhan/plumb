/**
 * `plumb rule list | show | propose | reject` (이슈 #32, 기획안 §4.3 · §4.5 · §9.1).
 *
 * - `list`: 상단에 저장소 상태 한 줄(`storeStatus()`: 정상 · 변조 · 미확인, 미확인 n건 · 최장 d일), 그 아래 표.
 *   열은 work-approve 3.1과 같다 — ID · 블록 · 종류 · 상태(M5 전까지 전부 ⬜) · 승인 · ⚠ 미확인 · ⚡ 고위험.
 *   조회이므로 변조여도 exit 0. `--strict`면 변조 증거에 exit 4 (CI · git hook용).
 * - `show <id>`: 진술 · 출처 · 의존 · checks(대상 레포에 파일이 있는지) · 결정 ID · 제안 목록 · 승인 이력.
 * - `propose --file <json>`: 제안 JSON을 코어 `proposalSchema`로 검증해 `proposals/`에 기록. drafter 없이 사람이 제안을 넣는 길.
 * - `reject <id> --proposal <p-id> --reason "..."`: 사유 없으면 exit 2. 제안이 하나뿐이면 `--proposal` 생략 가능.
 *
 * 모든 하위 명령에 `--json` — 기계용 출력 (M5 · UI 디버깅).
 */

import { access, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import type { ParsedPlumbConfig } from '../../config/index.js';
import {
  type ApprovalRecord,
  proposalSchema,
  requiresPriorApproval,
  type Store,
  type StoreStatus,
  ValidationError,
} from '../../store/index.js';
import type { ApprovalState, Proposal, Rule, RuleId, RuleListItem } from '../../types/index.js';
import {
  APPROVAL_LABEL,
  CHANGE_KIND_LABEL,
  type CliContext,
  type Column,
  defaultApprover,
  EXIT_INPUT,
  EXIT_OK,
  EXIT_TAMPERED,
  isHighRiskRule,
  isOpenProposal,
  KIND_SHORT,
  type OpenedStore,
  openTargetStore,
  renderTable,
  runCommand,
  statusLine,
  targetOf,
  writeJson,
} from './shared.js';

// ---------------------------------------------------------------------------
// 목록 행 계산
// ---------------------------------------------------------------------------

/** 목록 한 행. `RuleListItem`(types/api.ts)에 CLI가 더 보여주는 것만 덧붙인다 */
export interface RuleRow extends Omit<RuleListItem, 'approval'> {
  /** 승인 기록도 열린 제안도 없는 규칙(손으로 넣은 것)은 `unknown` */
  approval: ApprovalState | 'unknown';
  /** 규칙이 `rules.yaml`에 있는가. 없으면 제안만 있는 것 */
  inRules: boolean;
  /** 열린 제안 수 */
  openProposals: number;
}

/** 규칙의 승인 상태. 열린 제안이 있으면 잠정, 아니면 마지막 승인 기록의 행위 */
export function approvalStateOf(history: ApprovalRecord[], proposals: Proposal[]): ApprovalState | 'unknown' {
  const open = proposals.filter(isOpenProposal);
  if (open.length > 0) return 'provisional';
  const last = history.at(-1);
  if (last === undefined) return 'unknown';
  if (last.action === 'approve') return 'approved';
  if (last.action === 'reject') return 'rejected';
  return 'provisional';
}

/** `rules.yaml`의 규칙과 제안만 있는 규칙을 합쳐 행으로. ID 순 */
export async function collectRows(store: Store, config: Pick<ParsedPlumbConfig, 'blocks'>): Promise<RuleRow[]> {
  const rules = await store.rules.list();
  const proposals = await store.proposals.list();
  const ids = new Set<RuleId>([...rules.map((rule) => rule.id), ...proposals.map((proposal) => proposal.ruleId)]);

  const rows: RuleRow[] = [];
  for (const id of [...ids].sort()) {
    const rule = rules.find((r) => r.id === id);
    const own = proposals.filter((p) => p.ruleId === id);
    const open = own.filter(isOpenProposal);
    const latestOpen = open.at(-1);
    const shown: Rule | undefined = rule ?? latestOpen?.after ?? latestOpen?.before ?? own.at(-1)?.after ?? undefined;
    if (shown === undefined) continue;
    const history = await store.approvals.history(id);
    rows.push({
      id,
      ...(shown.block === undefined ? {} : { block: shown.block }),
      blockKnown: shown.block !== undefined && config.blocks?.[shown.block] !== undefined,
      kind: shown.kind,
      statement: shown.statement,
      status: 'unchecked',
      approval: approvalStateOf(history, own),
      highRisk: isHighRiskRule(shown, config),
      ...(latestOpen?.applied === 'pending' ? { pendingProposal: latestOpen.id } : {}),
      inRules: rule !== undefined,
      openProposals: open.length,
    });
  }
  return rows;
}

const LIST_COLUMNS: Column<RuleRow>[] = [
  { header: 'ID', width: 26, cell: (row) => row.id },
  {
    header: '블록',
    width: 10,
    cell: (row) => (row.block === undefined ? '-' : row.blockKnown ? row.block : `?${row.block}`),
  },
  { header: '종류', width: 4, cell: (row) => KIND_SHORT[row.kind] },
  { header: '상태', width: 4, cell: () => '⬜' },
  { header: '승인', width: 8, cell: (row) => APPROVAL_LABEL[row.approval] },
  { header: '미확인', width: 6, cell: (row) => (row.approval === 'provisional' ? '⚠' : '') },
  { header: '고위험', width: 6, cell: (row) => (row.highRisk ? '⚡' : '') },
];

export const EMPTY_LIST_MESSAGE =
  '규칙 아직 없음. `plumb rule propose --file <json>`으로 제안하고 `plumb approve <id>`로 승인한다';

async function listRules(ctx: CliContext, opened: OpenedStore, options: { json: boolean; strict: boolean }) {
  const { store, config } = opened;
  const status = await store.status();
  const rows = await collectRows(store, config);

  if (options.json) {
    const limit = config.reviewQueue;
    writeJson(ctx, {
      store: {
        project: status.project,
        status: status.status,
        rulesHash: status.rulesHash,
        lastApprovalHash: status.lastApproval?.rulesHash ?? null,
      },
      rules: rows,
      unconfirmed: status.unconfirmed,
      ...(status.longestPendingDays === null ? {} : { longestPendingDays: status.longestPendingDays }),
      queueLimit: {
        exceeded: status.unconfirmed > limit.maxUnconfirmed || (status.longestPendingDays ?? 0) > limit.maxDays,
        maxUnconfirmed: limit.maxUnconfirmed,
        maxDays: limit.maxDays,
      },
    });
  } else {
    ctx.stdout.write(`${statusLine(ctx, status)}\n`);
    if (rows.length === 0) ctx.stdout.write(`${EMPTY_LIST_MESSAGE}\n`);
    else ctx.stdout.write(renderTable(LIST_COLUMNS, rows));
  }

  return options.strict && status.status === 'tampered' ? EXIT_TAMPERED : EXIT_OK;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function showRule(ctx: CliContext, opened: OpenedStore, id: RuleId, options: { json: boolean }) {
  const { store, config, loaded } = opened;
  const rule = await store.rules.get(id);
  const proposals = await store.proposals.list(id);
  if (rule === undefined && proposals.length === 0) {
    ctx.stderr.write(`plumb: 규칙 ${id}이(가) 없다 (rules.yaml에도 proposals/에도)\n`);
    return EXIT_INPUT;
  }
  const history = await store.approvals.history(id);
  const latestOpen = proposals.filter(isOpenProposal).at(-1);
  const shown = rule ?? latestOpen?.after ?? latestOpen?.before ?? proposals.at(-1)?.after ?? null;
  const approval = approvalStateOf(history, proposals);

  const serviceRoot = resolve(loaded.root, config.service);
  const checks = await Promise.all(
    (shown?.checks ?? []).map(async (check) => ({
      check,
      exists: check.kind === 'acceptance' ? await exists(join(serviceRoot, check.ref)) : true,
    })),
  );
  const rulesInStore = await store.rules.list();
  const depends = (shown?.depends_on ?? []).map((depId) => ({
    ruleId: depId,
    exists: rulesInStore.some((r) => r.id === depId),
    status: 'unchecked' as const,
  }));
  const decision =
    shown?.decision === undefined
      ? null
      : { id: shown.decision, exists: await exists(store.paths.decision(shown.decision)) };
  const highRisk = shown === null ? false : isHighRiskRule(shown, config);

  if (options.json) {
    writeJson(ctx, {
      ...(rule === undefined ? {} : { rule }),
      approval,
      ...(latestOpen === undefined ? {} : { proposal: latestOpen }),
      proposals,
      approvals: history,
      ...(decision === null ? {} : { decision }),
      depends,
      checks,
      status: { status: 'unchecked', reason: checks.length === 0 ? 'no-checks' : 'not-run' },
      highRisk,
    });
    return EXIT_OK;
  }

  const lines: string[] = [];
  lines.push(`${id}${highRisk ? ' ⚡ 고위험' : ''}`);
  if (shown !== null) {
    lines.push(
      `  ${shown.kind} · ${shown.block ?? '블록 공통'} · ${rule === undefined ? '제안만 있음 (rules.yaml에 없음)' : 'rules.yaml'}`,
    );
    lines.push(`  진술: ${shown.statement}`);
    lines.push(`  출처: ${shown.source}`);
    lines.push(`  승인: ${APPROVAL_LABEL[approval]}`);
    lines.push(
      depends.length === 0
        ? '  의존: 의존 없음'
        : `  의존: ${depends.map((d) => `${d.ruleId}${d.exists ? '' : ' (저장소에 없음)'}`).join(', ')}`,
    );
    if (checks.length === 0) lines.push('  검사: 검사 없음 ⬜');
    else {
      lines.push('  검사:');
      for (const c of checks) lines.push(`    ${c.check.kind} ${c.check.ref}${c.exists ? '' : ' — 파일 없음'} ⬜`);
    }
    lines.push(
      decision === null ? '  결정: 결정 기록 없음' : `  결정: ${decision.id}${decision.exists ? '' : ' (파일 없음)'}`,
    );
  }
  lines.push(proposals.length === 0 ? '  제안: 없음' : '  제안:');
  for (const p of proposals) {
    lines.push(
      `    ${p.id}  ${CHANGE_KIND_LABEL[p.changeKind]}  ${p.applied}  ${p.proposedAt}  by ${p.proposedBy}${
        p.requiresPriorApproval ? '  사전 승인 필요' : ''
      }`,
    );
  }
  lines.push(history.length === 0 ? '  이력: 없음' : '  이력:');
  for (const h of history) {
    lines.push(
      `    ${h.at}  ${h.action}  ${h.proposalId}  by ${h.by}${h.reason === undefined ? '' : `  사유: ${h.reason}`}`,
    );
  }
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

/** `p-<타임스탬프>` — 파일에 `id`가 없을 때 */
export function generateProposalId(now: Date): `p-${string}` {
  return `p-${now.toISOString().replace(/[-:.TZ]/g, '')}`;
}

/**
 * 파일 JSON에 빠진 필드를 채운다: `id`(생성) · `proposedBy`(`cli`) · `proposedAt`(지금) · `applied`(사전 승인이면 `pending`, 아니면
 * `provisional`) · `requiresPriorApproval`(§9.1 판정). 있는 값은 그대로 둔다
 */
export function completeProposalInput(raw: unknown, config: Pick<ParsedPlumbConfig, 'blocks'>, now: Date): Proposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('제안 파일의 최상위는 객체여야 한다');
  }
  const input = raw as Record<string, unknown>;
  const filled: Record<string, unknown> = {
    ...input,
    id: input.id ?? generateProposalId(now),
    proposedBy: input.proposedBy ?? 'cli',
    proposedAt: input.proposedAt ?? now.toISOString(),
    requiresPriorApproval: input.requiresPriorApproval ?? false,
    applied: input.applied ?? 'provisional',
  };
  const parsed = proposalSchema.safeParse(filled);
  if (!parsed.success) throw new ValidationError('제안이 스키마에 맞지 않는다', parsed.error.issues);

  const proposal = parsed.data;
  if (input.requiresPriorApproval === undefined) {
    const prior = requiresPriorApproval(proposal, config);
    proposal.requiresPriorApproval = prior;
    if (input.applied === undefined) proposal.applied = prior ? 'pending' : 'provisional';
  }
  return proposal;
}

async function proposeRule(ctx: CliContext, opened: OpenedStore, file: string, options: { json: boolean }) {
  const { store, config } = opened;
  const path = resolve(ctx.cwd ?? process.cwd(), file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    ctx.stderr.write(
      `plumb: ${path}: 제안 JSON을 읽을 수 없다 — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_INPUT;
  }
  const proposal = completeProposalInput(raw, config, (ctx.now ?? (() => new Date()))());

  const existing = await store.proposals.get(proposal.ruleId, proposal.id);
  if (existing !== undefined && !isOpenProposal(existing)) {
    ctx.stderr.write(
      `plumb: 제안 ${proposal.id}은(는) 이미 처리됐다 (${existing.applied}). 파일의 id를 바꾸거나 지우면 새 ID가 생긴다\n`,
    );
    return EXIT_INPUT;
  }

  const written = await store.proposals.write(proposal);
  const where = relative(store.paths.root, store.paths.proposal(written.ruleId, written.id));
  if (options.json) {
    writeJson(ctx, { proposal: written, path: store.paths.proposal(written.ruleId, written.id) });
  } else {
    ctx.stdout.write(
      `제안 기록: ${written.ruleId} ← ${written.id} (${CHANGE_KIND_LABEL[written.changeKind]} · ${written.applied}) → ${where}\n`,
    );
    if (written.requiresPriorApproval) {
      ctx.stdout.write('  사전 승인 필요(고위험 완화·삭제·경계 변경) — 승인 전까지 기존 규칙이 유효하다\n');
    }
    ctx.stdout.write(`  다음: plumb approve ${written.ruleId}\n`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

/** 열린 제안 중 하나를 고른다. `--proposal`이 없고 하나뿐이면 그것, 여럿이면 목록을 보여주고 null */
export async function pickOpenProposal(
  ctx: CliContext,
  store: Store,
  ruleId: RuleId,
  proposalId: string | undefined,
): Promise<Proposal | null> {
  const open = (await store.proposals.list(ruleId)).filter(isOpenProposal);
  if (proposalId !== undefined) {
    const found = open.find((p) => p.id === proposalId);
    if (found === undefined) {
      ctx.stderr.write(
        `plumb: 규칙 ${ruleId}에 처리 대기 중인 제안 ${proposalId}이(가) 없다${
          open.length > 0 ? ` (대기 중: ${open.map((p) => p.id).join(', ')})` : ''
        }\n`,
      );
      return null;
    }
    return found;
  }
  if (open.length === 0) {
    ctx.stderr.write(`plumb: 규칙 ${ruleId}에 처리 대기 중인 제안이 없다\n`);
    return null;
  }
  if (open.length > 1) {
    ctx.stderr.write(`plumb: 규칙 ${ruleId}에 대기 중인 제안이 ${open.length}개다. --proposal <p-id>로 고른다\n`);
    for (const p of open) {
      ctx.stderr.write(`  ${p.id}  ${CHANGE_KIND_LABEL[p.changeKind]}  ${p.proposedAt}  by ${p.proposedBy}\n`);
    }
    return null;
  }
  return open[0] ?? null;
}

async function rejectRule(
  ctx: CliContext,
  opened: OpenedStore,
  ruleId: RuleId,
  options: { proposal?: string; reason?: string; by: string; json: boolean },
) {
  if (options.reason === undefined || options.reason.trim().length === 0) {
    ctx.stderr.write('plumb: 기각 사유가 없다. --reason "..."을 준다 (승인 기록에 남고, 재제안 때 입력이 된다)\n');
    return EXIT_INPUT;
  }
  const proposal = await pickOpenProposal(ctx, opened.store, ruleId, options.proposal);
  if (proposal === null) return EXIT_INPUT;

  const result = await opened.store.approvals.reject({
    ruleId,
    proposalId: proposal.id,
    by: options.by,
    reason: options.reason,
  });
  const status: StoreStatus = await opened.store.status();
  if (options.json) {
    writeJson(ctx, { approval: result.approval, approvalState: 'rejected', unconfirmed: status.unconfirmed });
  } else {
    ctx.stdout.write(`기각: ${ruleId} ← ${proposal.id} (by ${options.by}) · 사유: ${options.reason}\n`);
    ctx.stdout.write(`${statusLine(ctx, status)}\n`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

export function registerRuleCommand(program: Command, ctx: CliContext): Command {
  const rule = program.command('rule').description('규칙을 보고 제안하고 기각한다 (M3)');

  rule
    .command('list')
    .description('규칙 목록. 상단 한 줄은 보호 저장소 상태')
    .option('--json', '기계용 JSON 출력', false)
    .option('--strict', '변조 증거가 있으면 exit 4 (CI · git hook용)', false)
    .action(async (options: { json: boolean; strict: boolean }, command: Command) => {
      await runCommand(ctx, async () => listRules(ctx, await openTargetStore(ctx, targetOf(command)), options));
    });

  rule
    .command('show <ruleId>')
    .description('규칙 하나의 진술 · 출처 · 의존 · 검사 · 결정 · 제안 · 승인 이력')
    .option('--json', '기계용 JSON 출력', false)
    .action(async (ruleId: string, options: { json: boolean }, command: Command) => {
      await runCommand(ctx, async () =>
        showRule(ctx, await openTargetStore(ctx, targetOf(command)), ruleId as RuleId, options),
      );
    });

  rule
    .command('propose')
    .description('제안 JSON을 검증해 proposals/에 기록한다. rules.yaml은 바뀌지 않는다')
    .requiredOption('--file <json>', '제안 JSON 파일 (Proposal 타입. id가 없으면 생성)')
    .option('--json', '기계용 JSON 출력', false)
    .action(async (options: { file: string; json: boolean }, command: Command) => {
      await runCommand(ctx, async () =>
        proposeRule(ctx, await openTargetStore(ctx, targetOf(command)), options.file, options),
      );
    });

  rule
    .command('reject <ruleId>')
    .description('제안을 기각한다. 사유 필수. rules.yaml은 바뀌지 않는다')
    .option('--proposal <p-id>', '기각할 제안. 대기 중인 제안이 하나면 생략 가능')
    .option('--reason <text>', '기각 사유 (필수)')
    .option('--by <name>', '기각자. 기본 OS 사용자 이름')
    .option('--json', '기계용 JSON 출력', false)
    .action(
      async (
        ruleId: string,
        options: { proposal?: string; reason?: string; by?: string; json: boolean },
        command: Command,
      ) => {
        await runCommand(ctx, async () =>
          rejectRule(ctx, await openTargetStore(ctx, targetOf(command)), ruleId as RuleId, {
            ...options,
            by: options.by ?? defaultApprover(ctx),
          }),
        );
      },
    );

  return rule;
}
