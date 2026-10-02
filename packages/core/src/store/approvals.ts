/**
 * 승인 · 기각 (기획안 §9.1 · §10). **`rules.yaml`을 바꾸는 유일한 경로는 {@link approve}다.**
 *
 * `approve()`: 제안을 읽고 → 고위험 블록의 relax · delete · boundary면 `requiresPriorApproval: true`를 돌려주고 아무것도 쓰지 않는다
 * (M10 전까지 CLI/UI는 표시만) → 아니면 `rules.yaml`에 반영 → 반영 후 파일의 sha256을 `rulesHash`로 `approvals/<ruleId>.jsonl`에
 * 한 줄 append → 제안 파일을 `applied: 'applied'`로.
 *
 * `reject()`: 사유 필수. jsonl에 `action: 'reject'` 한 줄, 제안 파일 `applied: 'rejected'`. `rules.yaml`은 손대지 않고 기각 줄에는
 * `rulesHash`를 적지 않는다 — 변조된 파일의 해시를 기각이 "확인"해 주면 안 되기 때문이다.
 *
 * jsonl 한 줄은 {@link Approval}에 `rulesHash` · `note`를 더한 {@link ApprovalRecord}. 두 필드는 공유 타입에 없다 (PR 본문 "타입 보완 후보").
 */

import type { Approval, PlumbConfig, Proposal, ProposalId, Rule, RuleId } from '../types/index.js';
import { ProposalChangedError, ProposalNotFoundError, RuleNotFoundError, ValidationError } from './errors.js';
import { appendJsonLine, listFiles, readJsonLines } from './fs.js';
import type { StorePaths } from './paths.js';
import { getProposal, hashProposal, updateProposal } from './proposals.js';
import { readRulesFile, writeRules } from './rules.js';

/** `approvals/<ruleId>.jsonl` 한 줄. `rulesHash`는 승인 줄에만 (반영 후 `rules.yaml`의 sha256) */
export interface ApprovalRecord extends Approval {
  rulesHash?: string;
  /** 승인 메모 (선택) */
  note?: string;
}

/** 고위험 판정에 쓰는 설정 부분 (`blocks.<id>.risk`) */
export type ApprovalConfig = Pick<PlumbConfig, 'blocks'>;

export interface ApproveInput {
  ruleId: RuleId;
  proposalId: ProposalId;
  /** 승인자. UI 토큰 세션이면 `ui`, CLI면 OS 사용자 이름 */
  by: string;
  note?: string;
  /** 화면이 본 제안의 해시. 주어지고 저장된 제안과 다르면 {@link ProposalChangedError} (API 409) */
  expectedProposalHash?: string;
}

export interface RejectInput {
  ruleId: RuleId;
  proposalId: ProposalId;
  by: string;
  /** 기각 사유. 비어 있으면 {@link ValidationError} (API 400 `reason-required`) */
  reason: string;
  expectedProposalHash?: string;
}

export type ApproveResult =
  | {
      applied: true;
      requiresPriorApproval: false;
      approval: ApprovalRecord;
      /** 반영 후 `rules.yaml`의 sha256 (= `approval.rulesHash`) */
      rulesHash: string;
      /** 반영된 규칙. 삭제면 null */
      rule: Rule | null;
      proposal: Proposal;
    }
  | {
      /** 고위험 영역의 완화 · 삭제 · 경계 변경. 아무것도 쓰지 않았다. 승인 전까지 기존 규칙(`proposal.before`)이 유효하다 */
      applied: false;
      requiresPriorApproval: true;
      proposal: Proposal;
    };

export interface RejectResult {
  approval: ApprovalRecord;
  proposal: Proposal;
}

export interface ApprovalOptions {
  /** 기록 시각. 테스트가 바꾼다 */
  now?: () => Date;
}

const PRIOR_APPROVAL_KINDS: ReadonlySet<Proposal['changeKind']> = new Set(['relax', 'delete', 'boundary']);

/** `⚡`: 규칙 `risk: high` 또는 그 블록이 설정에서 고위험 선언 (before · after 어느 쪽이든) */
export function isHighRisk(proposal: Proposal, config: ApprovalConfig): boolean {
  const versions = [proposal.before, proposal.after].filter(
    (rule): rule is Rule => rule !== undefined && rule !== null,
  );
  return versions.some(
    (rule) => rule.risk === 'high' || (rule.block !== undefined && config.blocks?.[rule.block]?.risk === 'high'),
  );
}

/** 기획안 §9.1: 고위험 AND changeKind ∈ {relax, delete, boundary} → 사전 승인 */
export function requiresPriorApproval(proposal: Proposal, config: ApprovalConfig): boolean {
  return PRIOR_APPROVAL_KINDS.has(proposal.changeKind) && isHighRisk(proposal, config);
}

