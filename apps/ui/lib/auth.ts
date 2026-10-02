/**
 * 승인 통로의 토큰·쿠키 (이슈 #33, `docs/screens/README.md` 3.2 흐름 5~6단계).
 *
 * - 토큰 T는 `plumb ui`가 만들어 환경변수 `PLUMB_UI_TOKEN`으로만 넘긴다. 이 모듈은 그것을 읽을 뿐 만들지 않는다
 * - 쿠키 `plumb_session`의 값은 T 자체가 아니라 `sha256(T)`다. 쿠키가 새어도 `/auth?token=`을 다시 쓸 수 없다
 * - 비교는 상수 시간. 길이가 다르면 바로 거짓 (길이는 비밀이 아니다 — 둘 다 hex 64자)
 * - 토큰이 환경에 없으면(개발 중 `next dev`를 직접 띄운 경우) **모든 요청이 401**이다. 열어 두지 않는다
 *
 * 미들웨어(Edge 런타임)와 route handler(Node)가 같이 쓰므로 `node:crypto`가 아니라 Web Crypto만 쓴다.
 */

/** 세션 쿠키 이름 */
export const COOKIE = 'plumb_session';

/** 환경변수 이름. `plumb ui`가 자식 프로세스에 넘긴다 */
export const TOKEN_ENV = 'PLUMB_UI_TOKEN';

/** 쿠키 속성 (`httpOnly · SameSite=Strict · Path=/`). `secure`는 127.0.0.1 http 이므로 없다 */
export const COOKIE_ATTRIBUTES = { httpOnly: true, sameSite: 'strict', path: '/' } as const;

/** 401 본문. `code`는 이슈 #33 그대로 (`UNAUTHORIZED`), `message`는 work-approve 4절 문구 */
export const NO_SESSION_MESSAGE = '세션이 없습니다. `plumb ui` 를 다시 시작하면 브라우저가 `/auth` 로 열립니다';

export interface UnauthorizedBody {
  status: 401;
  code: 'UNAUTHORIZED';
  message: string;
}

export function unauthorizedBody(): UnauthorizedBody {
  return { status: 401, code: 'UNAUTHORIZED', message: NO_SESSION_MESSAGE };
}

/** 지금 프로세스의 토큰. 비어 있으면 `undefined` (= 전부 401) */
export function getToken(): string | undefined {
  const token = process.env[TOKEN_ENV];
  return token !== undefined && token.length > 0 ? token : undefined;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 상수 시간 문자열 비교. 길이가 다르면 거짓. 같은 길이면 모든 바이트를 끝까지 본다 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

let cache: { token: string; hash: string } | undefined;

/** 올바른 쿠키 값 = `sha256(토큰)`. 토큰이 없으면 `undefined` */
export async function expectedCookieValue(): Promise<string | undefined> {
  const token = getToken();
  if (token === undefined) return undefined;
  if (cache === undefined || cache.token !== token) cache = { token, hash: await sha256Hex(token) };
  return cache.hash;
}

/** `/auth?token=` 의 값이 맞는가 */
export async function isValidToken(candidate: string | null | undefined): Promise<boolean> {
  const token = getToken();
  if (token === undefined || candidate === null || candidate === undefined) return false;
  return timingSafeEqual(candidate, token);
}

/** 쿠키 값이 맞는가 */
export async function isValidSession(cookieValue: string | null | undefined): Promise<boolean> {
  const expected = await expectedCookieValue();
  if (expected === undefined || cookieValue === null || cookieValue === undefined) return false;
  return timingSafeEqual(cookieValue, expected);
}
