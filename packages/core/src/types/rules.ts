// 원본: docs/types/rules.ts (#5). 정본은 이 파일. #63에서 보완.
/**
 * 규칙 · 상태 · 승인 · 제안 · 결정 기록 · 검사 · 유효성 · 코드 열람 기록.
 *
 * 출처 와이어프레임: `work-approve.md` 3절, `view-verification.md` 3.3절·6절 6번,
 * `view-changelog.md` 6절 2·3번, `view-dependencies.md` 6절 1·2번, `work-views.md` 6절 3번.
 * 기획안 §5.2 (규칙 YAML) · §6.2 (결정 기록) · §7.2 (등급) · §7.3 (상태) · §7.4 (위반 주입) ·
 * §7.5 (불안정 격리) · §9.1 (승인) · §9.2 (검토 대기열) · §15.3 (코드 열람 기록).
 *
 * 이 파일의 모든 기록은 보호 저장소(`~/.plumb/stores/<project>/`)에 있다. 출처 접두어는
 * 사람이 쓴 것(규칙 · 승인 · 결정)이 `저장소:`, 검사를 돌려 나온 값(검사 결과 · 유효성)이
 * `실행:`이다 (README 2.1. 읽은 위치와 무관하게 값의 출처를 쓴다).
 *
 * 설계 원칙을 타입으로 묶은 곳:
 * - 🔴 `fail`은 `failures`(비어 있지 않은 배열) 없이는 만들 수 없다 → {@link RuleStatusDetail}
 * - LLM 판정은 상태를 바꾸지 못한다 → 판정 필드는 `advisory` 아래에만 있다 ({@link Dispute}는 run.ts)
 * - 승인은 상태를 바꾸지 않는다 → {@link ApprovalState}와 {@link RuleStatus}는 서로 다른 축
 */

import type { Anchor, ViewName } from './views.js';
import type { RunId } from './run.js';

// ---------------------------------------------------------------------------
// 규칙 YAML (기획안 §5.2 · work-approve 3.1 · 3.2)
// ---------------------------------------------------------------------------

/** 규칙 ID. `<블록>.<이름>` (work-approve 3.1 "규칙 ID"). 예: `pay.refund-window` */
export type RuleId = `${string}.${string}`;

/** 규칙 종류. 저장소: `rules.yaml` `kind` (work-approve 3.1 "종류"). 목록 축약은 arch · tech · biz */
export type RuleKind = 'architecture' | 'technical' | 'business';

/** 규칙 출처의 접두어. 저장소: `rules.yaml` `source` (work-approve 3.2 "출처"). 화면 항목의 출처 열과는 다른 뜻 */
export type RuleSourceKind = 'plan' | 'code' | 'reference';

/** `plan:PAY-02` 처럼 접두어 + ID 한 문자열 (기획안 §5.2) */
export type RuleSource = `${RuleSourceKind}:${string}`;

/** 위험도. 저장소: `rules.yaml` `risk` (work-approve 3.1 "⚡ 고위험 표시"). 블록 단위 선언은 config.ts `BlockConfig.risk` */
export type Risk = 'high' | 'normal';

/**
 * 검사 종류. 저장소: `rules.yaml` `checks[].kind` (view-verification 3.3 "검사 종류").
 * 보장 등급은 종류에서 유도한다 → {@link GradeOfCheckKind}
 */
export type CheckKind = 'acceptance' | 'contract' | 'pbt' | 'static' | 'trace';

/** 보장 등급 (기획안 §7.2). 1 증명(정적) · 2 증거(테스트·PBT·트레이스) · 3 기록(결정 기록) */
export type Grade = 1 | 2 | 3;

/** 검사 종류 → 등급. 정적 분석 = 1등급, 나머지 = 2등급 (view-verification 3.3 "검사 종류" 비고) */
export type GradeOfCheckKind = {
  static: 1;
  acceptance: 2;
  contract: 2;
  pbt: 2;
  trace: 2;
};

/**
 * 규칙 ↔ 검사 매핑 한 건. 저장소: `rules.yaml` `checks[]` (work-approve 3.2 "부착된 검사 파일",
 * view-verification 3.3 "검사 종류", 기획안 §10 "검사 매핑").
 * `ref`는 테스트 파일 경로 또는 정적 규칙 이름. 첫 슬라이스는 파일 하나 = 규칙 하나 (view-verification 6절 1번).
 */
