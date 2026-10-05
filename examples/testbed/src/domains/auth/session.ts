// auth 도메인 로직. 외부 의존 없음 — 두 번째 슬라이스(#119)는 DB 없는 순수 블록이 같은 파이프라인을 지나는지 본다.
import type { Session, SessionToken } from './types';

export class SessionExpiredError extends Error {
  readonly userId: string;
  readonly expiresAt: Date;

  constructor(token: SessionToken, now: Date) {
    super(`session expired: user ${token.userId} at ${token.expiresAt.toISOString()} (now ${now.toISOString()})`);
    this.name = 'SessionExpiredError';
    this.userId = token.userId;
    this.expiresAt = token.expiresAt;
  }
}

/**
 * 세션 토큰을 검증해 세션을 돌려준다.
 *
 * 의도적으로 만료 검사가 없다. 규칙 auth.session-expiry 위반 상태 = 두 번째 슬라이스 출발점 (기획안 §8.3 · 첫 슬라이스의 refund()와 같은 구도).
 * 토큰이 있으면 expiresAt이 지났든 아니든 세션을 만든다.
 */
export function verifySession(token: SessionToken, now: Date = new Date()): Session {
  return {
    userId: token.userId,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    verifiedAt: now,
  };
}
