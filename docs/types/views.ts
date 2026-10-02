/**
 * View 6개의 데이터 타입과 공통 머리말.
 *
 * View는 파서·실행 결과에서만 나온다 (CLAUDE.md "하지 않는 것"). 이 타입은 M5(검사 결과)·M8(파서)의
 * 출력 목표이며, `plumb views`가 `views/<name>.json`(이 타입)과 `views/<name>.md`(렌더링)를 함께 쓴다
 * (work-views 6절 1번 → (b) JSON 구조. 결정 메모 `docs/types/README.md` 참조).
 *
 * 공통 타입은 하나만 둔다: {@link ViewHeader} {@link SourceRef} {@link Anchor} {@link OutOfScope}.
 * 규칙 상태는 rules.ts의 `RuleStatus` 하나뿐이다 (와이어프레임 초안의 `Status`를 여기에 맞췄다).
 */

import type {
  ChangeEventId,
  CheckFailure,
  CheckKind,
  CheckRef,
  CheckRunId,
  DecisionId,
  DecisionRecord,
  Grade,
  Quarantine,
  RuleId,
  RuleKind,
  RuleStatus,
  RuleStatusDetail,
  Validity,
} from './rules';
import type { RunId } from './run';

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** View 이름 여섯 개. URL `?view=` 값과 `views/<name>.*` 파일 이름 (README 1, work-views 3절 "선택된 탭") */
export type ViewName = 'architecture' | 'flow' | 'changelog' | 'verification' | 'dependencies' | 'contract';

/**
 * 출처 접두어 다섯 가지와 1:1 (README 2.1).
 * `parser` = 파서: · `execution` = 실행: · `store` = 저장소: · `git` = git: · `user-input` = 사용자 입력:
 */
export type SourceKind = 'parser' | 'execution' | 'store' | 'git' | 'user-input';

/**
 * View 머리말의 `sources[]` 한 항목 (work-views 3절 "생성 출처 표시줄", 6절 2번).
 * "파서 depcruise 16.x · git a1b2c3" 처럼 한 줄로 그린다.
 */
export interface SourceRef {
  kind: SourceKind;
  /** 도구 이름 (dependency-cruiser · prisma · openapi · vitest-junit · otel · plumb check …) */
  tool?: string;
  version?: string;
  /** 입력 파일 또는 실행 결과 파일 */
  input?: string;
  /** 그 출처가 어느 커밋의 것인가 (git: 일 때 필수에 가깝다) */
  commit?: string;
}

/**
 * 모든 View의 공통 머리말. 저장소: `views/<name>.json` 머리말 (work-views 3절 "마지막 생성 시각/커밋", "생성 출처 표시줄").
 * `commit`이 없으면 화면은 "생성 커밋 기록 없음"을 쓰고 오래됨 비교를 하지 않는다 (work-views 5절).
 */
export interface ViewHeader {
  view: ViewName;
  /** `plumb views` 실행 시각 (ISO 8601) */
  generatedAt: string;
  /** `plumb views` 실행 시점의 HEAD. 7자리 축약 표시 */
  commit?: string;
  sources: SourceRef[];
}

/**
 * 항목 단위 메타 (work-views 6절 1번). 블록 필터(`block`)와 코드 열람 점프(`file:line`)의 근거.
 * `block`이 없는 항목은 필터와 무관하게 항상 보인다. `file`이 없으면 점프 링크가 없다.
 */
export interface Anchor {
  block?: string;
  file?: string;
  line?: number;
}

/** `file:line` 근거 한 줄 + 발췌 (아키텍처 L0 근거 · 의존성 서비스 근거 · 변경 로그 감지 근거) */
export interface Evidence {
  anchor: Anchor;
  /** 그 줄의 발췌. 환경변수 **값**은 절대 넣지 않는다 (view-architecture 3절 "L0 노드 — 캐시 · 큐 · 외부 API") */
  excerpt?: string;
  source: SourceKind;
}

/** 마지막 `plumb check`의 식별 (view-verification 3.1, view-flow 3절 "마지막 실행 커밋 · 시각") */
export interface LastCheck {
  runId: CheckRunId;
  commit: string;
  finishedAt: string;
}

/**
 * "검사 범위 밖" — 생략 불가 (view-verification 3.4, view-flow 6절 3번). 검증 View와 흐름도 View가 같은 타입을 쓴다.
 * 블록 필터와 무관하게 전체 값을 유지한다 (view-verification 4절).
 */
