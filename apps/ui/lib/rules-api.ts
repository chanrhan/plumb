/**
 * 규칙 API route handler의 공통 부분 (이슈 #34, screens/README 3.3). 응답 · 오류 본문은 `packages/core/src/types/api.ts` 그대로.
 *
 * 인증은 하지 않는다 — `/api/**`의 토큰 쿠키 검사는 #33의 미들웨어가 맡는다 (README 3.2). 여기 닿았으면 세션이 있는 것이다.
 * 코어 오류 → HTTP: `RulesParseError` 400 `rules-parse-error` · `ValidationError`(사유 없음) 400 `reason-required` ·
 * `RuleNotFoundError` 404 · `ProposalNotFoundError` 404 · `ProposalChangedError` 409 (store/errors.ts 머리 주석).
 */

import {
  type ApiError,
  type ApproveRequest,
  type ApproveResponse,
  type Proposal,
  ProposalChangedError,
  ProposalNotFoundError,
  type RejectRequest,
  type RejectResponse,
  RuleNotFoundError,
  RulesParseError,
  RulesValidationError,
  type Store,
  StoreNotInitializedError,
  ValidationError,
} from '@plumb/core';
import { NextResponse } from 'next/server';
import { isRuleId, type RuleEntry, readRuleEntry } from './rules';
import { getStore } from './store';

/** 승인자 — UI 토큰 세션 (`types/rules.ts` `Approval.by`) */
export const APPROVED_BY = 'ui';

export function apiError(error: ApiError): NextResponse<ApiError> {
  return NextResponse.json(error, { status: error.status });
}

export function ruleNotFound(id: string): NextResponse<ApiError> {
  return apiError({ status: 404, code: 'rule-not-found', message: `규칙 ${id}이(가) 없다` });
}

/** 코어 오류 → `ApiError`. 모르는 오류는 다시 던진다 (Next가 500으로) */
export function fromStoreError(error: unknown): NextResponse<ApiError> {
  if (error instanceof RulesParseError) {
    return apiError({
      status: 400,
      code: 'rules-parse-error',
      message: error.message,
      ...(error.line === undefined ? {} : { line: error.line }),
    });
  }
  if (error instanceof RulesValidationError || error instanceof StoreNotInitializedError) {
    return apiError({ status: 400, code: 'rules-parse-error', message: error.message });
  }
  if (error instanceof ProposalChangedError) {
    return apiError({ status: 409, code: 'proposal-changed', message: error.message });
  }
  if (error instanceof RuleNotFoundError) {
    return ruleNotFound(error.ruleId);
  }
  if (error instanceof ProposalNotFoundError) {
    return apiError({ status: 404, code: 'proposal-not-found', message: error.message });
  }
  if (error instanceof ValidationError) {
    return apiError({ status: 400, code: 'invalid-body', message: error.message });
  }
  throw error;
}

/** 승인 · 기각 요청 본문. `proposalId` 필수, `proposalHash`는 있으면 409 판정에 쓴다, `reason`은 기각에서 검사한다 */
interface ParsedBody {
  proposalId: ApproveRequest['proposalId'];
  proposalHash?: string;
  reason?: unknown;
}

async function parseBody(request: Request): Promise<ParsedBody | NextResponse<ApiError>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문이 JSON이 아니다' });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return apiError({ status: 400, code: 'invalid-body', message: '요청 본문은 객체여야 한다' });
  }
  const { proposalId, proposalHash, reason } = raw as Record<string, unknown>;
  if (typeof proposalId !== 'string' || !/^p-[\w-]+$/.test(proposalId)) {
    return apiError({ status: 400, code: 'invalid-body', message: 'proposalId(p-…)가 없다' });
  }
  if (proposalHash !== undefined && typeof proposalHash !== 'string') {
    return apiError({ status: 400, code: 'invalid-body', message: 'proposalHash는 문자열이어야 한다' });
  }
  return {
    proposalId: proposalId as ApproveRequest['proposalId'],
    ...(proposalHash === undefined ? {} : { proposalHash }),
    reason,
  };
}

