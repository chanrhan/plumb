/**
 * 보호 저장소 경로 (기획안 §10, screens/README 3.1). 프로젝트마다 하나, 레포 밖.
 *
 * 루트: `config.store`가 있으면 대상 루트 기준으로 푼다(절대 경로면 그대로). 없으면 `~/.plumb/stores/<basename(대상 루트)>/`.
 * 레이아웃은 이슈 #31 "범위"의 목록 그대로다. 다른 모듈(#35 결정 기록 등)은 여기 상수와 {@link StorePaths}만 import한다.
 */

import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type {
  CheckRunId,
  DecisionId,
  PlumbConfig,
  ProposalId,
  ReviewQueueItemId,
  RuleId,
  RunId,
  ViewName,
} from '../types/index.js';
import { ValidationError } from './errors.js';

/** `meta.json`의 저장소 버전. 레이아웃이 호환되지 않게 바뀌면 올린다 */
export const STORE_VERSION = 1 as const;

/** 저장소 루트 아래 이름. 파일은 확장자까지, 폴더는 이름만 */
export const STORE_LAYOUT = {
  rules: 'rules.yaml',
  proposals: 'proposals',
  approvals: 'approvals',
  ruleStatus: 'rule-status',
  checks: 'checks',
  decisions: 'decisions',
  runs: 'runs',
  views: 'views',
  contracts: 'contracts',
  reviewQueue: 'review-queue',
  codeOpens: 'code-opens.jsonl',
  meta: 'meta.json',
} as const;

/** 규칙 ID `<블록>.<이름>` (work-approve 3.1). 파일 이름으로 쓰이므로 경로 구분자 · 공백은 받지 않는다 */
export const RULE_ID_PATTERN = /^[\w-]+(?:\.[\w-]+)+$/;
/** 제안 ID `p-…` (`types/rules.ts` `ProposalId`) */
export const PROPOSAL_ID_PATTERN = /^p-[\w-]+$/;

/** 파일 이름으로 쓰이는 식별자. `/` `\` `..`가 들어오면 경로 이탈이므로 거부한다 */
const SAFE_SEGMENT = /^[\w.-]+$/;

export function assertSafeSegment(kind: string, value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.includes('..')) {
    throw new ValidationError(`${kind} "${value}"은(는) 파일 이름으로 쓸 수 없다 (영문 · 숫자 · _ - . 만)`);
  }
}

export interface StorePaths {
  /** 저장소 루트 (절대 경로) */
  readonly root: string;
  /** 프로젝트 이름 = 대상 루트 폴더 이름. 상단 바의 프로젝트 이름 · `meta.json`의 `project` */
  readonly project: string;
  /** 대상 레포 루트 (`plumb.config.json`이 있는 폴더, 절대 경로) */
  readonly targetRoot: string;

  readonly rules: string;
  readonly meta: string;
  readonly codeOpens: string;
  readonly proposalsDir: string;
  readonly approvalsDir: string;
  readonly ruleStatusDir: string;
  readonly checksDir: string;
  readonly decisionsDir: string;
  readonly runsDir: string;
  readonly viewsDir: string;
  readonly contractsDir: string;
  readonly reviewQueueDir: string;

  /** `proposals/<ruleId>/` */
  proposalDir(ruleId: RuleId): string;
  /** `proposals/<ruleId>/<p-id>.json` */
  proposal(ruleId: RuleId, proposalId: ProposalId): string;
  /** `approvals/<ruleId>.jsonl` */
  approvals(ruleId: RuleId): string;
  /** `rule-status/<ruleId>.json` */
  ruleStatus(ruleId: RuleId): string;
  /** `checks/<c-id>.json` */
  check(checkRunId: CheckRunId): string;
  /** `decisions/D-nnnn.md` */
  decision(decisionId: DecisionId): string;
  /** `runs/<r-id>.json` */
  run(runId: RunId): string;
  /** `views/<name>.json` · `views/<name>.md` */
  view(name: ViewName, extension: 'json' | 'md'): string;
  /** `contracts/<파일>.json` — 계약 파일의 레포 상대 경로에서 `/`를 `__`로 바꾼다 */
  contract(contractPath: string): string;
  /** `review-queue/<q-id>.json` */
  reviewQueueItem(id: ReviewQueueItemId): string;
}