export interface OutOfScope {
  /** 파서: 블록 그래프 − 저장소: 규칙 `block`. 규칙이 하나도 없는 L1 블록 */
  blocksWithoutRules: string[];
  /** 블록 안 파일 중 어느 규칙의 `scope`에도 안 맞는 것. 디렉토리로 접어 표시 */
  codeWithoutRules: Array<{ path: string; files: number; block?: string }>;
  /** 승인된 규칙 중 scope 매칭 0개 또는 검사 파일 없음 */
  rulesWithoutCode: Array<{ ruleId: RuleId; reason: 'no-match' | 'check-missing' }>;
  /**
   * 테스트가 안 지나간 흐름. A안(trace)이면 점선 노드 단위, B안(static)이면 테스트 없는 진입점 단위 (view-flow 2.3).
   * 트레이스도 정적 그래프도 없으면 "측정 불가" — 0이라고 쓰지 않는다 (view-verification 3.4)
   */
  untestedFlows:
    | { mode: FlowMode; count: number; total: number; items: UncoveredFlow[] }
    | { unavailable: 'no-trace' | 'no-graph' };
  /** 파서: 블록 그래프. 항상 표시 (기획안 §12) */
  unclassifiedFiles: number;
  /** 실행: `plumb check` `quarantined[]` (기획안 §7.5) */
  quarantined: Quarantine[];
}

/** 검사 범위 밖에 올라가는 흐름 한 건 (view-flow 6절 3번 `{ kind: 'uncovered-flow', scenarioOrEntry, nodeIds[], mode }`) */
export interface UncoveredFlow {
  kind: 'uncovered-flow';
  /** FlowScenario.id */
  scenarioOrEntry: string;
  nodeIds: string[];
  mode: FlowMode;
}

/** 여섯 View의 합집합. `GET /api/views/:name` 응답의 `data` */
export type View =
  | ArchitectureView
  | FlowView
  | ChangelogView
  | VerificationView
  | DependenciesView
  | ContractView;

// ---------------------------------------------------------------------------
// 아키텍처 (view-architecture 3절 · 6절 1번)
// ---------------------------------------------------------------------------

/** 블록 수준 (기획안 §12). L2·L3은 이 View에 없다 */
export type BlockLevel = 'L0' | 'L1';

/**
 * 블록 종류. `entry` = `app/` Route Handler (view-architecture 6절 6번), `test` = `test/` (view-dependencies 6절 4번),
 * `unclassified` = 미분류 노드. L0 종류는 설정·인프라 파일에서 감지된 것만 — 추정으로 노드를 만들지 않는다
 */
export type BlockKind = 'app' | 'entry' | 'domain' | 'test' | 'db' | 'cache' | 'queue' | 'external-api' | 'unclassified';

/** L0 인프라 종류. "큐: 감지된 설정 없음"의 큐가 이것 */
export type InfraKind = 'db' | 'cache' | 'queue' | 'external-api';

/**
 * 블록 노드. 파서: dependency-cruiser JSON → 블록 그래프 JSON (view-architecture 3절 "L1 블록 노드", "L0 노드 — 앱/DB/캐시·큐·외부 API").
 * README 2의 블록 트리와 같은 JSON (`GET /api/blocks`).
 */
export interface BlockNode {
  id: string;
  level: BlockLevel;
  kind: BlockKind;
  /** 블록 경계 글롭. 기본값 `src/domains/<이름>/`, 재정의는 config `blocks.<id>.include` */
  paths: string[];
  /** 공개 진입점 파일. 기본 `index.ts`, 재정의 `blocks.<id>.public` */
  public: string[];
  /** 파일 수 */
  files: number;
  /** L0 노드의 표시 이름 (PostgreSQL · Redis · "(이름 없음)") */
  label?: string;
  /** L0 노드를 만든 근거 file:line (view-architecture 2.2 "선택: PostgreSQL" 패널) */
  evidence?: Evidence[];
  /** L0 노드가 환경변수 이름으로 감지됐으면 그 이름 (값은 없다) */
  envVars?: string[];
}

/** 경계를 넘는 import 문 하나 (view-architecture 6절 1번 `imports[]`) */
export interface ImportSite {
  file: string;
  line: number;
  specifier: string;
  /** 대상 블록의 공개 진입점을 거치는가 → 필수 검사 (1)의 원자료 */
  viaPublic: boolean;
}

