import { type NextRequest, NextResponse } from 'next/server';
import { COOKIE, COOKIE_ATTRIBUTES, expectedCookieValue, isValidToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * `GET /auth?token=<T>` (`docs/screens/README.md` 3.2 5단계). `plumb ui`가 브라우저를 여기로 연다.
 *
 * - T가 맞으면 `Set-Cookie: plumb_session=<sha256(T)>; HttpOnly; SameSite=Strict; Path=/` + 302 `/views`.
 *   T는 URL에서 사라진다 (주소창에는 `/views`만 남는다)
 * - 틀리거나 없으면 401 텍스트. 토큰 재발급은 `plumb ui` 재시작뿐
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get('token');
  const hash = await expectedCookieValue();

  if (hash === undefined || !(await isValidToken(token))) {
    return new NextResponse('401 토큰이 맞지 않습니다. `plumb ui` 를 다시 시작하면 새 주소가 열립니다\n', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // Location은 상대 경로로 — 호스트를 다시 쓰지 않는다 (요청이 온 127.0.0.1:<port> 그대로)
  const response = new NextResponse(null, { status: 302, headers: { location: '/views' } });
  response.cookies.set({ name: COOKIE, value: hash, ...COOKIE_ATTRIBUTES });
  return response;
}