export interface StorePathsOptions {
  /** 홈 폴더. 기본 `os.homedir()`. 테스트가 바꾼다 */
  home?: string;
}

export type StoreLocationConfig = Pick<PlumbConfig, 'store'>;

/** 저장소 루트를 푼다. `config.store`가 상대 경로면 대상 루트 기준, 없으면 `~/.plumb/stores/<프로젝트>/` */
export function resolveStoreRoot(
  config: StoreLocationConfig,
  targetRoot: string,
  options: StorePathsOptions = {},
): string {
  const root = resolve(targetRoot);
  if (config.store !== undefined && config.store.length > 0) {
    return resolve(root, config.store);
  }
  return join(options.home ?? homedir(), '.plumb', 'stores', basename(root));
}

/** 레이아웃 전체의 경로 묶음 */
export function storePaths(
  config: StoreLocationConfig,
  targetRoot: string,
  options: StorePathsOptions = {},
): StorePaths {
  const target = resolve(targetRoot);
  const root = resolveStoreRoot(config, target, options);
  const dir = (name: string) => join(root, name);

  const proposalsDir = dir(STORE_LAYOUT.proposals);
  const approvalsDir = dir(STORE_LAYOUT.approvals);
  const ruleStatusDir = dir(STORE_LAYOUT.ruleStatus);
  const checksDir = dir(STORE_LAYOUT.checks);
  const decisionsDir = dir(STORE_LAYOUT.decisions);
  const runsDir = dir(STORE_LAYOUT.runs);
  const viewsDir = dir(STORE_LAYOUT.views);
  const contractsDir = dir(STORE_LAYOUT.contracts);
  const reviewQueueDir = dir(STORE_LAYOUT.reviewQueue);

  return {
    root,
    project: basename(target),
    targetRoot: target,
    rules: dir(STORE_LAYOUT.rules),
    meta: dir(STORE_LAYOUT.meta),
    codeOpens: dir(STORE_LAYOUT.codeOpens),
    proposalsDir,
    approvalsDir,
    ruleStatusDir,
    checksDir,
    decisionsDir,
    runsDir,
    viewsDir,
    contractsDir,
    reviewQueueDir,
    proposalDir(ruleId) {
      assertSafeSegment('규칙 ID', ruleId);
      return join(proposalsDir, ruleId);
    },
    proposal(ruleId, proposalId) {
      assertSafeSegment('규칙 ID', ruleId);
      assertSafeSegment('제안 ID', proposalId);
      return join(proposalsDir, ruleId, `${proposalId}.json`);
    },
    approvals(ruleId) {
      assertSafeSegment('규칙 ID', ruleId);
      return join(approvalsDir, `${ruleId}.jsonl`);
    },
    ruleStatus(ruleId) {
      assertSafeSegment('규칙 ID', ruleId);
      return join(ruleStatusDir, `${ruleId}.json`);
    },
    check(checkRunId) {
      assertSafeSegment('검사 실행 ID', checkRunId);
      return join(checksDir, `${checkRunId}.json`);
    },
    decision(decisionId) {
      assertSafeSegment('결정 ID', decisionId);
      return join(decisionsDir, `${decisionId}.md`);
    },
    run(runId) {
      assertSafeSegment('실행 ID', runId);
      return join(runsDir, `${runId}.json`);
    },
    view(name, extension) {
      assertSafeSegment('View 이름', name);
      return join(viewsDir, `${name}.${extension}`);
    },
    contract(contractPath) {
      const flat = contractPath.replace(/^\.?\//, '').replace(/[\\/]/g, '__');
      assertSafeSegment('계약 파일', flat);
      return join(contractsDir, `${flat}.json`);
    },
    reviewQueueItem(id) {
      assertSafeSegment('검토 대기열 ID', id);
      return join(reviewQueueDir, `${id}.json`);
    },
  };
}

/** 폴더로 만들어야 하는 레이아웃 항목 전부 (`initStore`가 쓴다) */
export function storeDirectories(paths: StorePaths): string[] {
  return [
    paths.root,
    paths.proposalsDir,
    paths.approvalsDir,
    paths.ruleStatusDir,
    paths.checksDir,
    paths.decisionsDir,
    paths.runsDir,
    paths.viewsDir,
    paths.contractsDir,
    paths.reviewQueueDir,
  ];
}
