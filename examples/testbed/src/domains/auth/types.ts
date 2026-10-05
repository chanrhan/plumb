// auth 도메인의 입력·출력 타입. 순수 값 객체 — DB · 프레임워크 타입은 여기 없다.

export interface SessionToken {
  userId: string;
  /** 발급 시각 */
  issuedAt: Date;
  /** 만료 시각. 이 시각 이전이어야 유효하다 (규칙 auth.session-expiry) */
  expiresAt: Date;
}

export interface Session {
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
  /** 검증한 시각 */
  verifiedAt: Date;
}
