/**
 * 어댑터 인터페이스 (기획안 §4.2 코어와 어댑터, 이슈 #8).
 *
 * 기획은 프로젝트나 언어에 따라 바뀌지 않는다. 언어·프레임워크에 따라 달라지는 부분을 어댑터로 분리하고,
 * 코어는 **공통 형식**만 읽는다 — 실행 트레이스 OpenTelemetry · 테스트 결과 JUnit XML · 계약 OpenAPI·AsyncAPI·DB 스키마 ·
 * 의존 관계 블록 그래프 JSON(자체 정의). 어댑터는 스택마다 다르고, 갈아 끼운다 (첫 어댑터는 Next.js, §4.4).
 *
 * 설계 기준:
 * - 어댑터가 하는 일은 다섯 가지뿐 — 의존성 추출 · 인터페이스 스텁 생성 · 테스트 러너 연결 · 스키마 읽기 · 트레이스 수집.
 *   판정(규칙 상태 계산 · View 렌더링)은 코어가 한다. 어댑터는 원자료만 공통 형식으로 돌려준다
 * - 자기 보고는 입력이 아니다 → 반환 타입에 "성공했다" 같은 서술 필드가 없다. exit code · 파일 경로 · 가로챈 출력만 있다
 * - 없는 것은 없다고 말한다 → 트레이스가 없으면 `{ unavailable: 'no-trace' }` (0개라고 쓰지 않는다. view-flow 5절)
 *
 * 반환 타입 가운데 `packages/core/src/types/views.ts`에 이미 있는 것(`BlockNode` `BlockEdge` `InfraEdge` `Model` `Operation` …)은
 * 그대로 쓴다. 거기 없는 것({@link BlockGraph} {@link StubResult} {@link TestRunResult} {@link SchemaSet} {@link TraceResult})은
 * 여기 둔다. 인터페이스 밖이던 두 능력 — 정적 검사({@link StaticCheckRun}, #44 · #47)와 정적 호출 그래프({@link StaticCallGraph}, #59) —
 * 의 타입도 #63에서 여기로 모았다. `buildCallGraph`는 선택 메서드, `runStaticChecks`는 어댑터 패키지의 모듈 export(`adapter/load.ts`).
 */

import type { PlumbConfig } from '../types/config.js';
import type { CheckResult } from '../types/rules.js';
import type { CapturedOutput } from '../types/run.js';
import type {
  Anchor,
  BlockEdge,
  BlockNode,
  EnumDef,
  FlowNode,
  InfraEdge,
  InfraKind,
  Model,
  Operation,
  Relation,
  SchemaRef,
} from '../types/views.js';

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** 어댑터 이름. 설정 `adapter` 필드의 값과 같다 (`plumb.config.json` → `PlumbConfig.adapter`) */
export type AdapterName = PlumbConfig['adapter'];

/**
 * 모든 어댑터 메서드의 첫 인자. 대상 레포의 루트와 그 설정.
 * 어댑터는 `root` 밖을 읽거나 쓰지 않는다 (기획안 §8.6 파일시스템 격리의 전제).
 */
export interface AdapterContext {
  /** 대상 레포의 절대 경로 (`plumb --target`) */
  root: string;
  /** 파싱된 `plumb.config.json` */
  config: PlumbConfig;
}

/**
 * 공통 형식을 만든 도구와 버전. View 머리말 `SourceRef.tool/version`의 원자료.
 * 도구가 대상에 설치되어 있지 않으면 `version: 'unknown'` (#49. `string | null`은 머리말 문구 변경이라 #63에서 보류)
 */
export interface ToolInfo {
  name: string;
  version: string;
}

// ---------------------------------------------------------------------------
// 1. 의존성 추출 → 블록 그래프 JSON (기획안 §4.2 · §12, view-architecture 6절 1번)
// ---------------------------------------------------------------------------