export interface CheckRef {
  kind: CheckKind;
  /** 테스트 파일 경로(`test/acceptance/refund-window.property.spec.ts`) 또는 dependency-cruiser 규칙 이름 */
  ref: string;
}

/** 규칙 ↔ 의존성 연결 (view-dependencies 6절 1번 `constraint.targets[]`). 문자열 검색 대신 명시 연결 */
export type ConstraintTarget =
  | { kind: 'package'; name: string }
  | { kind: 'service'; type: 'db' | 'cache' | 'queue' | 'external-api'; name?: string };

/**
 * 규칙 한 건 — `rules.yaml` 항목을 정규화한 것 (기획안 §5.2).
 * 저장소: `rules.yaml`. YAML 원문의 `checks`는 문자열 축약을 허용한다 → {@link RuleYaml}
 */
export interface Rule {
  id: RuleId;
  /** 블록 이름. 블록 트리와 같은 값. 비어 있으면 "블록 공통" (view-verification 3.2) */
  block?: string;
  kind: RuleKind;
  /** EARS 한 줄 진술 (work-approve 3.1 "EARS 한 줄 진술") */
  statement: string;
  /** 요약. 없으면 statement 앞 30자 (view-verification 3.3 "진술 요약") */
  summary?: string;
  source: RuleSource;
  risk: Risk;
  depends_on: RuleId[];
  checks: CheckRef[];
  /** 결정 기록 ID. 없어도 승인은 막지 않는다 (work-approve 6절 4번) */
  decision?: DecisionId;
  /** 규칙이 덮는 코드 글롭. 없으면 블록 전체 (view-verification 3.4 "요구사항에 없는 코드") */
  scope?: string[];
  /** 기술 제약 규칙의 대상 (view-dependencies 3절 "제약 규칙과의 연결") */
  constraint?: { targets: ConstraintTarget[] };
}

/** `rules.yaml`에 적는 모양. `checks` 문자열은 `{ kind: 'acceptance', ref }`로 정규화된다 */
export interface RuleYaml extends Omit<Rule, 'checks' | 'depends_on'> {
  depends_on?: RuleId[];
  checks?: Array<string | CheckRef>;
}

// ---------------------------------------------------------------------------
// 상태 (기획안 §7.3 · view-verification 3.3)
// ---------------------------------------------------------------------------

/**
 * 규칙 상태 다섯 가지 (기획안 §7.3, view-verification 3.3 "상태 아이콘").
 * 🟢 pass-verified · 🟡 pass-unverified · 🟠 recheck · 🔴 fail · ⬜ unchecked.
 * 우선순위: unchecked → fail → recheck → pass-verified → pass-unverified (한 규칙에 검사가 여럿이면 최악값).
 */
export type RuleStatus = 'pass-verified' | 'pass-unverified' | 'recheck' | 'fail' | 'unchecked';

/** 최악 상태 우선 정렬용 순위. 🔴 > 🟠 > 🟡 > 🟢 > ⬜ (README 2 "블록 옆 상태 점") */
export type RuleStatusSeverity = { fail: 4; recheck: 3; 'pass-unverified': 2; 'pass-verified': 1; unchecked: 0 };

/**
 * 상태 계산 우선순위 (view-verification 3.3 "상태 계산 우선순위"). 앞에서부터 처음 맞는 것이 상태다:
 * ⬜(검사 없음·미승인·격리) → 🔴(실패) → 🟠(검사 파일 바뀜·보류) → 🟢(통과+유효) → 🟡(통과)
 */
export type RuleStatusPrecedence = ['unchecked', 'fail', 'recheck', 'pass-verified', 'pass-unverified'];

/**
 * 검사 실패 한 건. 실행: JUnit XML `testcase/failure` 또는 dependency-cruiser `violations[]`
 * (view-verification 3.3 "실패 위치 file:line + 메시지", "PBT 반례 · 시드").
 */
