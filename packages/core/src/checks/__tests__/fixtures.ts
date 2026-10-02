import type { BlockGraph } from '../../adapter/types.js';
import type {
  BlockNode,
  CheckFailure,
  CheckRef,
  CheckResult,
  Rule,
  RuleId,
  RuleStatus,
  RuleStatusRecord,
} from '../../types/index.js';

export const NOW = new Date('2026-10-02T09:00:00.000Z');
export const EARLIER = '2026-09-20T09:00:00.000Z';
export const COMMIT = 'a1b2c3d4e5f6';

export const REFUND_CHECK: CheckRef = { kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' };
export const RECORD_CHECK: CheckRef = { kind: 'acceptance', ref: 'test/acceptance/payment-record.spec.ts' };
export const STATIC_CHECK: CheckRef = { kind: 'static', ref: 'depcruise:block-1-public-entry-only' };

export function rule(id: RuleId, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    block: 'payment',
    kind: 'business',
    statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
    source: 'plan:PAY-02',
    risk: 'normal',
    depends_on: [],
    checks: [REFUND_CHECK],
    ...overrides,
  };
}

export function failure(check: CheckRef, overrides: Partial<CheckFailure> = {}): CheckFailure {
  return {
    check,
    anchor: { block: 'payment', file: check.ref, line: 42 },
    message: 'expected 7 to be 30',
    ...overrides,
  };
}

export function result(
  check: CheckRef,
  outcome: CheckResult['outcome'],
  overrides: Partial<CheckResult> = {},
): CheckResult {
  const failed = outcome === 'fail' || outcome === 'error';
  return {
    check,
    ruleIds: [],
    outcome,
    ...(failed ? { failure: failure(check) } : {}),
    ...overrides,
  };
}

export function record(ruleId: RuleId, status: RuleStatus, history: RuleStatus[] = [status]): RuleStatusRecord {
  const detail: RuleStatusRecord['detail'] =
    status === 'fail'
      ? { status, failures: [failure(REFUND_CHECK)] }
      : status === 'pass-unverified'
        ? { status, reason: 'no-injection' }
        : status === 'pass-verified'
          ? { status, reason: 'static-proof' }
          : status === 'recheck'
            ? { status, reason: 'check-file-changed' }
            : { status, reason: 'not-run' };
  return { ruleId, detail, since: EARLIER, commit: '0000000', checkedAt: EARLIER, history };
}

export function block(id: string, kind: BlockNode['kind'], level: BlockNode['level'] = 'L1'): BlockNode {
  return { id, level, kind, paths: [`src/domains/${id}/**`], public: [`src/domains/${id}/index.ts`], files: 3 };
}

/** testbed 모양의 그래프: 진입점 `app` · 공유 `lib` · 도메인 `payment` `auth` · 테스트 · L0 `db` · 미분류 2개 */
export function graph(overrides: Partial<BlockGraph> = {}): BlockGraph {
  return {
    generatedAt: NOW.toISOString(),
    commit: COMMIT,
    tool: { name: 'dependency-cruiser', version: '16.0.0' },
    blocks: [
      block('app', 'entry'),
      block('lib', 'domain'),
      block('payment', 'domain'),
      block('auth', 'domain'),
      block('test', 'test'),
      block('db', 'db', 'L0'),
    ],
    edges: [{ from: 'app', to: 'payment', count: 1, declared: true, imports: [] }],
    infraEdges: [],
    undetectedInfra: ['cache', 'queue', 'external-api'],
    unclassified: ['src/misc/a.ts', 'src/misc/b.ts'],
    ...overrides,
  };
}