/**
 * 블록 그래프 JSON — 자체 정의 공통 형식 (기획안 §4.2). 파서 출력이므로 검사 결과(`requiredChecks`)나 git 정보(`impact`)는 없다.
 * `ArchitectureView`(views.ts)는 이 그래프 + 검사 결과 + git을 합쳐 만든다. L0와 L1을 한 파일에 둔다 (docs/types/README.md 결정 1).
 *
 * 타입 이식 후보: `BlockNode` `BlockEdge` `InfraEdge`는 views.ts의 것을 그대로 쓰고, 이 묶음만 여기 있다.
 */
export interface BlockGraph {
  /** 추출 시각 (ISO 8601) */
  generatedAt: string;
  /** 추출 시점의 HEAD. git이 없으면 없음 */
  commit?: string;
  /** dependency-cruiser 등 추출 도구 */
  tool: ToolInfo;
  /** L0 · L1 블록 노드 */
  blocks: BlockNode[];
  /** L1 간선 (블록 → 블록). 라벨 숫자 = import 문 수 */
  edges: BlockEdge[];
  /** L0 간선 (앱 → 인프라). 환경변수 이름 참조 스캔은 여기서 한다 (view-architecture 6절 4번 → `InfraEdge.blocks`) */
  infraEdges: InfraEdge[];
  /** 감지되지 않은 인프라 종류 → "큐: 감지된 설정 없음" */
  undetectedInfra: InfraKind[];
  /** 어느 블록 글롭에도 안 맞는 파일. 항상 돌려준다, 0개여도 (기획안 §12 "미분류 파일 수 항상 표시") */
  unclassified: string[];
  /** 외부 패키지 → 그것을 import하는 블록 ID (미분류 파일의 import는 `'unclassified'`). 의존성 View `importedBy`의 재료 (#50) */
  externals?: Record<string, string[]>;
  /** 정적 검사가 남긴 dependency-cruiser JSON을 재사용했으면 그 경로(루트 기준). 직접 실행했으면 없음 (#50) */
  reusedReport?: string;
}

// ---------------------------------------------------------------------------
// 2. 인터페이스 스텁 생성 (기획안 §4.4 `tsc --declaration` · §8.6 파일시스템 격리)
// ---------------------------------------------------------------------------

/**
 * 공개 인터페이스 스텁 생성 결과. 테스트 작성자(test-writer)의 디렉토리에는 구현 본문 대신 스텁(`.d.ts`)과 계약 파일만 둔다 (§8.6).
 * 코어는 이 목록을 `.work/test-writer/`로 옮기고 `src/**` 읽기 차단 hook을 건다 (M4).
 */
export interface StubResult {
  /** 스텁을 쓴 디렉토리 (호출자가 넘긴 `outDir`의 절대 경로) */
  outDir: string;
  /** 생성된 파일. `outDir` 기준 상대 경로 */
  files: string[];
  /** 블록별 공개 진입점 스텁. 블록 ID → 파일 (`outDir` 기준). 공개 진입점이 없는 블록은 빠진다 */
  publicByBlock: Record<string, string[]>;
  /** `tsc` 등 생성 도구 */
  tool: ToolInfo;
  /** 생성 도구의 가로챈 출력. 선언 생성 오류가 있으면 여기 보인다 */
  output: CapturedOutput;
}

// ---------------------------------------------------------------------------
// 3. 테스트 러너 연결 → JUnit XML (기획안 §4.2 · §7.3)
// ---------------------------------------------------------------------------

/** 테스트 러너 실행 옵션. 파이프라인 단계 ②③은 `scope`로 인수 테스트만 돌린다 (기획안 §8.3) */
export interface TestRunOptions {
  /** 실행할 테스트 파일 글롭. 없으면 러너 기본값 */
  scope?: string[];
  /** JUnit XML을 쓸 경로. 없으면 `config.checks.junitReport` 또는 어댑터 기본값 */
  junitPath?: string;
  /** 러너 타임아웃 (ms) */
  timeoutMs?: number;
  /** 추가 환경변수 (값은 호출자가 넘긴 그대로. 어댑터는 로그에 쓰지 않는다) */
  env?: Record<string, string>;
}

