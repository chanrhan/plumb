import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as authGet } from '../app/auth/route';
import { COOKIE, isValidSession, isValidToken, sha256Hex, timingSafeEqual, unauthorizedBody } from '../lib/auth';
import { config, middleware } from '../middleware';

const TOKEN = 'a'.repeat(64);
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const BASE = 'http://127.0.0.1:4817';

function request(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie !== undefined) headers.set('cookie', `${COOKIE}=${cookie}`);
  return new NextRequest(`${BASE}${path}`, { headers });
}

beforeEach(() => {
  process.env.PLUMB_UI_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.PLUMB_UI_TOKEN;
});

describe('lib/auth', () => {
  it('쿠키 값은 토큰 자체가 아니라 sha256(토큰)', async () => {
    expect(await sha256Hex(TOKEN)).toBe(HASH);
    expect(await isValidSession(HASH)).toBe(true);
    expect(await isValidSession(TOKEN)).toBe(false);
  });

  it('timingSafeEqual: 같으면 참, 한 글자만 달라도 거짓, 길이가 다르면 거짓', () => {
    expect(timingSafeEqual(TOKEN, TOKEN)).toBe(true);
    expect(timingSafeEqual(TOKEN, `${'a'.repeat(63)}b`)).toBe(false);
    expect(timingSafeEqual(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('토큰이 환경에 없으면 어떤 값도 맞지 않는다 (열어 두지 않는다)', async () => {
    delete process.env.PLUMB_UI_TOKEN;
    expect(await isValidToken(TOKEN)).toBe(false);
    expect(await isValidToken('')).toBe(false);
    expect(await isValidSession(HASH)).toBe(false);
    expect(await isValidSession(undefined)).toBe(false);
  });
});

describe('middleware — /api/**', () => {
  it('matcher 는 /api/** 와 /views · /rules · /runs 를 덮고 /auth · /no-session 은 밖이다', () => {
    expect(config.matcher).toEqual([
      '/api/:path*',
      '/views/:path*',
      '/rules/:path*',
      '/runs/:path*',
      '/views',
      '/rules',
      '/runs',
    ]);
    expect(config.matcher.some((m) => m.startsWith('/auth'))).toBe(false);
    expect(config.matcher.some((m) => m.startsWith('/no-session'))).toBe(false);
  });

  it('쿠키 없음 → 401 JSON { code: UNAUTHORIZED }', async () => {
    const response = await middleware(request('/api/status'));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual(unauthorizedBody());
    expect(unauthorizedBody().code).toBe('UNAUTHORIZED');
    expect(unauthorizedBody().message).toContain('plumb ui');
  });

  it('틀린 쿠키 → 401. 토큰 자체를 쿠키에 넣어도 401', async () => {
    expect((await middleware(request('/api/status', 'b'.repeat(64)))).status).toBe(401);
    expect((await middleware(request('/api/rules/pay.refund-window/approve', TOKEN))).status).toBe(401);
  });

  it('맞는 쿠키 → NextResponse.next()', async () => {
    const response = await middleware(request('/api/status', HASH));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('토큰이 환경에 없으면 맞는 쿠키도 401', async () => {
    delete process.env.PLUMB_UI_TOKEN;
    expect((await middleware(request('/api/status', HASH))).status).toBe(401);
  });
});

describe('middleware — 페이지', () => {
  it('쿠키 없는 /views · /rules · /runs 는 /no-session 으로 rewrite (쿼리는 버린다)', async () => {
    for (const path of ['/views?view=flow', '/rules/pay.refund-window', '/runs']) {
      const response = await middleware(request(path));
      const rewrite = new URL(response.headers.get('x-middleware-rewrite') ?? '');
      expect(rewrite.pathname).toBe('/no-session');
      expect(rewrite.search).toBe('');
      expect(response.headers.get('x-middleware-next')).toBeNull();
    }
  });

  it('맞는 쿠키면 통과', async () => {
    const response = await middleware(request('/rules', HASH));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('GET /auth?token=', () => {
  it('틀린 토큰 → 401 텍스트, 쿠키 없음', async () => {
    const response = await authGet(request('/auth?token=wrong'));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('plumb ui');
  });

  it('토큰 없음 → 401', async () => {
    expect((await authGet(request('/auth'))).status).toBe(401);
  });

  it('맞는 토큰 → 302 /views + Set-Cookie plumb_session=<sha256>; HttpOnly; SameSite=Strict; Path=/', async () => {
    const response = await authGet(request(`/auth?token=${TOKEN}`));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/views');

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${COOKIE}=${HASH}`);
    expect(setCookie).not.toContain(TOKEN);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
    expect(setCookie.toLowerCase()).toContain('path=/');

    // 심긴 쿠키로 미들웨어를 통과한다 (흐름 6단계)
    const next = await middleware(request('/api/status', HASH));
    expect(next.headers.get('x-middleware-next')).toBe('1');
  });

  it('토큰이 환경에 없으면 어떤 토큰도 401', async () => {
    delete process.env.PLUMB_UI_TOKEN;
    expect((await authGet(request(`/auth?token=${TOKEN}`))).status).toBe(401);
    expect((await authGet(request('/auth?token='))).status).toBe(401);
  });
});
