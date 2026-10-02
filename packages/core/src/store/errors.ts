/**
 * 보호 저장소 오류. 호출자(CLI #32 · UI 서버 #33 #34)가 `instanceof`로 구분해 메시지 · 종료 코드 · HTTP 상태를 정한다.
 * `types/api.ts`의 `ApiError` 코드와 대응: `RulesParseError` → 400 `rules-parse-error`, `ValidationError`(기각 사유 없음) → 400
 * `reason-required`, `RuleNotFoundError` → 404 `rule-not-found`, `ProposalNotFoundError` → 404 `proposal-not-found`,
 * `ProposalChangedError` → 409 `proposal-changed`.
 */

import type { ZodIssue } from 'zod';
import { formatIssue } from '../config/load.js';

/** 저장소 오류의 공통 조상 */
export class StoreError extends Error {
  override readonly name: string = 'StoreError';
}

/** 저장소 파일이 없다. `init()`을 먼저 불러야 한다 */
export class StoreNotInitializedError extends StoreError {
  override readonly name = 'StoreNotInitializedError';
  constructor(readonly path: string) {
    super(`${path}: 보호 저장소가 초기화되지 않았다. store.init()을 먼저 부른다`);
  }
}

/** `rules.yaml`이 YAML로 읽히지 않는다. `line`은 첫 오류의 줄 번호 (work-approve 4절 → API 400 `rules-parse-error`) */
export class RulesParseError extends StoreError {
  override readonly name = 'RulesParseError';
  constructor(
    readonly path: string,
    readonly line: number | undefined,
    override readonly cause: unknown,
  ) {
    super(
      `${path}${line === undefined ? '' : `:${line}`}: rules.yaml을 읽을 수 없다 — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** YAML은 맞지만 규칙 스키마에 어긋난다. 메시지에 위반 하나당 `경로: 메시지` 한 줄 */
export class RulesValidationError extends StoreError {
  override readonly name = 'RulesValidationError';
  constructor(
    readonly path: string,
    readonly issues: readonly ZodIssue[],
  ) {
    super(`${path}: rules.yaml이 스키마에 맞지 않는다\n${issues.map((issue) => `  ${formatIssue(issue)}`).join('\n')}`);
  }
}

/** 입력이 성립하지 않는다 — 제안 JSON이 스키마에 어긋남, 기각 사유 비어 있음, 이미 처리된 제안 등 */
export class ValidationError extends StoreError {
  override readonly name = 'ValidationError';
  constructor(
    message: string,
    readonly issues: readonly ZodIssue[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${issues.map((issue) => `  ${formatIssue(issue)}`).join('\n')}` : message);
  }
}

export class RuleNotFoundError extends StoreError {
  override readonly name = 'RuleNotFoundError';
  constructor(readonly ruleId: string) {
    super(`규칙 ${ruleId}이(가) rules.yaml에 없다`);
  }
}

export class ProposalNotFoundError extends StoreError {
  override readonly name = 'ProposalNotFoundError';
  constructor(
    readonly ruleId: string,
    readonly proposalId: string,
  ) {
    super(`규칙 ${ruleId}의 제안 ${proposalId}이(가) 없다`);
  }
}

/** 호출자가 본 제안과 저장된 제안의 해시가 다르다 (work-approve 4절 → API 409 `proposal-changed`) */
export class ProposalChangedError extends StoreError {
  override readonly name = 'ProposalChangedError';
  constructor(
    readonly ruleId: string,
    readonly proposalId: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`규칙 ${ruleId}의 제안 ${proposalId}이(가) 바뀌었다. 다시 읽는다`);
  }
}