/**
 * 테스트 러너 실행 결과. 코어의 JUnit XML 파서(M5)가 `junitPath`를 읽는다 — 어댑터는 파싱하지 않는다.
 * `junitPath`가 `null`이면 러너가 보고서를 만들지 못한 것 (죽음 · 설정 오류). 그래도 `output.exitCode`와 꼬리는 있다.
 */
export interface TestRunResult {
  /** JUnit XML 절대 경로. 파일이 만들어지지 않았으면 `null` */
  junitPath: string | null;
  /** 러너 프로세스 exit code (`output.exitCode`와 같다. 자주 쓰여서 올렸다) */
  exitCode: number;
  /** 가로챈 명령 출력 (명령 · 시각 · 꼬리 · 전체 로그 경로). 에이전트 자기 보고가 아니다 */
  output: CapturedOutput;
  /** 러너 도구 (vitest · playwright) */
  tool: ToolInfo;
}

// ---------------------------------------------------------------------------
// 4. 스키마 읽기 → OpenAPI · Prisma · AsyncAPI (기획안 §5.1, view-data-contract 6절)
// ---------------------------------------------------------------------------

/** 계약 파일 하나의 파싱 결과. 파일이 없으면 `missing`, 깨졌으면 `error` — 이전 성공 결과를 대신 돌려주지 않는다 */
export type SchemaFile<T> =
  | { path: string; status: 'parsed'; hash: string; tool: ToolInfo; data: T }
  | { path: string; status: 'missing' }
  | { path: string; status: 'error'; message: string; line?: number };

/** Prisma DMMF에서 추려낸 DB 스키마 (`ContractView.db`와 같은 모양) */
export interface DbSchema {
  models: Model[];
  enums: EnumDef[];
  relations: Relation[];
}

/** OpenAPI에서 추려낸 엔드포인트 (`ContractView.api`와 같은 모양). `Operation.block`은 코어가 블록 그래프와 맞춰 채운다 */
export interface ApiSchema {
  operations: Operation[];
  /** `components.schemas` 전부 (이름 · 필드 요약). 요청·응답이 참조하지 않는 스키마도 포함 (#66) */
  schemas?: SchemaRef[];
}

/** AsyncAPI에서 추려낸 채널·메시지 (`ContractView.events`와 같은 모양) */
export interface EventSchema {
  channels: Array<{ name: string; messages: Array<{ name: string; payload?: SchemaRef }> }>;
}

/**
 * 스키마 읽기 결과. 세 계약 파일의 위치는 `config.contracts` (기본값 세 파일).
 * 코어는 `hash`를 저장소의 승인 해시와 비교해 `ContractFile.status`를 낸다 (M8 데이터 모델·계약 View).
 */
export interface SchemaSet {
  openapi: SchemaFile<ApiSchema>;
  prisma: SchemaFile<DbSchema>;
  asyncapi: SchemaFile<EventSchema>;
}

// ---------------------------------------------------------------------------
// 5. 트레이스 수집 → OpenTelemetry 스팬 (기획안 §4.2, view-flow 6절 1번 A안)
// ---------------------------------------------------------------------------

/** 트레이스 수집 옵션. 수집은 테스트 실행과 함께 일어난다 — 어댑터가 `runTests`를 안에서 부르거나(`run !== false`) 남은 파일만 읽는다 */
export interface TraceCollectOptions {
  /** 트레이스 파일(OTLP JSON) 디렉토리. 없으면 어댑터 기본값 */
  traceDir?: string;
  /** 이 테스트들의 스팬만. JUnit `classname` + `name` (FlowScenario.testId) */
  testIds?: Array<{ classname: string; name: string }>;
  /** 함께 돌릴 테스트 파일 글롭 (`TestRunOptions.scope`) (#69) */
  scope?: string[];
  /** 러너 타임아웃 (ms) (#69) */
  timeoutMs?: number;
  /** `false`면 테스트를 다시 돌리지 않고 디렉토리의 파일만 읽는다. 기본 `true` (#69) */
  run?: boolean;
}