/** L1 간선. 파서: 블록 그래프 JSON. 라벨 숫자 = import 문 수 (모듈 수가 아니다) */
export interface BlockEdge {
  from: string;
  to: string;
  count: number;
  /** 파서: config `blocks.<from>.dependsOn`에 `to`가 있는가 (view-architecture 6절 2번 — 첫 슬라이스는 설정, 저장소 이관은 M10) */
  declared: boolean;
  imports: ImportSite[];
}

/** L0 간선 (앱 → 인프라). 라벨 첫 줄 = 근거(클라이언트 패키지 또는 환경변수 이름), 둘째 줄 = 그 근거를 쓰는 L1 블록 */
export interface InfraEdge {
  from: string;
  to: string;
  via: { kind: 'package'; name: string } | { kind: 'env'; name: string };
  /** 파서: import 분석 + 환경변수 이름 참조 스캔 (view-architecture 6절 4번). 스캔이 없으면 빈 배열 */
  blocks: string[];
}

/** 정적(1등급) 검사 결과. 상태는 두 가지뿐 — 정적 분석에는 🟡·🟠가 없다. `fail`은 위반 없이는 불가 */
export type StaticCheckResult =
  | { status: 'unchecked' }
  | { status: 'pass'; violations: [] }
  | { status: 'fail'; violations: [StaticViolation, ...StaticViolation[]] };

/** dependency-cruiser 위반 하나. 실행: plumb check. 줄 번호는 `from` 모듈의 해당 import 문 위치 */
export interface StaticViolation {
  rule: string;
  from: Anchor & { file: string; line: number };
  to: string;
  fromBlock: string;
  toBlock: string;
}

/** 공개 계약 시그니처 변경 한 건 (필수 검사 (3)). git: 공개 진입점 diff. 사유는 변경 로그 View가 맡는다 */
export interface SignatureChange {
  block: string;
  file: string;
  symbol: string;
  /** `tsc --declaration` 출력의 텍스트 diff (view-architecture 6절 3번 — M8에서 구조 비교로 바꿀 수 있다) */
  before?: string;
  after?: string;
  commit: string;
  /** 변경 로그 View의 이벤트. 감지 뒤 도구가 채운다 */
  eventId?: ChangeEventId;
  /** 그 이벤트에 결정 기록이 있는가 */
  decision?: DecisionId | 'no-record';
}

/** 필수 검사 3개 (기획안 §12). (1)(2)는 실행:, (3)은 git: */
export interface RequiredChecks {
  /** (1) 공개 계약으로만 접근 */
  publicAccessOnly: StaticCheckResult;
  /** (2) 선언된 방향만 · 순환 금지 */
  declaredDirectionsOnly: StaticCheckResult & { cycles: Array<{ blocks: string[] }> };
  /** (3) 공개 계약 시그니처 변경은 설계 변경 이벤트 */
  signatureChanges: { changes: SignatureChange[] } | { unavailable: 'no-git' };
  /** 이 결과가 나온 검사 */
  lastCheck?: LastCheck;
}

/**
 * 아키텍처 View. L0와 L1을 한 파일에 둔다 (view-architecture 6절 1번).
 * 요약 띠 · 필수 검사 · 미분류는 블록 필터와 무관하게 전체 값 (4절).
 */
export interface ArchitectureView {
  header: ViewHeader & { view: 'architecture' };
  /** 블록 그래프 JSON 헤더의 도구 (view-architecture 3절 "생성 커밋 · 시각 · 도구 버전") */
  tool: { name: string; version: string };
  blocks: BlockNode[];
  /** L1 간선 */
  edges: BlockEdge[];
  /** L0 간선 */
  infraEdges: InfraEdge[];
  /** 감지되지 않은 인프라 종류 → "큐: 감지된 설정 없음" 노드 */
  undetectedInfra: InfraKind[];
  /** 파서: 어느 블록 글롭에도 안 맞는 파일. 항상 표시, 0이어도 */
  unclassified: string[];
  requiredChecks: RequiredChecks;
  /** git: HEAD 커밋 하나의 변경 영향 범위 (view-architecture 6절 5번 — 첫 슬라이스는 커밋 하나) */
  impact: { commit: string; blocks: string[]; unclassified: number } | { unavailable: 'no-git' };
  /** 요약 띠. 위 항목들의 합 */
  summary: {
    blocks: number;
    crossingImports: number;
    violations: { access: number; direction: number };
    cycles: number;
    unclassified: number;
    contractChanges: number;
  };
  /** config 없음 → 모든 간선 "미선언" + 안내 (view-architecture 5절) */
  configMissing?: boolean;
  /** dependency-cruiser 실행 실패 시 (이전 성공 결과를 그릴 때 함께 보인다) */
  extractionError?: { exitCode: number; stderrTail: string[] };
}

