import { handleReject } from '@/lib/rules-api';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** `POST /api/rules/:id/reject` — 기각 + 사유 (work-approve 4절). 본문 `RejectRequest`. 400 `reason-required` · 404 · 409 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return handleReject(request, id);
}