/**
 * OTel 스팬의 부분집합 — 흐름도 A안이 쓰는 필드만 (view-flow 4.0 해상도: 진입점 · 공개 함수 · 외부 시스템 · 이벤트).
 * 시간은 OTLP 그대로 unix nano 문자열. 속성은 `db.system` `db.operation` `http.method` `http.route` `messaging.destination` 등.
 */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: 'unset' | 'ok' | 'error'; message?: string };
  /** 스팬을 만든 테스트 (어댑터가 테스트 ID를 리소스 속성으로 심었을 때) */
  testId?: { classname: string; name: string };
}

/**
 * 트레이스 수집 결과. 파일이 하나도 없으면 `{ unavailable: 'no-trace' }` — 코어는 B안(static)으로 전환하고
 * `FlowView.fallback`에 적는다 (view-flow 5절 "조용히 A안인 척하지 않는다").
 */
export type TraceResult =
  | {
      spans: TraceSpan[];
      files: string[];
      tool: ToolInfo;
      /** 같은 실행의 테스트 결과 — 어댑터가 `runTests`를 안에서 돌렸을 때 (#69) */
      run?: TestRunResult;
    }
  | { unavailable: 'no-trace'; reason?: string; run?: TestRunResult };

// ---------------------------------------------------------------------------
// 6. 정적 검사 → `CheckResult[]` (이슈 #44 · #47, 기획안 §7.2 1등급)
// ---------------------------------------------------------------------------

/**
 * 정적 검사(dependency-cruiser) 실행 결과. 규칙 하나당 `CheckResult` 하나 (`check.kind: 'static'`, `ref: 'depcruise:<규칙>'`).
 * JSON이 안 생기면 `results: []` · `graphJsonPath: null` — 추정으로 pass · fail을 만들지 않는다.
 * `Adapter` 인터페이스 밖이다: 어댑터 패키지가 `runStaticChecks`를 모듈로 export하고 `adapter/load.ts`가 {@link StaticRunner}로 꺼낸다.
 */
export interface StaticCheckRun {
  results: CheckResult[];
  output: CapturedOutput;
  /** dependency-cruiser JSON 경로 (절대). 안 생겼으면 `null` */
  graphJsonPath: string | null;
  tool: ToolInfo;
}

/** 정적 검사 러너. `plumb check`(`checks/run-check.ts`)와 View 생성기(`views/types.ts`)가 주입받는다 */
export type StaticRunner = (ctx: AdapterContext) => Promise<StaticCheckRun>;

// ---------------------------------------------------------------------------
// 7. 정적 호출 그래프 → `FlowNode` 트리 (이슈 #59, view-flow 4.2 "정적 그래프는 두 안의 공통 재료")
// ---------------------------------------------------------------------------

/** 파서: 정적 호출 그래프. 진입점당 `FlowNode` 하나, 모든 노드 `evidence: 'static'` */
export interface StaticCallGraph {
  tool: ToolInfo;
  entries: FlowNode[];
  /** 노드 ID → `file:line` (스팬 이름을 역조회해 앵커를 붙인다 — 정본은 파서, view-flow 3절) */
  symbols: Record<string, Anchor>;
  /** 공개 진입점 노드 ID → 그것을 import하는 테스트 파일 (루트 기준). B안 "참조됨"의 재료 */
  testRefs: Record<string, string[]>;
  /** 못 본 것 (동적 import · DI · 핸들러 연결 등). 화면에 그대로 보인다 */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * 어댑터 — 기획안 §4.2 표의 다섯 역할. 스택마다 하나씩 구현하고 `registerAdapter`(registry.ts)로 등록한다.
 * 코어는 설정 `adapter: "nextjs"` 문자열로 찾는다. 다섯 메서드 모두 비동기이며 예외 대신 결과에 실패를 담는다
 * (exit code · `status: 'error'` · `unavailable`). 예외는 어댑터 자체의 결함(미구현 · 전제 미충족)일 때만.
 */
export interface Adapter {
  /** 어댑터 이름. 등록 이름과 같아야 한다 */
  readonly name: AdapterName;