// ---------------------------------------------------------------------------
// 흐름도 (view-flow 3절 · 6절 1·2번)
// ---------------------------------------------------------------------------

/** A안 `trace` · B안 `static`. 하나의 타입에 mode로 구분 (view-flow 6절 1번). 자동 전환은 `fallback` */
export type FlowMode = 'trace' | 'static';

/** 노드 종류 (view-flow 4.0 해상도: 공개 진입점 · 외부 시스템 · 이벤트 + 진입점과 내부 한 단계) */
export type FlowNodeKind = 'entry' | 'public' | 'internal' | 'external' | 'emit' | 'handler';

/**
 * 흐름 노드. id는 `<block>.<symbol>` · `ext:<system>:<op>` · `event:<topic>`.
 * A안: `evidence` (실선 span · 점선 static · both). B안: `testRef` (참조됨 · 내부 · 정적).
 * `file:line`은 두 안 모두 파서: 심볼 위치 (스팬 속성이 있어도 정본은 파서).
 */
export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  /** 표시 이름. `블록.공개함수` · `⬡ pg SELECT payments` · `emit payment.refunded` */
  label: string;
  anchor?: Anchor;
  children: FlowNode[];
  /** A안. 실행: OTel 스팬 / 파서: 정적 그래프 */
  evidence?: 'span' | 'static' | 'both';
  /** B안. 파서: 테스트 import 그래프 */
  testRef?: 'referenced' | 'internal' | 'static';
  /** 외부 시스템 노드. A안은 스팬 속성(`db.system` · `db.operation`), B안은 import 사실만(operation 없음) */
  external?: { system: string; operation?: string };
  /** B안에서 emit → 핸들러 연결이 정적으로 불확실할 때 ⚠ */
  handlerUnknown?: boolean;
  /** A안 실패 시나리오의 마지막 스팬 = "실패 지점" (view-flow 5절) */
  failurePoint?: boolean;
}

/**
 * 흐름 하나. A안은 시나리오(인수 테스트) 단위, B안은 진입점 단위 — 같은 타입에 `unit`으로 구분 (view-flow 6절 2번).
 */
export interface FlowScenario {
  id: string;
  unit: 'scenario' | 'entry';
  /** 실행: JUnit XML classname + name (A안) */
  testId?: { classname: string; name: string };
  /** 테스트 파일 위치 (B안 "테스트 있음: refund.spec.ts:12"도 여기) */
  test?: Anchor;
  /** 진입점 (B안 필수, A안은 루트 스팬이 HTTP를 거쳤을 때) */
  entry?: { method: string; path: string; anchor?: Anchor };
  /** 저장소: 검사 매핑으로 연결된 규칙과 상태 점 */
  rules: Array<{ ruleId: RuleId; status: RuleStatus }>;
  /** 실행: JUnit XML. B안이나 테스트 없는 진입점은 `none` */
  result: 'pass' | 'fail' | 'none';
  root: FlowNode;
  /** 이 흐름에서 점선 노드 수 (A안) 또는 테스트 없음 여부 (B안: 0 또는 1) */
  uncoveredCount: number;
  /** A안: 스팬 수. 0이면 "공개 진입점을 거치지 않는 테스트" 신호 (view-flow 5절) */
  spanCount?: number;
  /** A안: 정적 그래프에서만 도출된 시나리오 (테스트 없음). 이름은 노드 식별자로만 짓는다 */
  derivedFromStatic?: boolean;
  /** 블록 묶음 (좌측 목록). 파서: 블록 그래프 */
  block?: string;
}

/** 흐름도 View. `views/flow.json` */
export interface FlowView {
  header: ViewHeader & { view: 'flow' };
  mode: FlowMode;
  /** A안 설정인데 트레이스가 0개라 B안 표현으로 자동 전환했을 때. 조용히 A안인 척하지 않는다 (view-flow 5절) */
  fallback?: { reason: 'no-trace-files' | 'graph-failed' };
  lastCheck?: LastCheck;
  /** 실행: 트레이스 파일 개수 (A안) */
  traceCount?: number;
  /** 검증 View 검사 범위 밖에 올리는 값 */
  uncovered: { count: number; total: number; items: UncoveredFlow[] };
  scenarios: FlowScenario[];
  /** 정적 그래프 파서 실패 (A안이면 실선만 그린다) */
  graphError?: string;
  /** 진입점 0개 등 비어 있음 사유 */
  empty?: 'no-graph' | 'no-entries' | 'no-acceptance-tests';
}

