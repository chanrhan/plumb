import { handleApprove } from '@/lib/rules-api';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * `POST /api/rules/:id/approve` — 승인 (work-approve 4절). 본문 `ApproveRequest`. 404 · 409 `proposal-changed` · 400 본문 오류.
 * 토큰 쿠키 검사는 #33 미들웨어. 승인자는 `ui`
 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return handleApprove(request, id);
}
