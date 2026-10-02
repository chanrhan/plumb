// 원본: docs/types/config.ts (#5). 정본은 이 파일. #63에서 보완.
/**
 * `plumb.config.json` — 대상 레포 안의 설정 파일. 출처 접두어는 `파서:` (README 2.1, view-architecture 머리).
 *
 * 출발점: 이전 작업공간의 설정 예시(`git show 0274a13:plumb.config.json`). 와이어프레임이 요구한 필드를 더했다:
 * `blocks` (view-architecture 3절 · 6절 2번, work-approve 6절 3번), `ide` (README 2.2), `flow.mode` (view-flow 3절),
 * `services` (view-dependencies 6절 3번), `contracts` (view-data-contract 3절), `ignore` (view-architecture 3절 "미분류"),
 * `reviewQueue` (기획안 §9.2), `checks.stability` (view-verification 6절 5번), `run.maxBudgetUsd` (기획안 §15.4 실행당 예산 상한).
 */

import type { Risk } from './rules.js';
import type { Role } from './run.js';
import type { FlowMode, InfraKind } from './views.js';

/** 역할별 상한 (기획안 §15.4). 모델 이름은 설정값일 뿐 타입에 박지 않는다 */
export interface RoleConfig {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

/**
 * 블록 선언 (기획안 §12). 키 = 블록 ID. 기본 경계는 `src/domains/<이름>/`과 `app/`이며 여기서 재정의한다.
 * `dependsOn`은 선언된 방향 — 첫 슬라이스는 설정에 둔다. 저장소 규칙(승인 필요)으로 옮기는 것은 M10 (view-architecture 6절 2번).
 */
export interface BlockConfig {
  include: string[];
  /** 공개 진입점. 기본 `index.ts` */
  public?: string[];
  dependsOn?: string[];
  /** 블록 전체를 고위험으로 선언 → 그 블록 규칙은 전부 ⚡ (work-approve 6절 3번: 상단 바 `⚠ n`과 공유) */
  risk?: Risk;
}

/** 외부 서비스 ↔ 클라이언트 패키지 매핑 재정의. 어댑터 내장 표에 덧붙인다 (view-dependencies 6절 3번) */
export interface ServiceConfig {
  kind: InfraKind;
  clientPackages: string[];
  /** 환경변수 **이름** (값이 아니다) */
  envVars?: string[];
}

/** 계약 파일 위치 (기획안 §5.1). 기본값 세 파일 */
export interface ContractsConfig {
  openapi?: string;
  prisma?: string;
  asyncapi?: string;
  /** 모델 → 블록 소유 매핑 (view-data-contract 6절 2번 (b)). 첫 슬라이스는 비움 */
  models?: Record<string, string>;
}

/** 흐름도 (view-flow 3절 "트레이스 없음 (B안)" 안내, 6절 4번) */
export interface FlowConfig {
  /** `auto`: 트레이스가 있으면 trace, 없으면 static으로 자동 전환 (view-flow 5절) */
  mode: FlowMode | 'auto';
  /** 진입점 글롭. 기본 `src/app/api/**\/route.ts` */
  entryGlob?: string[];
  /** 공개 진입점 아래 내부 호출 깊이. 기본 1 (view-flow 4.0) */
  internalDepth?: number;
}

export interface PlumbConfig {
  /** 대상 경로. 이름이 상단 바의 프로젝트 이름 */
  service: string;
  /** 보호 저장소 경로. 기본 `~/.plumb/stores/<project>/` (README 3.1) */
  store?: string;
  /** 역할별 임시 작업 디렉토리. 기본 `./.work` (기획안 §8.6) */
  work?: string;
  adapter: 'nextjs';
  node?: string;
  roles: Record<Role, RoleConfig>;
  /** 종료 차단 연속 상한 (기획안 §8.3) */
  stopBlockLimit: number;
  /** 실행 하나의 예산 상한. 없으면 `[시작]` 비활성 (work-run 5절) */
  run?: { maxBudgetUsd: number; concurrent?: 1 };
  diffSearch?: { numRuns: number; seed?: number };
  /** IDE 명령 템플릿. `{file}` `{line}` 치환 (README 2.2) */
  ide?: string;
  blocks?: Record<string, BlockConfig>;
  /** 미분류 계산에서 제외할 글롭 (node_modules · 테스트 · 설정 파일) */
  ignore?: string[];
  services?: Record<string, ServiceConfig>;
  contracts?: ContractsConfig;
  flow?: FlowConfig;
  /** 불안정 판정 반복 횟수. 기본 3 (기획안 §7.5) */
  checks?: { stability?: number; junitReport?: string };
  /** 검토 대기열 상한. 기본 20건 · 14일 (기획안 §9.2) */
  reviewQueue?: { maxUnconfirmed?: number; maxDays?: number };
}
