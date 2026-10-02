/**
 * 제안 `proposals/<ruleId>/<p-id>.json` (docs/types/README work-approve 1번). 에이전트(rule-drafter)와 CLI `rule propose`가
 * 저장소에 쓰는 **유일한** 경로다. `rules.yaml`에는 손대지 않는다 — 그것은 `approvals.ts`의 `approve()`만 한다.
 *
 * `before` · `after`는 YAML 축약(`checks: [경로]`, `depends_on` 생략)도 받아 {@link Rule}로 정규화해 저장한다.
 */

import { z } from 'zod';
import type { Proposal, ProposalId, RuleId, RunId } from '../types/index.js';
import { ProposalNotFoundError, ValidationError } from './errors.js';
import { canonicalJson, listDirs, listFiles, readJsonFile, sha256, writeJsonAtomic } from './fs.js';
import { PROPOSAL_ID_PATTERN, type StorePaths } from './paths.js';
import { normalizeRule, ruleIdSchema, ruleYamlSchema } from './rules.js';

export const proposalIdSchema = z.custom<ProposalId>(
  (value) => typeof value === 'string' && PROPOSAL_ID_PATTERN.test(value),
  { message: '제안 ID는 p-… 형식' },
);

const runIdSchema = z.custom<RunId>((value) => typeof value === 'string' && /^r-.+$/.test(value), {
  message: '실행 ID는 r-… 형식',
});

export const proposalChangeKindSchema = z.enum(['add', 'strengthen', 'relax', 'delete', 'boundary']);

export const proposalAppliedSchema = z.enum(['provisional', 'pending', 'applied', 'rejected']);

/** 제안 JSON. 출력은 {@link Proposal}에 대입 가능하다 (`before` · `after`는 정규화된 `Rule`) */
export const proposalSchema = z
  .object({
    id: proposalIdSchema,
    ruleId: ruleIdSchema,
    changeKind: proposalChangeKindSchema,
    proposedBy: z.union([runIdSchema, z.literal('cli')]),
    proposedAt: z.string().datetime({ offset: true }),
    before: ruleYamlSchema.transform(normalizeRule).optional(),
    after: ruleYamlSchema.transform(normalizeRule).nullable(),
    requiresPriorApproval: z.boolean(),
    applied: proposalAppliedSchema,
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (proposal.changeKind === 'delete' && proposal.after !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: '삭제 제안의 after는 null' });
    }
    if (proposal.changeKind !== 'delete' && proposal.after === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['after'],
        message: `${proposal.changeKind} 제안에는 after가 있어야 한다`,
      });
    }
    if (proposal.changeKind === 'add' && proposal.before !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['before'], message: '추가 제안에는 before가 없다' });
    }
    if (proposal.after !== null && proposal.after.id !== proposal.ruleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['after', 'id'],
        message: `after.id(${proposal.after.id})가 ruleId(${proposal.ruleId})와 다르다`,
      });
    }
    if (proposal.before !== undefined && proposal.before.id !== proposal.ruleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['before', 'id'],
        message: `before.id(${proposal.before.id})가 ruleId(${proposal.ruleId})와 다르다`,
      });
    }
  }) satisfies z.ZodType<Proposal, z.ZodTypeDef, unknown>;

/** 제안 내용의 해시 (`Approval.proposalHash`, API 409 `proposal-changed` 판정). 키 순서와 무관하다 */
export function hashProposal(proposal: Proposal): string {
  return sha256(canonicalJson(proposal));
}

function parseProposal(raw: unknown, where: string): Proposal {
  const result = proposalSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: 제안이 스키마에 맞지 않는다`, result.error.issues);
  }
  return result.data;
}

/** 검증 뒤 `proposals/<ruleId>/<id>.json`에 쓴다 (원자적). 같은 ID가 있으면 덮어쓴다. 돌려주는 값은 정규화된 제안 */
export async function writeProposal(paths: StorePaths, input: unknown): Promise<Proposal> {
  const proposal = parseProposal(input, '입력');
  await writeJsonAtomic(paths.proposal(proposal.ruleId, proposal.id), proposal);
  return proposal;
}

/** 없으면 `undefined`. 파일이 있는데 모양이 다르면 {@link ValidationError} */
export async function getProposal(
  paths: StorePaths,
  ruleId: RuleId,
  proposalId: ProposalId,
): Promise<Proposal | undefined> {
  const path = paths.proposal(ruleId, proposalId);
  const raw = await readJsonFile(path);
  if (raw === undefined) return undefined;
  return parseProposal(raw, path);
}

/** 규칙 하나 또는 전체의 제안. `proposedAt` 오름차순, 같으면 ID 순 */
export async function listProposals(paths: StorePaths, ruleId?: RuleId): Promise<Proposal[]> {
  const ruleIds = ruleId === undefined ? ((await listDirs(paths.proposalsDir)) as RuleId[]) : [ruleId];
  const proposals: Proposal[] = [];
  for (const id of ruleIds) {
    const dir = paths.proposalDir(id);
    for (const file of await listFiles(dir, '.json')) {
      const raw = await readJsonFile(`${dir}/${file}`);
      if (raw !== undefined) proposals.push(parseProposal(raw, `${dir}/${file}`));
    }
  }
  return proposals.sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id));
}

/**
 * 적용 상태 갱신. **모듈 내부용** — `approvals.ts`의 `approve()` · `reject()`가 부른다. `store/index.ts`는 재export하지 않는다.
 * 제안이 없으면 {@link ProposalNotFoundError}
 */
export async function updateProposal(
  paths: StorePaths,
  ruleId: RuleId,
  proposalId: ProposalId,
  patch: Partial<Pick<Proposal, 'applied' | 'requiresPriorApproval'>>,
): Promise<Proposal> {
  const current = await getProposal(paths, ruleId, proposalId);
  if (current === undefined) throw new ProposalNotFoundError(ruleId, proposalId);
  const next: Proposal = { ...current, ...patch };
  await writeJsonAtomic(paths.proposal(ruleId, proposalId), next);
  return next;
}