// ---------------------------------------------------------------------------
// 기술 변경 로그 (view-changelog 3절 · 6절 1번)
// ---------------------------------------------------------------------------

/**
 * 설계 변경 이벤트 6종 (기획안 §6.2, view-changelog 1절). 의존성 도입/제거는 아이콘(⊕⊖)이 다르므로 두 리터럴로 둔다.
 * `rule-changed`만 git이 아니라 보호 저장소에서 감지한다.
 */
export type ChangeEventKind =
  | 'dependency-added'
  | 'dependency-removed'
  | 'block-boundary'
  | 'cross-block-dependency'
  | 'contract-changed'
  | 'rule-changed'
  | 'external-system';

/** 감지 근거 한 행. 근거마다 자기 출처를 단다 (view-changelog 2.2 "감지 근거" 표) */
export interface ChangeEvidence {
  source: SourceKind;
  anchor?: Anchor;
  before?: string;
  after?: string;
  /** 사람이 읽는 한 줄 (템플릿 + 식별자. 자유 문장 금지) */
  excerpt?: string;
}

/**
 * 설계 변경 이벤트. 저장소: `changelog/events.jsonl`. 감지기가 git diff + 파서 전후 비교로 만든다.
 * 에이전트의 자기 보고에 의존하지 않는다.
 */
export interface ChangeEvent {
  id: ChangeEventId;
  kind: ChangeEventKind;
  /** 종류별 템플릿에 식별자를 끼운 제목 (`redis` · `ioredis@5.4.1` · `payment → auth`) */
  title: string;
  /** 근거 파일의 소속 블록. 둘 이상이면 모두. 미분류면 빈 배열 + `unclassified: true` */
  blocks: string[];
  unclassified?: boolean;
  commit: string;
  /** 커밋이 어느 실행 범위에 들어가는가. 사람이 직접 한 커밋이면 `manual` */
  session: RunId | 'manual';
  at: string;
  evidence: ChangeEvidence[];
  decisionIds: DecisionId[];
  /** 기획안 §6.2 "사유 없음". 기록이 없거나 이유가 비어 있음을 구분한다 */
  noReason: null | 'no-record' | 'empty-reason';
  /** 근거 해시. 재실행해도 같은 근거면 같은 ID (멱등 키) */
  evidenceHash: string;
  /** `cross-block-dependency`일 때 depcruise 위반 여부 (실행:). 위반이 아니어도 이벤트다 */
  violation?: boolean;
  /** `rule-changed`일 때 검토 대기열 항목 */
  queueItemId?: `q-${string}`;
  /** 결정 기록 "연결" 행의 규칙과 상태 점 (저장소: 규칙 상태). 기록이 가리키는 규칙이 없으면 `exists: false` → "(없는 규칙)" */
  linkedRules: Array<{ ruleId: RuleId; status: RuleStatus | null; exists: boolean }>;
}

/** 커밋 묶음. 커밋 메시지는 보여주지 않는다 (에이전트 자기 보고) */
export interface CommitGroup {
  commit: string;
  at: string;
  session: RunId | 'manual';
  events: ChangeEvent[];
}

/** 기술 변경 로그 View. `views/changelog.json` */
export interface ChangelogView {
  header: ViewHeader & { view: 'changelog' };
  /** 기준 커밋 범위 `head ← base (n 커밋)`. 첫 실행이면 base 없음 → "기준 없음 · HEAD만" */
  range: { base?: string; head: string; commits: number };
  /** 사유 없는 설계 변경 이벤트 비율 (기획안 §14). 분모 0이면 `no-events` */
  metric: { noReason: number; total: number } | 'no-events';
  /** 최근 5회 검사의 비율 (실행: CheckRun.metrics). 5회 미만이면 있는 만큼 */
  trend: number[];
  groups: CommitGroup[];
  /** 이벤트에 연결되지 않은 결정 기록 (지표에 들어가지 않는다) */
  orphanDecisions: DecisionRecord[];
  /** 이유 외의 필드(기각 · 감수)가 빈 기록 수 — "사유 없음"과 별개 (view-changelog 6절 3번) */
  incompleteRecords: number;
  /** 종류별 감지 실패. 실패한 종류는 지표 분모에서 뺀다 */
  detectorErrors: Array<{ kind: ChangeEventKind; message: string }>;
}