interface Resolved {
  store: Store;
  entry: RuleEntry;
  pending: Proposal;
}

/**
 * 규칙과 미처리 제안을 찾는다. 규칙이 없으면 404. 미처리 제안이 없거나(이미 CLI에서 승인 · 기각) 화면이 보낸 `proposalId`와
 * 다르면(재제안) 409 `proposal-changed` → 화면은 다시 읽는다 (work-approve 4절)
 */
async function resolvePending(id: string, proposalId: string): Promise<Resolved | NextResponse<ApiError>> {
  if (!isRuleId(id)) return ruleNotFound(id);
  const store = await getStore();
  const entry = await readRuleEntry(store, id);
  if (entry === undefined) return ruleNotFound(id);
  if (entry.pending === undefined) {
    return apiError({
      status: 409,
      code: 'proposal-changed',
      message: `규칙 ${id}에 처리할 제안이 없다 (이미 승인 · 기각됐다). 다시 읽는다`,
    });
  }
  if (entry.pending.id !== proposalId) {
    return apiError({
      status: 409,
      code: 'proposal-changed',
      message: `규칙 ${id}의 제안이 ${proposalId}에서 ${entry.pending.id}(으)로 바뀌었다. 다시 읽는다`,
    });
  }
  return { store, entry, pending: entry.pending };
}

export async function handleApprove(request: Request, id: string): Promise<NextResponse<ApproveResponse | ApiError>> {
  const body = await parseBody(request);
  if (body instanceof NextResponse) return body;

  try {
    const resolved = await resolvePending(id, body.proposalId);
    if (resolved instanceof NextResponse) return resolved;
    const { store, pending } = resolved;

    const result = await store.approvals.approve({
      ruleId: pending.ruleId,
      proposalId: pending.id,
      by: APPROVED_BY,
      ...(body.proposalHash === undefined ? {} : { expectedProposalHash: body.proposalHash }),
    });
    const unconfirmed = (await store.status()).unconfirmed;
    if (!result.applied) {
      // 기획안 §9.1 사전 승인 — 코어는 아무것도 쓰지 않았다. 화면은 "사전 승인 필요 — M10"
      return NextResponse.json({
        requiresPriorApproval: true,
        approvalState: 'provisional',
        proposal: result.proposal,
        unconfirmed,
      });
    }
    return NextResponse.json({
      requiresPriorApproval: false,
      approval: result.approval,
      approvalState: 'approved',
      unconfirmed,
    });
  } catch (error) {
    return fromStoreError(error);
  }
}

export async function handleReject(request: Request, id: string): Promise<NextResponse<RejectResponse | ApiError>> {
  const body = await parseBody(request);
  if (body instanceof NextResponse) return body;

  // 사유 필수 (work-approve 3.2 "기각 사유", 6절 6번). 코어도 같은 검사를 하지만 본문 오류는 저장소를 열기 전에 돌려준다
  const reason = body.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return apiError({ status: 400, code: 'reason-required', message: '기각 사유(reason)가 비어 있다' });
  }
  const input: RejectRequest = {
    proposalId: body.proposalId,
    proposalHash: body.proposalHash ?? '',
    reason,
  };

  try {
    const resolved = await resolvePending(id, input.proposalId);
    if (resolved instanceof NextResponse) return resolved;
    const { store, pending } = resolved;

    const result = await store.approvals.reject({
      ruleId: pending.ruleId,
      proposalId: pending.id,
      by: APPROVED_BY,
      reason: input.reason,
      ...(body.proposalHash === undefined ? {} : { expectedProposalHash: body.proposalHash }),
    });
    const unconfirmed = (await store.status()).unconfirmed;
    return NextResponse.json({ approval: result.approval, approvalState: 'rejected', unconfirmed });
  } catch (error) {
    return fromStoreError(error);
  }
}
