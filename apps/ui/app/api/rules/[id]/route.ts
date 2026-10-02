import type { ApiError, RuleDetailResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import { isRuleId, readRuleDetail } from '@/lib/rules';
import { fromStoreError, ruleNotFound } from '@/lib/rules-api';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** `GET /api/rules/:id` — 규칙 하나 + 제안 diff + 승인 이력 + 결정 기록 자리 (work-approve 3.2). 404 `rule-not-found` */
export async function GET(
  _request: Request,
  { params }: Context,
): Promise<NextResponse<RuleDetailResponse | ApiError>> {
  const { id } = await params;
  if (!isRuleId(id)) return ruleNotFound(id);
  try {
    const detail = await readRuleDetail(id);
    if (detail === undefined) return ruleNotFound(id);
    return NextResponse.json(detail);
  } catch (error) {
    return fromStoreError(error);
  }
}