/** 제안을 현재 규칙 목록에 반영한 새 목록. 원본은 바꾸지 않는다 */
export function applyProposal(rules: Rule[], proposal: Proposal): Rule[] {
  const index = rules.findIndex((rule) => rule.id === proposal.ruleId);
  switch (proposal.changeKind) {
    case 'add': {
      if (proposal.after === null) throw new ValidationError('추가 제안에 after가 없다');
      if (index >= 0)
        throw new ValidationError(
          `규칙 ${proposal.ruleId}이(가) 이미 rules.yaml에 있다. 추가가 아니라 강화·완화 제안이어야 한다`,
        );
      return [...rules, proposal.after];
    }
    case 'strengthen':
    case 'relax':
    case 'boundary': {
      if (proposal.after === null) throw new ValidationError(`${proposal.changeKind} 제안에 after가 없다`);
      if (index < 0) throw new RuleNotFoundError(proposal.ruleId);
      const next = [...rules];
      next[index] = proposal.after;
      return next;
    }
    case 'delete': {
      if (index < 0) throw new RuleNotFoundError(proposal.ruleId);
      return rules.filter((rule) => rule.id !== proposal.ruleId);
    }
  }
}

async function loadPending(
  paths: StorePaths,
  input: { ruleId: RuleId; proposalId: ProposalId; by: string; expectedProposalHash?: string },
): Promise<{ proposal: Proposal; proposalHash: string }> {
  if (input.by.trim().length === 0) throw new ValidationError('승인자(by)가 비어 있다');
  const proposal = await getProposal(paths, input.ruleId, input.proposalId);
  if (proposal === undefined) throw new ProposalNotFoundError(input.ruleId, input.proposalId);
  const proposalHash = hashProposal(proposal);
  if (input.expectedProposalHash !== undefined && input.expectedProposalHash !== proposalHash) {
    throw new ProposalChangedError(input.ruleId, input.proposalId, input.expectedProposalHash, proposalHash);
  }
  if (proposal.applied === 'applied' || proposal.applied === 'rejected') {
    throw new ValidationError(`제안 ${input.proposalId}은(는) 이미 처리됐다 (${proposal.applied})`);
  }
  return { proposal, proposalHash };
}

/** 승인. 흐름은 파일 머리 주석 */
export async function approve(
  paths: StorePaths,
  config: ApprovalConfig,
  input: ApproveInput,
  options: ApprovalOptions = {},
): Promise<ApproveResult> {
  const { proposal, proposalHash } = await loadPending(paths, input);

  if (requiresPriorApproval(proposal, config)) {
    return { applied: false, requiresPriorApproval: true, proposal };
  }

  const current = await readRulesFile(paths);
  const next = applyProposal(current.rules, proposal);
  const rulesHash = await writeRules(paths, next);

  const approval: ApprovalRecord = {
    ruleId: proposal.ruleId,
    proposalId: proposal.id,
    action: 'approve',
    at: (options.now ?? (() => new Date()))().toISOString(),
    by: input.by,
    proposalHash,
    rulesHash,
    ...(input.note !== undefined && input.note.length > 0 ? { note: input.note } : {}),
  };
  await appendJsonLine(paths.approvals(proposal.ruleId), approval);

  const updated = await updateProposal(paths, proposal.ruleId, proposal.id, { applied: 'applied' });
  return { applied: true, requiresPriorApproval: false, approval, rulesHash, rule: proposal.after, proposal: updated };
}

/** 기각. 사유 필수. `rules.yaml`은 손대지 않는다 */
export async function reject(
  paths: StorePaths,
  input: RejectInput,
  options: ApprovalOptions = {},
): Promise<RejectResult> {
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new ValidationError('기각 사유(reason)가 비어 있다');
  }
  const { proposal, proposalHash } = await loadPending(paths, input);

  const approval: ApprovalRecord = {
    ruleId: proposal.ruleId,
    proposalId: proposal.id,
    action: 'reject',
    at: (options.now ?? (() => new Date()))().toISOString(),
    by: input.by,
    reason: input.reason,
    proposalHash,
  };
  await appendJsonLine(paths.approvals(proposal.ruleId), approval);

  const updated = await updateProposal(paths, proposal.ruleId, proposal.id, { applied: 'rejected' });
  return { approval, proposal: updated };
}

function parseApprovalLine(raw: unknown, where: string): ApprovalRecord {
  if (typeof raw !== 'object' || raw === null) throw new ValidationError(`${where}: 승인 기록 줄이 객체가 아니다`);
  const record = raw as Partial<ApprovalRecord>;
  if (typeof record.ruleId !== 'string' || typeof record.proposalId !== 'string' || typeof record.at !== 'string') {
    throw new ValidationError(`${where}: 승인 기록 줄에 ruleId · proposalId · at이 없다`);
  }
  if (record.action !== 'propose' && record.action !== 'approve' && record.action !== 'reject') {
    throw new ValidationError(`${where}: 승인 기록 줄의 action이 propose · approve · reject 중 하나가 아니다`);
  }
  return record as ApprovalRecord;
}

/** 규칙 하나의 승인 이력 (파일 순서 = 시간 순서). 없으면 빈 배열 */
export async function listApprovals(paths: StorePaths, ruleId: RuleId): Promise<ApprovalRecord[]> {
  const path = paths.approvals(ruleId);
  return (await readJsonLines(path)).map((line) => parseApprovalLine(line, path));
}

/** 모든 규칙의 승인 이력. `status()`가 마지막 승인의 해시를 찾는 데 쓴다 */
export async function listAllApprovals(paths: StorePaths): Promise<ApprovalRecord[]> {
  const records: ApprovalRecord[] = [];
  for (const file of await listFiles(paths.approvalsDir, '.jsonl')) {
    const path = `${paths.approvalsDir}/${file}`;
    for (const line of await readJsonLines(path)) records.push(parseApprovalLine(line, path));
  }
  return records;
}