export interface CheckFailure {
  check: CheckRef;
  /** `test/**` 첫 프레임의 file:line. 파싱 실패 시 `line: 1` */
  anchor: Anchor;
  message: string;
  /** fast-check `Counterexample:` 줄 (있을 때) */
  counterexample?: string;
  /** fast-check `Seed:` 줄 (있을 때) */
  seed?: string;
}

/**
 * 상태와 그 근거. 🔴 `fail`은 `failures`가 비어 있지 않을 때만 만들 수 있다 — 추정으로 🔴를 만들지 않는다 (§7.3).
 * 각 변형의 `reason`은 view-verification 3.3의 비고 열을 그대로 옮긴 것.
 */
export type RuleStatusDetail =
  | {
      status: 'fail';
      /** 실행: 검사 실패뿐. 비어 있지 않은 배열 */
      failures: [CheckFailure, ...CheckFailure[]];
    }
  | {
      status: 'pass-verified';
      /** 실행: 모든 검사 통과 + 유효한 주입 기록, 그 뒤 검사 파일 안 바뀜. 정적 분석(1등급)은 주입 없이 통과만으로 */
      reason: 'passed-and-injection-valid' | 'static-proof';
      validity?: Validity & { valid: true };
    }
  | {
      status: 'pass-unverified';
      /** 통과했지만 유효성이 확인되지 않음. M7 전에는 모든 통과가 이것 */
      reason: 'no-injection' | 'injection-invalid';
      validity?: Validity & { valid: false };
    }
  | {
      status: 'recheck';
      /** git: 유효성 기록 커밋 이후 검사 파일이 바뀜 · 저장소: 검토 대기열의 해석 불일치 보류 */
      reason: 'check-file-changed' | 'interpretation-dispute';
      changedFiles?: string[];
      queueItemId?: ReviewQueueItemId;
    }
  | {
      status: 'unchecked';
      /** 검사 없음 · 검사 파일 없음(`checks[]`는 있으나 레포에 파일이 없다) · 미승인 · 불안정 격리 · 아직 안 돌림. LLM 판정의 결과는 언제나 여기 */
      reason: 'no-checks' | 'check-missing' | 'unapproved' | 'quarantined' | 'not-run';
    };

/**
 * 규칙별 상태 기록. 저장소: `rule-status/<ruleId>.json`. `plumb check`가 갱신한다.
 * `since`가 있어야 체류 일수(⚠ n일 체류)를 계산할 수 있다 (view-verification 3.1 "최장 체류", 6절 2번).
 */
export interface RuleStatusRecord {
  ruleId: RuleId;
  detail: RuleStatusDetail;
  /** 이 상태가 된 시각 (ISO 8601). 상태가 바뀔 때만 갱신 */
  since: string;
  /** 마지막 검사의 커밋 · 시각 (기획안 §7.3 "모든 결과에") */
  commit: string;
  checkedAt: string;
  /** 최근 n회 상태. 실행: `checks/*.json`을 시각순으로 읽은 것 (view-verification 3.3 "이력") */
  history: RuleStatus[];
}

// ---------------------------------------------------------------------------
// 승인 · 제안 (기획안 §9.1 · work-approve 3.1 · 3.2 · 4절)
// ---------------------------------------------------------------------------

/** 승인 상태 (잠정 · 승인 · 기각). 저장소: 승인 기록의 마지막 항목 (work-approve 3.1 "승인 상태"). 상태(🟢 등)와 독립 */
export type ApprovalState = 'provisional' | 'approved' | 'rejected';

/** 변경 종류 (기획안 §9.1, work-approve 3.2 "변경 종류"). M3는 `add`만 */
export type ProposalChangeKind = 'add' | 'strengthen' | 'relax' | 'delete' | 'boundary';

export type ProposalId = `p-${string}`;

/**
 * 제안 한 건. 저장소: `proposals/<ruleId>/<proposalId>.json` (work-approve 6절 1번 — `rules.yaml`에는 현재 승인 버전만).
 * diff는 `before`와 `after`를 비교해 그린다 (work-approve 3.2 "변경 diff").
 */
