/**
 * UI 서버 API 요청·응답 타입과 오류 코드 — README 3.3 표 + 이슈 #5 코멘트(#2·#3에서 넘어온 항목).
 *
 * 모든 `/api/**`는 토큰 쿠키를 요구한다 (README 3.2). 없거나 틀리면 401 ({@link ApiError}).
 * 쓰기 API(approve · reject · runs · abort · open · regenerate)는 에이전트가 쿠키 없이 부르면 401 — 기획안 §15.1 "에이전트는 승인할 수 없다".
 *
 * 추가된 경로: `POST /api/runs/:id/abort` (work-run 6절 2번), `POST /api/views/regenerate` (view-architecture 4절, 이슈 코멘트).
 */

import type {
  Approval,
  ApprovalState,
  CodeOpenReason,
  CodeOpenRecord,
  DecisionId,
  DecisionRecord,
  Proposal,
  ProposalId,
  Rule,
  RuleId,
  RuleKind,
  RuleStatus,
  RuleStatusDetail,
  CheckRef,
} from './rules';
import type { RunId, RunState, RunSummary } from './run';
import type { Anchor, BlockNode, View, ViewHeader, ViewName } from './views';

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------

/**
 * 오류 응답 본문. HTTP 상태 코드와 `code`가 함께 간다.
 * 401 세션 없음 · 400 요청이 성립하지 않음 · 404 없음 · 409 화면이 본 것과 서버 상태가 다름 · 500 프로세스 실패.
 */
export type ApiError =
  | { status: 401; code: 'unauthenticated'; message: string }
  | {
      status: 400;
      /** `rule-not-approved`: 미승인 규칙 포함 (work-run 4절) · `queue-limit`: 대기열 상한으로 신규 제안 중단 (M10, §9.2) · `no-budget`: 상한 없음 (work-run 5절) · `reason-required`: 기각 사유 비어 있음 */
      code: 'rule-not-approved' | 'queue-limit' | 'no-budget' | 'reason-required' | 'invalid-body' | 'rules-parse-error';
      message: string;
      ruleIds?: RuleId[];
      /** `rules-parse-error`일 때 줄 번호 (work-approve 4절) */
      line?: number;
    }
  | { status: 404; code: 'view-not-found' | 'rule-not-found' | 'run-not-found' | 'proposal-not-found'; message: string }
  | {
      status: 409;
      /** `proposal-changed`: 화면을 연 뒤 제안이 바뀜(재제안 · CLI 승인) → 다시 읽기 (work-approve 4절) · `run-in-progress`: 동시 실행 1개 (work-run 6절 1번) · `run-finished`: 이미 끝난 실행에 abort · `store-tampered`: 변조 증거 상태에서는 승인하지 않는다 (M10) */
      code: 'proposal-changed' | 'run-in-progress' | 'run-finished' | 'store-tampered' | 'regenerate-in-progress';
      message: string;
      /** `run-in-progress`일 때 진행 중인 실행 */
      runId?: RunId;
    }
  | { status: 500; code: 'spawn-failed' | 'store-write-failed'; message: string };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// ---------------------------------------------------------------------------
// GET /api/status — 상단 바 (README 2 표)
// ---------------------------------------------------------------------------

export interface StatusResponse {
  /** 파서: `plumb.config.json` 대상 경로 이름 */
  project: string;
  /** 실행: 해시 체인 검증 (M3는 `ok` 고정) */
  store: { status: 'ok' | 'tampered' | 'unverified' };
  /** 저장소: 마지막 `plumb check` */
  lastCheck?: { commit: string; finishedAt: string };
  /** `⚠ n` = 잠정 규칙 수 + 검토 대기열 미처리 수 */
  unconfirmed: { total: number; provisionalRules: number; reviewQueue: number };
}

// ---------------------------------------------------------------------------
// GET /api/blocks — 블록 트리 (README 2 표)
// ---------------------------------------------------------------------------

export interface BlocksResponse {
  blocks: Array<BlockNode & { worstStatus: RuleStatus | null }>;
  unclassified: number;
  /** 블록 그래프가 아직 없으면 ("블록 아직 없음") */
  empty?: 'no-graph';
}

// ---------------------------------------------------------------------------
// GET /api/rules · GET /api/rules/:id (work-approve 3.1 · 3.2)
// ---------------------------------------------------------------------------

/** 목록 한 행 */
export interface RuleListItem {
  id: RuleId;
  block?: string;
  /** 블록 트리에 없는 블록이면 화면은 `?` */
  blockKnown: boolean;
  kind: RuleKind;
  statement: string;
  status: RuleStatus;
  /** 상태의 커밋 · 시각. 검사 이력 없으면 없음 ("검사 없음") */
  statusAt?: { commit: string; checkedAt: string };
  approval: ApprovalState;
  /** `risk: high` 또는 블록이 고위험 선언 (config `blocks.<id>.risk`) */
  highRisk: boolean;
  /** 사전 승인 대기 중인 제안이 있는가 */
  pendingProposal?: ProposalId;
}

