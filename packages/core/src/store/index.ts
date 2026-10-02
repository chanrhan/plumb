/**
 * 보호 저장소 코어 API (이슈 #31). CLI(#32)와 UI 서버(#33 #34)가 같은 {@link openStore}를 import한다 (screens/README 3.1).
 *
 * Store 객체의 표면은 읽기 · 제안 · 승인 · 상태뿐이다. `rules.yaml` 쓰기 함수는 여기서 export하지 않는다 —
 * `rules.yaml`을 바꾸는 유일한 길은 `approvals.approve()`다 (기획안 §10).
 */

import type { PlumbConfig, Proposal, ProposalId, Rule, RuleId } from '../types/index.js';
import {
  type ApprovalRecord,
  type ApproveInput,
  type ApproveResult,
  approve,
  listApprovals,
  type RejectInput,
  type RejectResult,
  reject,
} from './approvals.js';
import { initStore, type StoreMeta } from './init.js';
import { type StorePaths, storePaths } from './paths.js';
import { getProposal, listProposals, writeProposal } from './proposals.js';
import { getRule, listRules } from './rules.js';
import { type StoreStatus, storeStatus } from './status.js';

export * from './approvals.js';
export * from './errors.js';
export * from './init.js';
export * from './paths.js';
export {
  getProposal,
  hashProposal,
  listProposals,
  proposalAppliedSchema,
  proposalChangeKindSchema,
  proposalIdSchema,
  proposalSchema,
  writeProposal,
} from './proposals.js';
export {
  checkKindSchema,
  checkRefSchema,
  constraintTargetSchema,
  decisionIdSchema,
  getRule,
  hashRulesFile,
  listRules,
  normalizeRule,
  parseRulesDocument,
  type RulesDocument,
  type RulesFile,
  readRulesFile,
  ruleIdSchema,
  ruleKindSchema,
  ruleSchema,
  ruleSourceSchema,
  rulesDocumentSchema,
  ruleYamlSchema,
  serializeRulesDocument,
  toRuleYaml,
} from './rules.js';
export * from './status.js';

/** `openStore`가 보는 설정 부분. `loadConfig()` 결과의 `config`를 그대로 넘기면 된다 */
export type StoreConfig = Pick<PlumbConfig, 'store' | 'blocks'>;

export interface StoreOptions {
  /** 홈 폴더 (기본 `os.homedir()`). `config.store`가 없을 때만 쓰인다 */
  home?: string;
  /** 기록 시각. 테스트가 바꾼다 */
  now?: () => Date;
}

export interface Store {
  readonly paths: StorePaths;
  /** 폴더 · 빈 `rules.yaml` · `meta.json`. 이미 있으면 그대로 */
  init(): Promise<StoreMeta>;
  rules: {
    list(): Promise<Rule[]>;
    get(id: RuleId): Promise<Rule | undefined>;
  };
  proposals: {
    /** 에이전트(rule-drafter) · CLI `rule propose`가 쓰는 유일한 경로. 입력은 검증된다 */
    write(proposal: Proposal | unknown): Promise<Proposal>;
    list(ruleId?: RuleId): Promise<Proposal[]>;
    get(ruleId: RuleId, proposalId: ProposalId): Promise<Proposal | undefined>;
  };
  approvals: {
    /** `rules.yaml`을 바꾸는 유일한 길 */
    approve(input: ApproveInput): Promise<ApproveResult>;
    reject(input: RejectInput): Promise<RejectResult>;
    history(ruleId: RuleId): Promise<ApprovalRecord[]>;
  };
  status(): Promise<StoreStatus>;
}

/** 저장소를 연다. 파일은 건드리지 않는다 — `init()`을 불러야 만들어진다 */
export function openStore(config: StoreConfig, root: string, options: StoreOptions = {}): Store {
  const paths = storePaths(config, root, { home: options.home });
  const timing = options.now === undefined ? {} : { now: options.now };
  const approvalConfig = { blocks: config.blocks };

  return {
    paths,
    init: () => initStore(paths, timing),
    rules: {
      list: () => listRules(paths),
      get: (id) => getRule(paths, id),
    },
    proposals: {
      write: (proposal) => writeProposal(paths, proposal),
      list: (ruleId) => listProposals(paths, ruleId),
      get: (ruleId, proposalId) => getProposal(paths, ruleId, proposalId),
    },
    approvals: {
      approve: (input) => approve(paths, approvalConfig, input, timing),
      reject: (input) => reject(paths, input, timing),
      history: (ruleId) => listApprovals(paths, ruleId),
    },
    status: () => storeStatus(paths, timing),
  };
}