// ---------------------------------------------------------------------------
// 테스트/검증 상태 (view-verification 3절 · 6절 6번)
// ---------------------------------------------------------------------------

/**
 * 규칙 행 하나. 모든 행이 같은 구조 (view-verification 2절 "규칙 행 하나를 펼친 모양").
 * 상태와 근거는 `detail` (rules.ts `RuleStatusDetail` — 🔴는 failures 없이 불가).
 */
export interface RuleRow {
  ruleId: RuleId;
  block?: string;
  kind: RuleKind;
  summary: string;
  statement: string;
  checks: CheckRef[];
  /** 검사 종류에서 유도한 등급 (기획안 §7.2). 검사가 없으면 없음 */
  grade?: Grade;
  detail: RuleStatusDetail;
  /** 실행: 위반 주입 기록 (M7) */
  validity?: Validity;
  /** 저장소: 승인 기록. 실패 상세는 `detail.failures`에 있고 여기엔 중복하지 않는다 */
  approvedAt?: string;
  approvedBy?: string;
  decision?: DecisionId;
  /** 잠정 상태가 된 시각 → ⚠ 체류 일수 */
  pendingSince?: string;
  /** 실행: 결과 커밋 · 시각 · 소요 */
  lastResult?: { commit: string; finishedAt: string; durationSec?: number };
  /** 최근 n회 상태 */
  history: RuleStatus[];
  /** 검사 파일 존재 여부 (파서). 없으면 "파일 없음" + ⬜ */
  checkFilesMissing?: string[];
}

/** 상태별 집계 */
export type StatusCounts = Record<RuleStatus, number>;

/** 블록별 집계 절 */
export interface VerificationBlock {
  id: string;
  rules: number;
  approved: number;
  byStatus: StatusCounts;
  lastCheck?: LastCheck;
  items: RuleRow[];
}

/** 블록 공통 — 필수 검사 (1)(2)(3)을 규칙 행처럼 그린 것. 상세는 아키텍처 View 링크 */
export interface CommonCheckRow {
  index: 1 | 2 | 3;
  title: string;
  result: StaticCheckResult | { status: 'events'; count: number; withDecision: number };
  anchor?: Anchor;
}

/** 테스트/검증 상태 View. `views/verification.json` */
export interface VerificationView {
  header: ViewHeader & { view: 'verification' };
  /** 실행: plumb check 해시 체인 검증 (M3는 `ok` 고정) */
  store: { status: 'ok' | 'tampered' | 'unverified' };
  lastCheck?: LastCheck;
  /** `plumb check` 실패 시 이전 성공 결과를 그릴 때 (view-verification 5절) */
  staleResult?: { exitCode: number; stderrTail: string[]; previousCommit: string };
  summary: {
    /** 잠정(🟡🟠) 규칙 수 + 검토 대기열 미처리 수. 상단 바 `⚠ n`과 같은 값 */
    unconfirmed: number;
    longestPendingDays?: number;
    longestPendingRule?: RuleId;
    rules: number;
    approved: number;
    byStatus: StatusCounts;
    checks: { junit: number; static: number };
    quarantined: number;
  };
  blocks: VerificationBlock[];
  common: CommonCheckRow[];
  outOfScope: OutOfScope;
  /** JUnit XML 없거나 깨짐 → 정적 검사만 반영 */
  junitMissing?: boolean;
}

// ---------------------------------------------------------------------------
// 외부 의존성 (view-dependencies 3절 · 6절 5번)
// ---------------------------------------------------------------------------

/** 외부 패키지 하나. 파서: lockfile + import 분석 */
export interface PackageEntry {
  name: string;
  version: string;
  /** `importers['.'].dependencies.<name>.specifier` (직접일 때) */
  specifier?: string;
  direct: boolean;
  scope: 'prod' | 'dev';
  /** import하는 블록. 테스트 파일은 `test` 블록 (view-dependencies 6절 4번). 설정 파일만이면 `config-only` */
  importedBy: string[];
  importSites: Array<Anchor & { file: string; line: number }>;
  /** lockfile 엔트리 위치 */
  lockfile: Anchor;
  /** 직접인데 import 분석에 한 번도 안 나타남 ▲. 분석이 없으면 `null` ("▲ ?") */
  unused: boolean | null;
  /** 간접 의존 수 */
  transitive?: number;
  /** 저장소: 규칙 `constraint.targets` + 실행: 상태 */
  rules: Array<{ ruleId: RuleId; status: RuleStatus }>;
  /** git: 최초 도입 커밋 + 저장소: 결정 기록 */
  introduced?: { commit: string; at: string; decision?: DecisionId | 'no-record' };
}