export interface Proposal {
  id: ProposalId;
  ruleId: RuleId;
  changeKind: ProposalChangeKind;
  /** 에이전트가 제안했으면 실행 ID, 개발자가 CLI로 적었으면 `cli` (work-approve 3.2 "제안자 · 제안 시각") */
  proposedBy: RunId | 'cli';
  proposedAt: string;
  /** 현재 승인된 버전. 신규 추가면 없음 (diff 전부 `+`) */
  before?: Rule;
  /** 제안 버전. 삭제 제안이면 null */
  after: Rule | null;
  /**
   * 사전 승인 필요 여부 (기획안 §9.1). `risk: high` AND changeKind ∈ {relax, delete, boundary}.
   * true면 승인 전까지 `before`가 유효하다 (work-approve 3.2 "사전 승인 필요 표시")
   */
  requiresPriorApproval: boolean;
  /** 적용 상태: 잠정 적용(추가·강화·일반 영역 완화) · 승인 대기(사전 승인) · 승인되어 현재 버전이 됨 · 기각 */
  applied: 'provisional' | 'pending' | 'applied' | 'rejected';
}

/**
 * 승인 기록 한 건. 저장소: `approvals/<ruleId>.jsonl` (work-approve 3.2 "승인 이력": 시각 · 행위 · 사유).
 * 승인 행위로만 쓰인다 (기획안 §10). 에이전트는 쓸 수 없다.
 */
export interface Approval {
  ruleId: RuleId;
  proposalId: ProposalId;
  /**
   * 행위. 코어는 `approve` · `reject` 줄만 쓴다 — 제안은 `proposals/`의 파일이고 승인 기록은 승인 행위로만 쓰인다 (§10).
   * `propose`는 읽을 때만 허용한다 (#38)
   */
  action: 'propose' | 'approve' | 'reject';
  at: string;
  /** 승인자. UI 토큰 세션이면 `ui`, CLI면 OS 사용자 이름 */
  by: string;
  /** 기각 사유. `action: 'reject'`일 때 필수 (work-approve 3.2 "기각 사유") */
  reason?: string;
  /** 제안 내용의 해시. `POST /api/rules/:id/approve`의 409 판정 기준 (work-approve 4절) */
  proposalHash: string;
  /**
   * 승인 줄에만: 반영 후 `rules.yaml`의 sha256 — 변조 감지(`store.status()`)의 근거 (#38).
   * 기각 줄에는 쓰지 않는다 — 변조된 파일의 해시를 기각이 "확인"해 주면 안 되기 때문
   */
  rulesHash?: string;
  /** 승인 메모 한 줄 (선택, #38) */
  note?: string;
}

// ---------------------------------------------------------------------------
// 결정 기록 (기획안 §6.2 · view-changelog 2.2 · 6절 2·3번 · view-dependencies 6절 2번)
// ---------------------------------------------------------------------------

export type DecisionId = `D-${string}`;

/** 결정 기록의 네 절 밖에 있는 `## 절`. 파서는 버리지 않고 제목 · 본문을 그대로 둔다 (왕복 동일성, #39) */
export interface DecisionExtraSection {
  heading: string;
  body: string;
}

/**
 * 결정 기록 D-xxxx. 저장소: `decisions/D-xxxx.md`를 M3 파서(`decisions/format.ts`)가 다섯 필드로 나눈 것.
 * 3등급(기록). 규범도 검사 대상도 아니다. 에이전트가 쓴 텍스트를 그대로 둔다 — 요약하지 않는다.
 *
 * 파일과 이름이 다른 필드 둘은 그대로 둔다 (#39, #63에서 보류): front matter `at` ↔ `date`, 절 `## 감수하는 것`(키 `tradeoff`) ↔ `accepted`.
 * 바꾸면 View JSON(`ChangelogView.orphanDecisions`)의 키가 바뀌므로 저장 형식 결정이 필요하다.
 */
