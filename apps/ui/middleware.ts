import { type NextRequest, NextResponse } from 'next/server';
import { COOKIE, isValidSession, unauthorizedBody } from '@/lib/auth';

/**
 * 세션 쿠키 검사 (`docs/screens/README.md` 3.2 6단계). `/api/**` 전부와 `/views` `/rules` `/runs` 페이지에 건다.
 *
 * - 쿠키가 없거나 틀리면: API는 `401 { code: 'UNAUTHORIZED', message }`, 페이지는 `/no-session`으로 rewrite
 * - `/auth`(쿠키를 심는 곳) · `/no-session` · 정적 파일은 matcher 밖이다
 * - 토큰이 환경에 없으면 `isValidSession`이 항상 거짓 → 전부 401. 열어 두지 않는다
 *
 * 이것이 기획안 §15.1 "에이전트는 승인할 수 없다"의 절반이다: 에이전트가 셸에서 `curl 127.0.0.1:4817/api/...`를 불러도
 * 쿠키가 없어 401. 토큰 파일은 `~/.plumb/run/<project>/ui.json`(0600)에만 있다.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const cookie = request.cookies.get(COOKIE)?.value;
  if (await isValidSession(cookie)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(unauthorizedBody(), { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/no-session';
  url.search = '';
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/api/:path*', '/views/:path*', '/rules/:path*', '/runs/:path*', '/views', '/rules', '/runs'],
};
