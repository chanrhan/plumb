/**
 * 보호 저장소 코어 API (이슈 #31). CLI(#32)와 UI 서버(#33 #34)가 같은 {@link openStore}를 import한다 (screens/README 3.1).
 *
 * Store 객체의 표면은 읽기 · 제안 · 승인 · 상태뿐이다. `rules.yaml` 쓰기 함수는 여기서 export하지 않는다 —
 * `rules.yaml`을 바꾸는 유일한 길은 `approvals.approve()`다 (기획안 §10).
 */

import type {
  Approval,
  CheckRun,
  CodeOpenRecord,
  ContractApproval,
  PlumbConfig,
  Proposal,
  ProposalId,
  ReviewQueueItem,
  ReviewQueueItemId,
  Rule,
  RuleId,
  RuleStatusRecord,
  RunId,
  RunState,
  RunSummary,
  Validity,
  View,
  ViewName,
} from '../types/index.js';
import {
  type ApproveInput,
  type ApproveResult,
  approve,
  listApprovals,
  type RejectInput,
  type RejectResult,
  reject,
} from './approvals.js';
import { latestCheckRun, listCheckRuns, writeCheckRun } from './checks.js';
import {
  appendCodeOpen,
  type CodeOpenInput,
  type CodeOpenSummary,
  countCodeOpens,
  listCodeOpens,
  summarizeCodeOpens,
} from './code-opens.js';
import { type ApproveContractInput, approveContract, getContractApproval, listContractApprovals } from './contracts.js';
import { initStore, type StoreMeta } from './init.js';
import { latestInjection, listInjections, writeInjection } from './injections.js';
import { type StorePaths, storePaths } from './paths.js';
import { getProposal, listProposals, writeProposal } from './proposals.js';
import {
  type EnqueueInput,
  enqueueReviewItem,
  getReviewItem,
  listReviewQueue,
  nextReviewQueueId,
  type ResolveReviewInput,
  resolveReviewItem,
} from './review-queue.js';
import { getRuleStatus, listRuleStatuses, writeRuleStatuses } from './rule-status.js';
import { getRule, listRules } from './rules.js';
import { activeRun, listRuns, nextRunId, readRunState, writeRunState } from './runs.js';
import { type StoreStatus, storeStatus } from './status.js';
import { listViews, readView, type StoredView, type ViewListItem, writeView } from './views.js';