/** `/rules` URL 쿼리 (work-approve 3.1 "필터"). 사용자 입력. 기본은 전체 (6절 5번). 목록은 클라이언트에서 거른다 */
export interface RuleListFilter {
  block?: string;
  kind?: RuleKind;
  approval?: ApprovalState;
  status?: RuleStatus;
  /** 선택한 규칙 (`/rules?id=`) */
  id?: RuleId;
}

export interface RuleListResponse {
  rules: RuleListItem[];
  /** 머리줄: 미확인 n건 · 최장 n일 체류 */
  unconfirmed: number;
  longestPendingDays?: number;
  /** §9.2 상한. 넘으면 경고 띠 (M10부터 신규 제안 중단) */
  queueLimit: { exceeded: boolean; maxUnconfirmed: number; maxDays: number };
}

/** 의존 규칙과 그 상태 */
export interface DependencyStatus {
  ruleId: RuleId;
  status: RuleStatus;
  exists: boolean;
}

/** 부착된 검사 파일 한 줄 */
export interface CheckDetail {
  check: CheckRef;
  /** 파서: 대상 레포에 파일이 있는가 */
  exists: boolean;
  /** 실행: 마지막 `plumb check`의 결과 */
  lastResult?: { outcome: 'pass' | 'fail' | 'error' | 'skipped'; commit: string; finishedAt: string; anchor?: Anchor };
}

/** 변경 diff 한 줄. 보호 저장소는 git 밖이므로 `git:`이 아니라 `저장소:` 비교 */
export interface RuleDiffLine {
  op: '+' | '-' | ' ';
  field: keyof Rule;
  text: string;
}