export interface DecisionRecord {
  id: DecisionId;
  title: string;
  block?: string;
  /** 날짜 (ISO 8601). 파일의 front matter 키는 `at` */
  date: string;
  /** 남긴 세션(실행) ID. 사람이 직접 썼으면 없음 (파일에는 `session: null`) */
  session?: RunId;
  /** 결정 */
  decision: string;
  /** 이유. 비어 있으면 연결된 이벤트는 "사유 없음(empty-reason)" (view-changelog 3절) */
  reason: string;
  /** 기각한 대안. 비어 있어도 "사유 없음"은 아니고 "기록 불완전" (view-changelog 6절 3번) */
  rejected: string;
  /** 감수한 것. 파일의 절 제목은 `## 감수하는 것` */
  accepted: string;
  /**
   * 연결. 에이전트가 쓰는 것은 규칙 ID · 커밋 · 패키지 · 서비스. 이벤트 ID는 감지 뒤에만 존재하므로
   * 도구가 역으로 채운다 (view-changelog 6절 2번). 패키지 · 서비스는 view-dependencies 6절 2번 `refs`
   */
  links: {
    rules: RuleId[];
    commits: string[];
    /** 도구가 채움. 에이전트는 쓰지 않으므로 선택 — 파서는 없으면 `[]`로 읽고, 쓸 때 비어 있으면 생략한다 (#39) */
    events?: ChangeEventId[];
    packages?: string[];
    services?: string[];
  };
  /** 네 절 밖의 `## 절`. 모르는 절이 있을 때만 (#39) */
  extra?: DecisionExtraSection[];
}

/** 설계 변경 이벤트 ID. 감지기가 부여, 근거 해시로 멱등 (view-changelog 3절). 본체는 views.ts `ChangeEvent` */
export type ChangeEventId = `E-${string}`;

// ---------------------------------------------------------------------------
// 검사 실행 결과 (기획안 §7.3 · §7.5 · view-verification 3.1 · 3.3 · 3.4)
// ---------------------------------------------------------------------------

export type CheckRunId = `c-${string}`;

/** 검사 하나의 결과. 실행: JUnit XML `testcase` 또는 dependency-cruiser 규칙 */
export interface CheckResult {
  check: CheckRef;
  /** 이 검사가 매핑된 규칙들 */
  ruleIds: RuleId[];
  outcome: 'pass' | 'fail' | 'error' | 'skipped';
  /** JUnit `testcase@time` (초) */
  durationSec?: number;
  /** `outcome`이 fail · error일 때 */
  failure?: CheckFailure;
}

/** 불안정으로 격리된 검사 (기획안 §7.5). 같은 커밋에서 3회 실행해 결과가 갈림 */
export interface Quarantine {
  ref: string;
  passes: number;
  runs: number;
}

/**
 * `plumb check` 한 번의 결과. 실행: `checks/<runId>.json` (view-verification 3.1 "마지막 검사 커밋 · 시각",
 * "검사 수", 3.4 "불안정으로 격리된 검사"). 상태 계산의 입력이고 `RuleStatusRecord`는 그 출력이다 (6절 2번).
 */
export interface CheckRun {
  runId: CheckRunId;
  commit: string;
  startedAt: string;
  finishedAt: string;
  /**
   * 러너 자체가 죽었으면 exit code와 stderr 꼬리 (view-verification 5절 "plumb check 실패").
   * `exitCode` 관례: `-1` = 프로세스가 돌지 않았다(어댑터 예외 · 시그널로 종료) · `127` = 러너 바이너리 없음 (#49 #62).
   * `number | null`로 바꾸는 것은 저장 형식 결정이라 #63에서 보류
   */
  runner: { exitCode: number; stderrTail?: string[] };
  results: CheckResult[];
  quarantined: Quarantine[];
  /** 검사 수 집계 "15/15의 15" */
  counts: { junit: number; static: number };
  /** 보호 저장소 해시 체인 검증 (M3는 `ok` 고정, 해시 체인은 M10) */
  storeStatus: 'ok' | 'tampered' | 'unverified';
  /** 이 검사 시점의 지표. 변경 로그 View 추이의 원자료 (view-changelog 6절 4번: 별도 파일 대신 여기) */
  metrics?: { noReasonEvents: number; totalEvents: number };
}

// ---------------------------------------------------------------------------
// 유효성 — 위반 주입 (기획안 §7.4 · view-verification 3.3 "유효성")
// ---------------------------------------------------------------------------

export type InjectionId = `i-${string}`;

/**
 * 차이 탐색 결과 (기획안 §7.4). 에이전트가 아닌 러너가 돌린다. 원본·위반 구현에 fast-check 입력 N개를 넣고 출력을 비교.
 * 출력이 갈리는 입력을 찾으면 진짜 위반 또는 검사 약함, 못 찾으면 미판정 → 검토 대기열.
 */