  /**
   * 의존성 추출 → 블록 그래프 JSON (기획안 §4.2 "의존성 추출" · §12 블록).
   * Next.js 어댑터는 dependency-cruiser JSON을 블록 경계(디렉토리 기본 + `config.blocks` 글롭 재정의)로 접는다.
   * 소비: M8 wave 0 아키텍처 View (블록 그래프 → Mermaid) · M5 wave 0 1등급 검사 결과의 원자료.
   */
  extractDependencies(ctx: AdapterContext): Promise<BlockGraph>;

  /**
   * 공개 인터페이스 스텁 생성 (기획안 §4.4 `tsc --declaration` · §8.6 파일시스템 격리).
   * 테스트 작성자에게 구현 본문 대신 `.d.ts`만 보여주기 위한 것. `outDir`은 `.work/<role>/` 아래를 코어가 넘긴다.
   * 소비: M4 wave 1 test-writer 역할.
   */
  generateStubs(ctx: AdapterContext, outDir: string): Promise<StubResult>;

  /**
   * 테스트 러너 실행 → JUnit XML 경로 + exit code + 가로챈 출력 (기획안 §4.2 "테스트 러너 연결" · §7.3).
   * 파싱은 코어가 한다. 어댑터는 러너를 돌리고 보고서 위치만 알려준다.
   * 소비: M5 wave 0 JUnit XML 파서 → `plumb check` · M4 Stop hook(전부 실패 / 전부 통과 판정의 원자료).
   */
  runTests(ctx: AdapterContext, opts: TestRunOptions): Promise<TestRunResult>;

  /**
   * 스키마 읽기 → OpenAPI · Prisma · AsyncAPI 파싱 결과 (기획안 §4.2 "스키마 읽기" · §5.1 계약).
   * 파일 위치는 `config.contracts`. 파일이 없거나 깨지면 그 항목만 `missing` · `error`.
   * 소비: M8 wave 0 데이터 모델·계약 View · M4 test-writer 디렉토리에 두는 계약 파일.
   */
  readSchemas(ctx: AdapterContext): Promise<SchemaSet>;

  /**
   * 트레이스 수집 → OTel 스팬 또는 `{ unavailable: 'no-trace' }` (기획안 §4.2 "트레이스 수집 설정", view-flow A안).
   * 소비: M8 wave 1 도메인 흐름도 spike (OTel 수집 시도 → 불가 시 정적 호출 그래프).
   */
  collectTraces(ctx: AdapterContext, opts: TraceCollectOptions): Promise<TraceResult>;

  /**
   * (선택) 정적 호출 그래프 → `FlowNode` 트리 (view-flow 4.2). Next.js 어댑터는 TS 컴파일러 API로 만든다 (#59).
   * 없으면 흐름도 View는 "정적 호출 그래프를 제공하지 않는다"를 `graphError`에 적는다. 다섯 역할 밖이라 선택 메서드 (#63).
   */
  buildCallGraph?(ctx: AdapterContext): Promise<StaticCallGraph>;
}

/** 필수 어댑터 메서드 이름 (다섯 역할). `NotImplementedError`(errors.ts)의 `method`. 선택 메서드 `buildCallGraph`는 들어가지 않는다 */
export type AdapterMethod = 'extractDependencies' | 'generateStubs' | 'runTests' | 'readSchemas' | 'collectTraces';

/** 다섯 메서드 이름의 런타임 목록. 인터페이스 준수 테스트가 쓴다 */
export const ADAPTER_METHODS: readonly AdapterMethod[] = [
  'extractDependencies',
  'generateStubs',
  'runTests',
  'readSchemas',
  'collectTraces',
];

/** 어댑터 인스턴스를 만드는 함수. 등록 시 넘기고 조회 시 호출한다 (의존성 로드를 조회 시점까지 미룬다) */
export type AdapterFactory = () => Adapter;
