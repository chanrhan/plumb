import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockConfig, Proposal, Rule } from '../../types/index.js';
import { openStore, type Store } from '../index.js';

/** 테스트 기준 시각. 체류 일수 계산의 "지금" */
export const FIXED_NOW = new Date('2026-10-02T09:00:00.000Z');

/** 부를 때마다 1초씩 흐르는 시계. 기록 순서가 `at`에 그대로 남는다 */
export function tickingClock(start: Date = FIXED_NOW): () => Date {
  let t = start.getTime();
  return () => {
    t += 1000;
    return new Date(t);
  };
}

/** 기획안 §5.2 예시 규칙 (결정 ID만 #35의 D-0001로) */
export const REFUND_RULE: Rule = {
  id: 'pay.refund-window',
  block: 'payment',
  kind: 'business',
  statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다',
  source: 'plan:PAY-02',
  risk: 'high',
  depends_on: ['pay.payment-record'],
  checks: [{ kind: 'acceptance', ref: 'test/acceptance/refund-window.property.spec.ts' }],
  decision: 'D-0001',
};

/** 일반 영역 규칙 */
export const RECORD_RULE: Rule = {
  id: 'pay.payment-record',
  block: 'payment',
  kind: 'technical',
  statement: 'THE SYSTEM SHALL 결제 성공 시 Payment 레코드를 남긴다',
  source: 'code:src/domains/payment/index.ts',
  risk: 'normal',
  depends_on: [],
  checks: [],
};

export function proposalFor(rule: Rule, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p-0001',
    ruleId: rule.id,
    changeKind: 'add',
    proposedBy: 'cli',
    proposedAt: '2026-10-01T05:00:00.000Z',
    after: rule,
    requiresPriorApproval: false,
    applied: 'provisional',
    ...overrides,
  };
}

export interface TempStore {
  /** 임시 폴더 (대상 루트와 저장소가 모두 이 아래) */
  dir: string;
  /** 대상 레포 루트 (존재하지 않아도 된다) */
  root: string;
  storeDir: string;
  store: Store;
  cleanup(): Promise<void>;
}

export async function makeTempStore(
  options: { blocks?: Record<string, BlockConfig>; now?: () => Date; init?: boolean } = {},
): Promise<TempStore> {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-store-'));
  const root = join(dir, 'testbed');
  const storeDir = join(dir, 'store');
  const store = openStore({ store: storeDir, blocks: options.blocks }, root, { now: options.now ?? tickingClock() });
  if (options.init !== false) await store.init();
  return { dir, root, storeDir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
