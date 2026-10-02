// Route Handler용 JSON 응답·오류·요청 검증 헬퍼. route.ts를 얇게 유지하기 위한 것이며 비즈니스 로직은 없다.
// 검증은 zod 없이 수동으로 한다 — 요청 본문이 필드 한두 개뿐이라 의존성을 더할 이유가 없다 (#20).
import { NextResponse } from 'next/server';

/** openapi.yaml `components.schemas.Error.code` */
export type ErrorCode = 'VALIDATION_ERROR' | 'PAYMENT_NOT_FOUND' | 'REFUND_WINDOW_EXCEEDED' | 'INTERNAL_ERROR';

/** openapi.yaml `components.schemas.Error` */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
}

export function json<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export function error(status: number, code: ErrorCode, message: string): NextResponse<ErrorBody> {
  return NextResponse.json({ code, message }, { status });
}

/** 요청 검증 실패. `handleUnexpected`가 400 `VALIDATION_ERROR`로 매핑한다 */
export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** 요청 본문을 JSON 객체로 읽는다. JSON이 아니거나 객체가 아니면 ValidationError */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError('body', 'JSON 본문이 필요합니다');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('body', 'JSON 객체여야 합니다');
  }
  return parsed as Record<string, unknown>;
}

/** `type: integer, minimum` */
export function requireInteger(body: Record<string, unknown>, field: string, options: { min?: number } = {}): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(field, '정수여야 합니다');
  }
  if (options.min !== undefined && value < options.min) {
    throw new ValidationError(field, `${options.min} 이상이어야 합니다`);
  }
  return value;
}

/** `type: string, minLength, maxLength` */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  options: { minLength?: number; maxLength?: number } = {},
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new ValidationError(field, '문자열이어야 합니다');
  }
  if (options.minLength !== undefined && value.length < options.minLength) {
    throw new ValidationError(field, `${options.minLength}자 이상이어야 합니다`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(field, `${options.maxLength}자 이하여야 합니다`);
  }
  return value;
}

/**
 * 핸들러 공통 예외 매핑. ValidationError → 400, 그 외 → 500.
 * 도메인 오류(예: PaymentNotFoundError → 404)는 각 route가 먼저 잡고, 나머지를 여기로 넘긴다.
 */
export function handleUnexpected(err: unknown): NextResponse<ErrorBody> {
  if (err instanceof ValidationError) {
    return error(400, 'VALIDATION_ERROR', err.message);
  }
  console.error(err);
  return error(500, 'INTERNAL_ERROR', '처리 중 오류가 발생했습니다');
}