/** 외부 서비스 하나. 파서: 설정 파일 · 환경변수 이름 (값은 읽지 않는다). 아키텍처 View L0 노드와 같은 파서 */
export interface ServiceEntry {
  kind: InfraKind;
  /** 이름을 알 수 없으면 없음 → "(이름 없음)" */
  name?: string;
  evidence: Evidence[];
  /** 어댑터 내장 매핑표 + config `services` 재정의 */
  clientPackages: string[];
  usedBy: string[];
  rules: Array<{ ruleId: RuleId; status: RuleStatus }>;
}

/** 의존성 이벤트 (git: lockfile diff). 변경 로그 View의 부분집합 */
export interface DependencyEvent {
  commit: string;
  at: string;
  changes: Array<{
    name: string;
    kind: 'added' | 'removed' | 'changed';
    from?: string;
    to?: string;
    direct: boolean;
  }>;
  /** 간접 변화 수 합계 */
  transitiveChanges: number;
  decision: DecisionId | 'no-record';
  eventId?: ChangeEventId;
}

/** 외부 의존성 View. `views/dependencies.json` */
export interface DependenciesView {
  header: ViewHeader & { view: 'dependencies' };
  lockfile:
    | { path: string; format: 'pnpm'; version: string }
    | { path: string; unsupported: string }
    | { missing: true };
  /** import 분석(dependency-cruiser) 결과가 있는가. 없으면 `importedBy` 열 전체 "분석 없음" */
  importAnalysis: 'available' | 'missing';
  packages: PackageEntry[];
  services: ServiceEntry[];
  undetectedInfra: InfraKind[];
  /** 기본 30일. `&since=`로 바꾼다 */
  events: { since: string; items: DependencyEvent[] } | { unavailable: 'no-git' };
  summary: {
    direct: { total: number; prod: number; dev: number };
    transitive: number;
    unusedDirect: number | null;
    services: number;
    recentEvents: number;
    recentNoReason: number;
  };
}

// ---------------------------------------------------------------------------
// 데이터 모델 / 계약 (view-data-contract 3절 · 6절 6번)
// ---------------------------------------------------------------------------

/** 계약 파일 한 줄 (계약 상태 띠). 파서: 현재 해시 + 저장소: 승인 해시 */
export interface ContractFile {
  path: string;
  kind: 'openapi' | 'prisma' | 'asyncapi';
  exists: boolean;
  /** 내용 SHA-256 */
  hash?: string;
  approved?: { hash: string; decision?: DecisionId; approvedAt: string; commit: string };
  /** 같으면 match, 다르면 changed, 승인 기록 없으면 unapproved, 파일 없으면 missing */
  status: 'match' | 'changed' | 'unapproved' | 'missing';
  /** 승인 ID를 가리키는 run이 없거나 미완료 → "파이프라인 대기" (저장소: runs/*.json) */
  pipelinePending?: { decision: DecisionId; runId?: RunId };
  /** 파싱 실패 (이전 성공 결과를 대신 그리지 않는다) */
  parseError?: { message: string; anchor?: Anchor };
}

/** Prisma 모델 필드. 파서: DMMF `datamodel.models[].fields[]` */
export interface ModelField {
  name: string;
  type: string;
  isRequired: boolean;
  isList: boolean;
  isId: boolean;
  isUnique: boolean;
  default?: string;
  documentation?: string;
  anchor?: Anchor;
  /** 승인 해시 이후 추가됨 △ (git) */
  addedSinceApproval?: boolean;
}

/** Prisma 모델. `file:line`은 스키마 텍스트에서 `^model <이름> \{`를 찾아 붙인다 */
export interface Model {
  name: string;
  fields: ModelField[];
  anchor: Anchor;
  /** 소유 블록. 파서로 알 수 없으므로 첫 슬라이스는 비움 (view-data-contract 6절 2번) */
  block?: string;
}

/** 관계. 파서: DMMF `fields[].kind == "object"` */
export interface Relation {
  from: string;
  to: string;
  name?: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  onDelete?: string;
  fromFields: string[];
  toFields: string[];
}

export interface EnumDef {
  name: string;
  values: string[];
  anchor?: Anchor;
}

