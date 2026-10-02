/**
 * 저장소 상태 (기획안 §10 "변조 방지가 아니라 변조 증거", screens/README 2 상단 바).
 *
 * 무결성: 승인 줄 중 가장 최근 것의 `rulesHash`와 현재 `rules.yaml` sha256을 비교한다.
 * - 같다 → `ok`
 * - 다르다 → `tampered` (승인 행위 없이 규칙 파일이 바뀌었다 — 최우선 경보)
 * - 승인 줄이 하나도 없다 → 파일이 `initStore`가 쓴 빈 문서 그대로면 `ok`, 아니면 `unverified`
 *   (방금 만든 저장소를 경보로 시작하지 않기 위해. 빈 문서 외의 내용은 어디서 왔는지 증명할 수 없으므로 unverified)
 *
 * 해시 체인(변경 로그 전체)은 M10. 여기서는 마지막 승인의 해시 하나만 본다.
 */

import type { Approval, CheckRun, LastCheck, StatusResponse } from '../types/index.js';
import { listAllApprovals } from './approvals.js';
import { latestCheckRun } from './checks.js';
import { listFiles, readJsonFile } from './fs.js';
import { EMPTY_RULES_HASH } from './init.js';
import type { StorePaths } from './paths.js';
import { listProposals } from './proposals.js';
import { readRulesFile } from './rules.js';

export type StoreIntegrity = CheckRun['storeStatus'];

export interface StoreStatus {
  project: string;
  status: StoreIntegrity;
  /** 현재 `rules.yaml`의 sha256 */
  rulesHash: string;
  /** 비교 대상 — 가장 최근 승인 줄의 `rulesHash`. 승인 기록이 없으면 null */
  lastApproval: Approval | null;
  /** `rules.yaml`의 규칙 수 */
  rulesCount: number;
  /** `rules.yaml`에 있고 마지막 승인 기록이 `approve`인 규칙 수 */
  approvedCount: number;
  /** ⚠ 미확인 — `applied: 'provisional'`인 제안 수 */
  unconfirmed: number;
  /** 미확인 제안 중 가장 오래된 것의 체류 일수. 미확인이 없으면 null */
  longestPendingDays: number | null;
  /** `checks/`의 최신 실행(`checks.latest()`)의 식별 `{ runId, commit, finishedAt }`. 없으면 null */
  lastCheck: LastCheck | null;
  /** 검토 대기열의 미처리 항목 수 (`resolvedAt` 없음). M3는 보통 0 */
  reviewQueue: number;
}

export interface StoreStatusOptions {
  /** 체류 일수 계산 기준 시각. 테스트가 바꾼다 */
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function latestApprovalWithHash(records: Approval[]): Approval | null {
  let latest: Approval | null = null;
  for (const record of records) {
    if (record.action !== 'approve' || record.rulesHash === undefined) continue;
    if (latest === null || record.at.localeCompare(latest.at) >= 0) latest = record;
  }
  return latest;
}

/** 규칙별 마지막 승인 줄 (action 무관) */
function latestByRule(records: Approval[]): Map<string, Approval> {
  const map = new Map<string, Approval>();
  for (const record of records) {
    const prev = map.get(record.ruleId);
    if (prev === undefined || record.at.localeCompare(prev.at) >= 0) map.set(record.ruleId, record);
  }
  return map;
}

/** `checks.latest()` → 상단 바 · View 머리말이 쓰는 식별 세 필드 */
async function readLastCheck(paths: StorePaths): Promise<LastCheck | null> {
  const latest = await latestCheckRun(paths);
  return latest === null ? null : { runId: latest.runId, commit: latest.commit, finishedAt: latest.finishedAt };
}

async function countOpenReviewQueue(paths: StorePaths): Promise<number> {
  let open = 0;
  for (const file of await listFiles(paths.reviewQueueDir, '.json')) {
    const raw = await readJsonFile(`${paths.reviewQueueDir}/${file}`);
    if (typeof raw === 'object' && raw !== null && (raw as { resolvedAt?: unknown }).resolvedAt === undefined)
      open += 1;
  }
  return open;
}

export async function storeStatus(paths: StorePaths, options: StoreStatusOptions = {}): Promise<StoreStatus> {
  const now = (options.now ?? (() => new Date()))();
  const rulesFile = await readRulesFile(paths);
  const approvals = await listAllApprovals(paths);
  const lastApproval = latestApprovalWithHash(approvals);

  let status: StoreIntegrity;
  if (lastApproval === null) {
    status = rulesFile.hash === EMPTY_RULES_HASH ? 'ok' : 'unverified';
  } else {
    status = lastApproval.rulesHash === rulesFile.hash ? 'ok' : 'tampered';
  }

  const latest = latestByRule(approvals);
  const approvedCount = rulesFile.rules.filter((rule) => latest.get(rule.id)?.action === 'approve').length;

  const provisional = (await listProposals(paths)).filter((proposal) => proposal.applied === 'provisional');
  const oldest = provisional.reduce<number | null>((min, proposal) => {
    const t = Date.parse(proposal.proposedAt);
    return Number.isNaN(t) ? min : min === null || t < min ? t : min;
  }, null);
  const longestPendingDays = oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest) / DAY_MS));

  return {
    project: paths.project,
    status,
    rulesHash: rulesFile.hash,
    lastApproval,
    rulesCount: rulesFile.rules.length,
    approvedCount,
    unconfirmed: provisional.length,
    longestPendingDays,
    lastCheck: await readLastCheck(paths),
    reviewQueue: await countOpenReviewQueue(paths),
  };
}

/** `GET /api/status` 응답 (`types/api.ts` `StatusResponse`) */
export function toStatusResponse(status: StoreStatus): StatusResponse {
  return {
    project: status.project,
    store: { status: status.status },
    ...(status.lastCheck === null
      ? {}
      : { lastCheck: { commit: status.lastCheck.commit, finishedAt: status.lastCheck.finishedAt } }),
    unconfirmed: {
      total: status.unconfirmed + status.reviewQueue,
      provisionalRules: status.unconfirmed,
      reviewQueue: status.reviewQueue,
    },
  };
}