export * from './approvals.js';
export * from './checks.js';
export * from './code-opens.js';
export * from './contracts.js';
export * from './errors.js';
export * from './init.js';
export * from './injections.js';
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
export * from './review-queue.js';
export * from './rule-status.js';
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
export * from './runs.js';
export * from './status.js';
export * from './views.js';

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
    history(ruleId: RuleId): Promise<Approval[]>;
  };
  /** 검사 실행 기록 `checks/<c-id>.json` — 실행: `plumb check`가 쓴다. 상태 계산의 입력이자 진실 */
  checks: {
    write(run: CheckRun | unknown): Promise<CheckRun>;
    /** 시각순 (오래된 것부터) */
    list(): Promise<CheckRun[]>;
    latest(): Promise<CheckRun | null>;
  };
  /** 규칙별 상태 기록 `rule-status/<ruleId>.json` — `computeRuleStatuses()`의 출력. `rule list` · UI 상태 열이 읽는다 */
  ruleStatus: {
    write(records: RuleStatusRecord[] | unknown[]): Promise<RuleStatusRecord[]>;
    get(ruleId: RuleId): Promise<RuleStatusRecord | undefined>;
    list(): Promise<RuleStatusRecord[]>;
  };
  /**
   * View `views/<name>.json`(정본) · `views/<name>.md`(렌더링) — `plumb views`(#60)가 쓰고 UI `/views`가 읽는다.
   * 두 파일의 머리말 `generatedAt`은 항상 같다 (`write`가 JSON 머리말에서 Markdown front matter를 만든다)
   */
  views: {
    write(name: ViewName, view: View | unknown, markdown: string): Promise<StoredView>;
    /** JSON이 없으면 `null` (→ API 404). Markdown만 없으면 오류 — 반쪽을 그리지 않는다 */
    read(name: ViewName): Promise<StoredView | null>;
    /** 탭 순서 (VIEW_NAMES) */
    list(): Promise<ViewListItem[]>;
  };
  /**
   * 계약 해시 기록 `contracts/<파일>.json` — 저장소: 승인된 계약 파일의 해시 (기획안 §5.1). 데이터 모델·계약 View가 어댑터
   * `readSchemas()`의 현재 해시와 비교해 `match | changed | unapproved`를 낸다. 승인 통로(UI · CLI)는 M10 — 지금은 코어 API뿐
   */
  contracts: {
    /** 계약 파일 경로(레포 상대)로 찾는다. 없으면 `undefined` */
    get(path: string): Promise<ContractApproval | undefined>;
    /** 경로순 */
    list(): Promise<ContractApproval[]>;
    /** 현재 해시를 승인한다 (있으면 덮어쓴다) */
    approve(input: ApproveContractInput): Promise<ContractApproval>;
  };
  /**
   * 코드 열람 기록 `code-opens.jsonl` — 사용자 입력: View의 `file:line` 점프와 그 이유 (README 2.2, 기획안 §15.3).
   * IDE 열기 실패도 `result.status: 'failed'`로 남는다. `plumb open`과 UI `POST /api/open`이 쓴다
   */
  codeOpens: {
    /** 이유 없으면 `ValidationError`. `at`은 저장소 시계 */
    append(input: CodeOpenInput): Promise<CodeOpenRecord>;
    list(): Promise<CodeOpenRecord[]>;
    /** 이유별 · 결과별 수 */
    summary(): Promise<CodeOpenSummary>;
    /** 이 View의 열람 수. `since`(보통 머리말 `generatedAt`) 이후만 */
    count(view: ViewName, since?: string): Promise<number>;
  };
  /** 실행 상태 `runs/<r-id>.json` — 실행: `plumb run`이 쓰고 UI · `plumb runs`가 읽는다 (work-run 3절) */
  runs: {
    write(state: RunState | unknown): Promise<RunState>;
    get(id: RunId): Promise<RunState | undefined>;
    /** 최근 시작 순 */
    list(): Promise<RunSummary[]>;
    nextId(): Promise<RunId>;
    /** 진행 중인 실행. 동시 1개 (work-run 6절 1번) */
    active(): Promise<RunSummary | undefined>;
  };
  /** 검토 대기열 `review-queue/<q-id>.json` (기획안 §9.2). 화면은 `/queue`(#120) — `resolve`가 `resolvedAt`을 쓰는 유일한 길 */
  reviewQueue: {
    enqueue(input: EnqueueInput): Promise<ReviewQueueItem>;
    list(openOnly?: boolean): Promise<ReviewQueueItem[]>;
    /** 없으면 `undefined` (→ API 404) */
    get(id: ReviewQueueItemId): Promise<ReviewQueueItem | undefined>;
    /** 없는 id → `ReviewItemNotFoundError`, 이미 처리 → `ValidationError` */
    resolve(id: ReviewQueueItemId, input: ResolveReviewInput): Promise<ReviewQueueItem>;
    nextId(): Promise<ReviewQueueItemId>;
  };
  /**
   * 위반 주입 기록 `injections/<ruleId>/<i-id>.json` (기획안 §7.4, #90) — 실행: injector가 쓰고 `plumb check`(#105)가 규칙별
   * 최신 1건을 읽어 🟢 · 🟡 · 🟠을 가른다. 패치 본문은 없다 — 설명 한 줄과 결과뿐
   */
  injections: {
    write(validity: Validity | unknown): Promise<Validity>;
    /** 시각순 (오래된 것부터) */
    list(ruleId: RuleId): Promise<Validity[]>;
    /** 가장 최근 기록. 없으면 `undefined` */
    latest(ruleId: RuleId): Promise<Validity | undefined>;
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
    checks: {
      write: (run) => writeCheckRun(paths, run),
      list: () => listCheckRuns(paths),
      latest: () => latestCheckRun(paths),
    },
    ruleStatus: {
      write: (records) => writeRuleStatuses(paths, records),
      get: (ruleId) => getRuleStatus(paths, ruleId),
      list: () => listRuleStatuses(paths),
    },
    views: {
      write: (name, view, markdown) => writeView(paths, name, view, markdown),
      read: (name) => readView(paths, name),
      list: () => listViews(paths),
    },
    contracts: {
      get: (path) => getContractApproval(paths, path),
      list: () => listContractApprovals(paths),
      approve: (input) => approveContract(paths, input, timing),
    },
    codeOpens: {
      append: (input) => appendCodeOpen(paths, input, timing),
      list: () => listCodeOpens(paths),
      summary: async () => summarizeCodeOpens(await listCodeOpens(paths)),
      count: (view, since) => countCodeOpens(paths, view, since),
    },
    runs: {
      write: (state) => writeRunState(paths, state),
      get: (id) => readRunState(paths, id),
      list: () => listRuns(paths),
      nextId: () => nextRunId(paths),
      active: () => activeRun(paths),
    },
    reviewQueue: {
      enqueue: (input) => enqueueReviewItem(paths, input, options.now),
      list: (openOnly) => listReviewQueue(paths, openOnly),
      get: (id) => getReviewItem(paths, id),
      resolve: (id, input) => resolveReviewItem(paths, id, input, options.now),
      nextId: () => nextReviewQueueId(paths),
    },
    injections: {
      write: (validity) => writeInjection(paths, validity),
      list: (ruleId) => listInjections(paths, ruleId),
      latest: (ruleId) => latestInjection(paths, ruleId),
    },
    status: () => storeStatus(paths, timing),
  };
}
