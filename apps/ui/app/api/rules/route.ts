import type { ApiError, RuleListResponse } from '@plumb/core';
import { NextResponse } from 'next/server';
import { readRuleList } from '@/lib/rules';
import { fromStoreError } from '@/lib/rules-api';

export const dynamic = 'force-dynamic';

/** `GET /api/rules` — 규칙 목록 + 머리줄 (README 3.3, work-approve 3.1). 400 `rules-parse-error`. 거르기는 받는 쪽에서 */
export async function GET(): Promise<NextResponse<RuleListResponse | ApiError>> {
  try {
    return NextResponse.json(await readRuleList());
  } catch (error) {
    return fromStoreError(error);
  }
}
