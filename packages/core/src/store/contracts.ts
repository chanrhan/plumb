/**
 * 계약 해시 기록 `contracts/<파일>.json` (이슈 #55, 기획안 §5.1 "계약 파일은 레포에, 해시는 보호 저장소에",
 * view-data-contract 3절 "승인된 해시 · 승인 ID · 시각", 6절 1번).
 *
 * - 파일 하나당 기록 하나. 승인하면 덮어쓴다 — 이력은 결정 기록(`decision`)과 git에 있다
 * - 파일 이름은 계약 파일의 레포 상대 경로에서 `/`를 `__`로 바꾼 것 (`paths.contract()`): `prisma__schema.prisma.json`
 * - 승인 통로(UI · CLI)는 M10. 여기는 코어 API뿐이다 — `store.contracts.approve()`
 */

import { z } from 'zod';
import type { ContractApproval } from '../types/index.js';
import { ValidationError } from './errors.js';
import { listFiles, readJsonFile, writeJsonAtomic } from './fs.js';
import type { StorePaths } from './paths.js';
import { decisionIdSchema } from './rules.js';

/** 내용 SHA-256 (16진 64자) */
export const CONTRACT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 저장되는 기록. `ContractApproval` + 승인자 `by` (UI 토큰 세션이면 `ui`, CLI면 OS 사용자 이름 — `approvals.jsonl`과 같은 규약).
 * `by`는 공유 타입에 없다 — 타입 보완 후보 (PR에 적는다).
 */
export interface ContractApprovalRecord extends ContractApproval {
  by: string;
}

export interface ApproveContractInput {
  /** 계약 파일의 레포 상대 경로 (`prisma/schema.prisma` · `openapi.yaml`). 앞의 `./`는 뗀다 */
  path: string;
  /** 승인하는 내용의 SHA-256 — 어댑터 `SchemaFile.hash`를 그대로 */
  hash: string;
  /** 그 내용이 있는 커밋 (40자 또는 축약). diff의 기준이 된다 */
  commit: string;
  decision?: ContractApproval['decision'];
  by: string;
}

export interface ContractStoreOptions {
  now?: () => Date;
}

export const contractApprovalSchema = z
  .object({
    path: z.string().min(1),
    hash: z.string().regex(CONTRACT_HASH_PATTERN, '계약 해시는 SHA-256 16진 64자'),
    approvedAt: z.string().datetime({ offset: true }),
    decision: decisionIdSchema.optional(),
    commit: z.string().min(1),
    by: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ContractApprovalRecord, z.ZodTypeDef, unknown>;

const approveInputSchema = z
  .object({
    path: z.string().min(1),
    hash: z.string().regex(CONTRACT_HASH_PATTERN, '계약 해시는 SHA-256 16진 64자'),
    commit: z.string().min(1),
    decision: decisionIdSchema.optional(),
    by: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ApproveContractInput, z.ZodTypeDef, unknown>;

/** `./openapi.yaml` → `openapi.yaml`. 저장소 키와 어댑터 `SchemaFile.path`를 같은 모양으로 */
export function normalizeContractPath(path: string): string {
  return path.replace(/^\.?\//, '').replace(/\\/g, '/');
}

function parseRecord(raw: unknown, where: string): ContractApprovalRecord {
  const result = contractApprovalSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: 계약 해시 기록이 스키마에 맞지 않는다`, result.error.issues);
  }
  return result.data;
}

/** `contracts/<파일>.json`. 없으면 `undefined` */
export async function getContractApproval(
  paths: StorePaths,
  contractPath: string,
): Promise<ContractApprovalRecord | undefined> {
  const file = paths.contract(normalizeContractPath(contractPath));
  const raw = await readJsonFile(file);
  return raw === undefined ? undefined : parseRecord(raw, file);
}

/** 기록 전부, 계약 파일 경로순. 폴더가 없으면 빈 배열 */
export async function listContractApprovals(paths: StorePaths): Promise<ContractApprovalRecord[]> {
  const records: ContractApprovalRecord[] = [];
  for (const file of await listFiles(paths.contractsDir, '.json')) {
    const full = `${paths.contractsDir}/${file}`;
    const raw = await readJsonFile(full);
    if (raw !== undefined) records.push(parseRecord(raw, full));
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 계약 파일의 현재 해시를 승인한다 → `contracts/<파일>.json` 원자적 쓰기 (있으면 덮어쓴다).
 * 입력은 검증된다 — 해시 모양이 어긋나면 {@link ValidationError}. 파일 내용이 정말 그 해시인지는 여기서 확인하지 않는다
 * (저장소는 레포를 읽지 않는다). 호출자가 어댑터 `readSchemas()`의 `hash`를 넘긴다.
 */
export async function approveContract(
  paths: StorePaths,
  input: ApproveContractInput,
  options: ContractStoreOptions = {},
): Promise<ContractApprovalRecord> {
  const parsed = approveInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('contracts.approve: 입력이 스키마에 맞지 않는다', parsed.error.issues);
  }
  const now = options.now ?? (() => new Date());
  const path = normalizeContractPath(parsed.data.path);
  const record: ContractApprovalRecord = {
    path,
    hash: parsed.data.hash,
    approvedAt: now().toISOString(),
    commit: parsed.data.commit,
    by: parsed.data.by,
  };
  if (parsed.data.decision !== undefined) record.decision = parsed.data.decision;
  await writeJsonAtomic(paths.contract(path), record);
  return record;
}