/** OpenAPI 스키마 (요청·응답). `$ref` 해소 뒤 */
export interface SchemaRef {
  name?: string;
  properties: Array<{ name: string; type: string; required: boolean; format?: string; minimum?: number }>;
}

/** 엔드포인트 하나. 파서: OpenAPI + 파서: 블록 그래프 */
export interface Operation {
  method: string;
  path: string;
  operationId?: string;
  anchor: Anchor;
  request?: SchemaRef;
  responses: Array<{ code: string; schema?: SchemaRef }>;
  /** `tags[0]`과 핸들러 import 대상 블록. 둘이 다르면 🟠 (view-data-contract 6절 3번 — 둘 다 보인다) */
  block: { fromTags?: string; fromHandler?: string; mismatch: boolean };
  /** Route Handler 파일 + 공개 진입점 사용 여부 */
  handler?: { anchor: Anchor; viaPublic: boolean };
  /** 이름이 같은 Prisma 모델과의 필드 집합 차이 ⚠ (기계적 비교만) */
  schemaModelDiff?: Array<{ schema: string; model: string; onlyInSchema: string[]; onlyInModel: string[] }>;
}

/** 계약 변경 diff. git: 승인 해시의 커밋 → HEAD */
export interface ContractDiff {
  file: string;
  hunks: Array<{ anchor: Anchor & { file: string; line: number }; added: number; removed: number; excerpt?: string }>;
  decision?: DecisionId;
  /** 코드 불일치 🔴 → 파이프라인 대기 */
  codeConformance?: 'pass' | 'fail' | 'none';
}

/** 데이터 모델 / 계약 View. `views/contract.json` */
export interface ContractView {
  header: ViewHeader & { view: 'contract' };
  files: ContractFile[];
  db?: { models: Model[]; enums: EnumDef[]; relations: Relation[] };
  api?: { operations: Operation[] };
  events?: { channels: Array<{ name: string; messages: Array<{ name: string; payload?: SchemaRef }> }> };
  /**
   * 코드 일치. 실행: `checks[].kind == 'contract'`인 검사의 합계 (view-data-contract 6절 4번).
   * `fail`은 실패 수 ≥ 1일 때만. 계약 테스트가 없으면 `none`
   */
  codeConformance:
    | { status: 'none'; reason: 'no-contract-tests' | 'not-run' }
    | { status: 'pass'; passed: number; failed: 0; ruleIds: RuleId[]; lastCheck: LastCheck }
    | { status: 'fail'; passed: number; failed: number; ruleIds: RuleId[]; failures: CheckFailure[]; lastCheck: LastCheck };
  diff: ContractDiff[] | { unavailable: 'no-git' | 'no-approved-contract' };
}

// ---------------------------------------------------------------------------
// 화면 상태 (사용자 입력: URL 쿼리). 데이터가 아니라 선택 상태 — 서버에 저장되지 않는다
// ---------------------------------------------------------------------------

/**
 * `/views` URL 쿼리 (work-views 3절 "선택된 탭" · "블록 필터", view-architecture 4절 `level`,
 * view-flow 3절 `scenario`, view-dependencies 4절 `since`, view-verification 4절 상태 토글 · 정렬,
 * view-changelog 3절 필터).
 */
export interface ViewQuery {
  /** 없으면 `architecture`. 알 수 없는 값은 "그런 View 없음" */
  view?: ViewName;
  /** 블록 트리 클릭. 칩의 ×로 해제 */
  block?: string;
  /** 아키텍처 수준 토글 */
  level?: BlockLevel;
  /** 흐름도 시나리오·진입점 선택 (FlowScenario.id) */
  scenario?: string;
  /** 의존성 이벤트 · 변경 로그 기간 (커밋 또는 날짜) */
  since?: string;
  /** 검증 상태 토글. 없으면 전부 켜짐 */
  statuses?: RuleStatus[];
  /** 검증 정렬 */
  sort?: 'status' | 'block' | 'pending' | 'approvedAt';
  /** 변경 로그 종류 필터 · 사유 없음만 */
  kind?: ChangeEventKind;
  noReasonOnly?: boolean;
  /** 의존성 [직접만] / [전체] */
  packages?: 'direct' | 'all';
}

/** 검사 종류 → 화면 라벨. 인수 테스트 · 계약 테스트 · PBT · 정적 분석 · 트레이스 */
export type CheckKindLabel = Record<CheckKind, string>;