export interface RuleDetailResponse {
  /** 현재 승인된 버전. 신규 제안만 있으면 없음 */
  rule?: Rule;
  approval: ApprovalState;
  /** 현재 잠정 또는 대기 중인 제안 */
  proposal?: Proposal;
  diff: RuleDiffLine[];
  /** 승인 이력 전체 (제안 → 승인/기각 → 재제안 …) */
  approvals: Approval[];
  /** `rule.decision`이 가리키는 기록. 파일이 없으면 `missing` — 승인은 막지 않는다 */
  decision?: DecisionRecord | { missing: DecisionId };
  depends: DependencyStatus[];
  checks: CheckDetail[];
  status: RuleStatusDetail;
  statusAt?: { commit: string; checkedAt: string };
  highRisk: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/rules/:id/approve · POST /api/rules/:id/reject (work-approve 4절, 이슈 코멘트 409)
// ---------------------------------------------------------------------------

/** 화면이 본 제안을 함께 보낸다. 서버의 현재 제안 해시와 다르면 409 `proposal-changed` */
export interface ApproveRequest {
  proposalId: ProposalId;
  proposalHash: string;
}

/** 200. 상태(🟢 등)는 바뀌지 않는다 — 승인은 검사가 아니다 */
export interface ApproveResponse {
  approval: Approval;
  approvalState: 'approved';
  /** 상단 바 `⚠ n` 갱신용 */
  unconfirmed: number;
}

/** 사유 필수. 비어 있으면 400 `reason-required` (work-approve 6절 6번) */
export interface RejectRequest extends ApproveRequest {
  reason: string;
}

export interface RejectResponse {
  approval: Approval;
  approvalState: 'rejected';
  unconfirmed: number;
}

/** approve · reject의 오류: 401 · 400(reason-required) · 404 · 409(proposal-changed · store-tampered) */
export type ApproveError = Extract<ApiError, { status: 401 | 404 | 409 }> | Extract<ApiError, { status: 400 }>;

// ---------------------------------------------------------------------------
// POST /api/runs · GET /api/runs · GET /api/runs/:id · POST /api/runs/:id/abort (work-run 3절 · 4절 · 6절 2·7번)
// ---------------------------------------------------------------------------

export interface CreateRunRequest {
  ruleIds: RuleId[];
}

/** 201. UI 서버가 `plumb run --detach --rules …`를 spawn하고 ID만 돌려준다 */
export interface CreateRunResponse {
  id: RunId;
}

/** 오류: 401 · 400(rule-not-approved · queue-limit · no-budget) · 409(run-in-progress) · 500(spawn-failed) */
export type CreateRunError = Extract<ApiError, { status: 401 | 400 | 409 | 500 }>;

export interface RunListResponse {
  runs: RunSummary[];
}

/** `GET /api/runs/:id` = `runs/<id>.json` 그대로. 출력 꼬리는 `capturedOutput`에 포함 (work-run 6절 7번 (c): 별도 경로 없음) */
export type RunDetailResponse = RunState;

/** `POST /api/runs/:id/abort`. UI 서버가 `pid`로 SIGTERM (README 3.4). 202 — 실제 종료는 파일 폴링으로 확인 */
export interface AbortRunRequest {
  /** 확인 대화창을 거쳤음을 명시 */
  confirm: true;
}

export interface AbortRunResponse {
  id: RunId;
  requested: true;
  signal: 'SIGTERM';
}

/** 오류: 401 · 404(run-not-found) · 409(run-finished) */
export type AbortRunError = Extract<ApiError, { status: 401 | 404 | 409 }>;

// ---------------------------------------------------------------------------
// GET /api/views/:name · POST /api/views/regenerate (work-views 3절 · 6절 5번, view-architecture 4절, 이슈 코멘트)
// ---------------------------------------------------------------------------

/**
 * View 하나. 머리말과 렌더링된 Markdown(Mermaid 포함)과 구조 데이터를 함께 준다 (work-views 6절 1번 (b)).
 * `header.commit`과 현재 HEAD가 다르면 `stale`.
 */
export interface ViewResponse {
  header: ViewHeader;
  markdown: string;
  data: View;
  /** git: 현재 HEAD와 생성 커밋 비교. 머리말에 커밋이 없으면 비교하지 않는다 → 없음 */
  stale?: { head: string };
  /** 저장소: `code-opens.jsonl`에서 이 View · 이 생성 커밋 이후 레코드 수 */
  codeOpens: number;
}

/** 오류: 401 · 404(view-not-found: `views/<name>.*` 없음 또는 알 수 없는 이름) */
export type ViewError = Extract<ApiError, { status: 401 | 404 }>;

/** 비우면 전부. UI 서버가 `plumb views [names]`를 spawn한다 (실행 중이면 409) */
export interface RegenerateViewsRequest {
  names?: ViewName[];
}

export interface RegenerateViewsResponse {
  started: true;
  names: ViewName[];
}

export type RegenerateViewsError = Extract<ApiError, { status: 401 | 404 | 409 | 500 }>;

// ---------------------------------------------------------------------------
// POST /api/open — 코드 열람 점프 (README 2.2, work-views 4절)
// ---------------------------------------------------------------------------

/** 이유를 고르지 않으면 요청 자체가 성립하지 않는다 (`reason` 필수) */
export interface CodeOpenRequest {
  view: ViewName;
  item: string;
  file: string;
  line?: number;
  reason: CodeOpenReason;
  note?: string;
}

/** 200. IDE 명령이 실패해도 기록은 남고 `record.result.status`가 `failed` (work-views 6절 3번) */
export interface CodeOpenResponse {
  record: CodeOpenRecord;
  codeOpens: number;
}

export type CodeOpenError = Extract<ApiError, { status: 401 | 400 }>;

// ---------------------------------------------------------------------------
// 경로 ↔ 타입 표 (README 3.3)
// ---------------------------------------------------------------------------

/** README 3.3 표를 타입으로 옮긴 것. 키 = `METHOD 경로` */
export interface ApiSurface {
  'GET /api/status': { response: StatusResponse; error: Extract<ApiError, { status: 401 }> };
  'GET /api/blocks': { response: BlocksResponse; error: Extract<ApiError, { status: 401 }> };
  'GET /api/rules': { response: RuleListResponse; error: Extract<ApiError, { status: 401 | 400 }> };
  'GET /api/rules/:id': { response: RuleDetailResponse; error: Extract<ApiError, { status: 401 | 404 }> };
  'POST /api/rules/:id/approve': { request: ApproveRequest; response: ApproveResponse; error: ApproveError };
  'POST /api/rules/:id/reject': { request: RejectRequest; response: RejectResponse; error: ApproveError };
  'POST /api/runs': { request: CreateRunRequest; response: CreateRunResponse; error: CreateRunError };
  'GET /api/runs': { response: RunListResponse; error: Extract<ApiError, { status: 401 }> };
  'GET /api/runs/:id': { response: RunDetailResponse; error: Extract<ApiError, { status: 401 | 404 }> };
  'POST /api/runs/:id/abort': { request: AbortRunRequest; response: AbortRunResponse; error: AbortRunError };
  'GET /api/views/:name': { response: ViewResponse; error: ViewError };
  'POST /api/views/regenerate': { request: RegenerateViewsRequest; response: RegenerateViewsResponse; error: RegenerateViewsError };
  'POST /api/open': { request: CodeOpenRequest; response: CodeOpenResponse; error: CodeOpenError };
}