export interface DiffSearch {
  runId: RunId;
  inputs: number;
  differingOutputs: number;
  verdict: 'real-violation' | 'weak-check' | 'undetermined';
  queueItemId?: ReviewQueueItemId;
}

/**
 * 위반 주입 기록 한 건. 실행: `injections/<ruleId>/<id>.json`.
 * 사람은 `description` 한 줄과 결과만 본다. 패치 내용은 여기 없다 (§7.4).
 * 검사가 실패하면 유효 ✔, 통과하면 무효 ✘ → 차이 탐색.
 */
export type Validity = {
  id: InjectionId;
  ruleId: RuleId;
  /** 주입 설명 한 줄 */
  description: string;
  /** 주입한 위치 file:line. 패치 본문 대신 위치만 (paper-walkthrough "코드를 열고 싶은 지점" 3번에서 추가) */
  anchor?: Anchor;
  commit: string;
  at: string;
  /** 주입 시점의 검사 파일 해시. 바뀌면 유효성 무효 → 🟠 (git 없을 때의 대체 비교 기준) */
  checkFileHashes: Record<string, string>;
} & (
  | { result: 'check-failed'; valid: true }
  | { result: 'check-passed'; valid: false; diffSearch?: DiffSearch }
);

// ---------------------------------------------------------------------------
// 검토 대기열 (기획안 §9.2 · work-run 3.3 "이의 제기" · view-verification 3.1 "미확인 항목")
// ---------------------------------------------------------------------------

export type ReviewQueueItemId = `q-${string}`;

/**
 * 검토 대기열 항목. 저장소: `review-queue/<id>.json`. 단위는 설계 결정 (§9.2). 판정 화면은 M10.
 * 상단 바 `⚠ n`의 일부 (README 2).
 */
export interface ReviewQueueItem {
  id: ReviewQueueItemId;
  kind: 'dispute' | 'interpretation' | 'undetermined-injection' | 'run-failed' | 'budget-exceeded' | 'design-change';
  ruleIds: RuleId[];
  runId?: RunId;
  decisionId?: DecisionId;
  /** 요지 한 줄 (이의 제기 파일의 첫 줄 등) */
  summary: string;
  createdAt: string;
  resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// 계약 해시 기록 (기획안 §5.1 · view-data-contract 3절 "승인된 해시", 6절 1번)
// ---------------------------------------------------------------------------

/** 승인된 계약 파일의 해시. 저장소: `contracts/<파일>.json`. 계약 파일 자체는 레포에 있다 */
export interface ContractApproval {
  path: string;
  hash: string;
  approvedAt: string;
  decision?: DecisionId;
  commit: string;
  /** 승인자. UI 토큰 세션이면 `ui`, CLI면 OS 사용자 이름 — `Approval.by`와 같은 규약 (#66) */
  by: string;
}

// ---------------------------------------------------------------------------
// 코드 열람 기록 (기획안 §15.3 · README 2.2 · work-views 2절 · 6절 3번)
// ---------------------------------------------------------------------------

/** 이유 종류 세 가지. 사용자 입력: 라디오 하나 필수 */
export type CodeOpenReason = 'view-error' | 'missing-info' | 'debugging-env';

/**
 * 코드 열람 기록 한 줄. 저장소: `code-opens.jsonl`.
 * IDE 열기 실패도 남긴다 — 명제 검증에는 "보려 했다"가 중요하다 (work-views 6절 3번).
 */
export interface CodeOpenRecord {
  at: string;
  /** 어느 View에서 눌렀는가. `plumb open <file>:<line>`을 View 밖(셸)에서 부르면 없음 (#71) */
  view?: ViewName;
  /** 어느 항목에서 눌렀는가 (항목 식별자 또는 라벨). 요청에 없으면 저장소가 `file:line`을 넣는다 */
  item: string;
  file: string;
  line?: number;
  reason: CodeOpenReason;
  /** 메모 한 줄. 선택 */
  note?: string;
  /** View 생성 커밋. "이 생성 커밋 이후 열람 n회" 계산용 (work-views 3절 "열람 횟수") */
  viewCommit?: string;
  result: { status: 'opened'; command: string } | { status: 'failed'; command: string; exitCode?: number; error: string };
}
