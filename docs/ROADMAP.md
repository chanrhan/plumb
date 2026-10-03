# 로드맵

기획안 v5 §15 "기능 하나로 모든 층을 얇게 관통"을 따른다. 요구사항 하나(`pay.refund-window`: 환불은 결제 후 7일 이내만)로 첫 슬라이스를 끝까지 돌리는 것이 M0~M9이고, M10부터 넓힌다.

## 순서를 정한 기준

1. 기획안이 "첫 슬라이스에서 확인한다"고 미뤄둔 **검증 안 된 기술 가정**을 앞에 둔다: 격리가 설정만으로 막히는가(§8.6), Stop hook이 종료를 실제로 막는가(§8.3), Vitest 실행 중 트레이스가 잡히는가(§4.4)
2. 각 마일스톤은 **기계가 확인할 수 있는 종료 증거**로 닫는다
3. 화면은 M0에서 **구상**(와이어프레임 + 데이터 타입)만 하고, 구현은 각 기능과 함께 한다(M3 승인, M6 실행, M8 View). 목 데이터로 화면을 먼저 채우지 않는다
4. 에이전트가 실제로 도는 단계(`[L]`)는 사용자 머신에서, 나머지는 어디서든

## 진행 상태

| 마일스톤 | 상태 | 비고 |
|---|---|---|
| M0 | 완료 | 와이어프레임 9장 + 타입 + 종이 시뮬레이션. 저장 형식 기본값 7건은 #17에서 사람 확인 대기 |
| M1 | 완료 | #10 SDK 스모크 로컬 통과(`tools=1 (mcp 0)` · exit 0). 발견: 계정 MCP 커넥터 92개가 `settingSources: []`로 안 막힘 → `strictMcpConfig`로 차단. `docs/harness-notes.md`가 M4 입력 |
| M2 | 완료 | testbed: payment 도메인(naive refund), OpenAPI + Route Handler(422는 계약에만), Vitest(JUnit) + depcruise 블록 규칙 5개 |
| M3 | #36만 남음 | 저장소 코어 · CLI(`rule`·`approve`) · UI 토큰 통로 · UI `/rules` · 결정 기록 완료. 쿠키 없는 승인 401 확인. #36 rule-drafter는 `env/local`(#10 뒤) |
| M4 | 완료 | `pnpm isolation-test` 로컬(macOS · 구독) **11/11 ✅** · $0.075. 발견: macOS는 SDK 샌드박스 켜짐(캐시 +7k) · Linux는 bwrap 없으면 꺼짐 → hook이 정본(노트 결정 9). 누수 기준 20k |
| M5 | 완료 | `plumb check`: Vitest JUnit + depcruise → 규칙별 상태 + 검사 범위 밖 → `checks/`·`rule-status/`. CLI 표와 UI `/rules` 상태 열 연결 |
| M6 | 이슈 등록 #86~#89 | 순서 #86(파이프라인) → #87(`plumb run --detach`) · #88(이의 제기 재검토) → #89(UI, `parallel/blocked` → #87 뒤 위임 가능). 입력: 노트 6절 결정 1~10 |
| M7 | 이슈 등록 #90 · #91 | #90 injector(`env/local`) → #91 차이 탐색 러너(`parallel/ok`, 에이전트 아님) |
| M8 | #63 · #67만 남음 | View 6개 생성기 + `plumb views` + UI `/views`(Markdown·Mermaid, `plumb://open` 점프) 완료. testbed에서 `plumb check --views` → 12 파일. 흐름도는 spike 결과 A안(트레이스 + 정적) — 결정 #67 사람 확인 대기. #63 타입 보완 진행 중 |

## 마일스톤

wave = 동시에 돌릴 수 있는 이슈 묶음. wave 안의 이슈는 범위가 겹치지 않는다. `[L]` = `env/local`.

### M0 화면 구상

**종료 증거**: 와이어프레임 9장(작업 화면 3 + View 6)에 출처 없는 항목 0개 · View 타입 파일이 `tsc --noEmit` 통과 · 첫 슬라이스 종이 시뮬레이션 문서 존재

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #1 | **결정** 화면 목록 · 공통 레이아웃 · 프로세스 모델(화면 ↔ 코어 데몬, localhost API + 일회용 토큰) |
| 1 | #2 | 작업 화면 3개 와이어프레임 (View 보기 · 규칙 승인 · 실행/진행) |
| 1 | #3 | View 4개 와이어프레임 — 정적 출처 (아키텍처 · 데이터 모델/계약 · 외부 의존성 · 검증 상태) |
| 1 | #4 | View 2개 와이어프레임 — 기술 변경 로그 · 도메인 흐름도(OTel 가능/불가 두 안) |
| 2 | #5 | View·규칙·상태 TypeScript 타입 초안 + 첫 슬라이스 종이 시뮬레이션 |

### M1 모노레포 골격 + SDK 스모크

**종료 증거**: `pnpm install && pnpm build && pnpm plumb --help` 성공 · CI 녹색 · `[L]` 스모크 스크립트가 hook 가로채기 로그 1줄 출력

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #6 | pnpm workspace + TS 공통 설정 + `packages/core` 뼈대 + M0 타입 이식 + CI(`pnpm check`) |
| 1 | #7 | `plumb` CLI 진입점 (commander, `--target`, `plumb.config.json` zod 스키마) |
| 1 | #8 | `packages/adapter-nextjs` 뼈대 + 어댑터 인터페이스 |
| 1 | #9 | `apps/ui` Next.js 빈 골격 (화면 3개 라우트만) |
| 2 | #10 | `[L]` Agent SDK 스모크: 호출 1회 + PreToolUse hook 1회, 구독 로그인 확인 |

### M2 테스트 프로젝트

**종료 증거**: `examples/testbed`에서 `pnpm test`와 `depcruise` 통과 · naive `refund`가 8일 지난 결제도 환불한다(규칙 위반 상태가 출발점)

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #18 | Next.js + Prisma + Postgres 골격, `src/domains/payment/` 공개 진입점, §4.4 블록 구조. Docker 없는 환경용 `scripts/db-local.sh`(pg_ctl) |
| 1 | #19 | `createPayment` / naive `refund` + Prisma 스키마 + 시드 |
| 1 | #20 | OpenAPI 파일 + Route Handler (`POST /payments`, `POST /refunds`). 422는 계약에만 두고 구현하지 않는다 |
| 1 | #21 | Vitest(JUnit 리포터 항상 켬) + fast-check + dependency-cruiser 블록 규칙, 빈 `test/acceptance/` |

### M3 보호 저장소 + 규칙 모델 + 승인 화면

**종료 증거**: 승인 행위 없이 `rules.yaml` 상태를 바꾸면 `plumb check`가 경보 · 토큰 없는 `POST /api/approve` → 401 · `[L]` `plumb rule draft`가 EARS 한 줄을 만든다

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #31 | 저장소 레이아웃(`rules.yaml` · `proposals/` · `approvals/` · `rule-status/` · `checks/` · `decisions/` · `runs/` · `views/` · `contracts/` · `review-queue/`) + 규칙·제안·승인 코어 API. `rules.yaml`은 승인으로만, 마지막 승인 해시로 변조 감지 |
| 1 | #32 | `plumb rule list|show|propose|reject`, `plumb approve` + testbed `plumb.config.json` + 첫 제안 `pay.refund-window` |
| 1 | #33 | UI 승인 통로: `plumb ui` 토큰 → 쿠키, `/api/**` 401, `GET /api/status`, 상단 바 |
| 1 | #34 | UI `/rules` 화면 + 규칙 API (list · show · approve · reject) |
| 1 | #35 | 결정 기록 D-xxxx 형식(Markdown + front matter) 파서·작성기 + 예시 D-0001 |
| 2 | #36 | `[L]` `plumb rule draft` — rule-drafter 역할 (자연어 → EARS Proposal, maxTurns 1) |

### M4 하네스 + 격리 + 종료 조건 `[L]`

**종료 증거**: 격리 시험 스크립트 통과(test-writer의 `src/**` 읽기 거부, implementer의 `test/acceptance/**` 쓰기 거부) · 일부러 틀린 구현으로 implementer가 Stop hook에 막힌다

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #75 | 역할 공통부: `query()` 옵션 빌더(`strictMcpConfig` · `settingSources: []` · 하위 에이전트 금지 · 예산·반복 상한, `model: "default"` 거부) + 실행 래퍼(예외 경로에서도 result 회수) + 격리 상시 검사(MCP > 0 또는 첫 턴 캐시 > 10k → 실패) |
| 1 | #76 | test-writer: `tsc --declaration` 스텁, CLAUDE.md 미로드, `src/**` 읽기 차단 hook, Bash 없음 |
| 1 | #77 | implementer: `test/acceptance/**` · `.git` 쓰기 차단, 인터넷 차단(`sandbox` 실측) |
| 2 | #78 | Stop hook 두 종류(전부 실패 / 전부 통과 또는 이의 제기) + `stopBlockLimit` → 이의 제기 파일 |
| 2 | #79 | 격리 시험 스크립트 `scripts/isolation-test.ts` — 8항목 ✅ · testbed `git status` 깨끗 |

전부 로컬. SDK 실행 자체가 시험 대상이므로 위임하지 않고 순차로 한다(#75 → #76·#77 → #78 → #79). 입력: `docs/harness-notes.md` 3절 대응표 · 6절 결정.

### M5 검사 실행 연결

**종료 증거**: `plumb check`가 JUnit XML을 읽어 규칙별 🟢🟡🔴⬜ + 커밋·시각을 저장소에 기록 · 출력이 M0 검증 상태 타입을 만족

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #43 | JUnit XML 파서 → `CheckResult` 재료 + 테스트 파일 경로로 규칙 매핑 |
| 0 | #44 | adapter-nextjs `runTests()`: Vitest JUnit 실행(가로챈 출력) + depcruise 위반 → 1등급 정적 결과 |
| 0 | #45 | adapter-nextjs `extractDependencies()`: depcruise JSON + `blocks` 설정 → 블록 그래프(L0/L1 · 간선 · 미분류) |
| 0 | #46 | 규칙 상태(`RuleStatusRecord`) · 검사 범위 밖(`OutOfScope`) · 블록 공통 행 계산 + 저장소 `checks/`·`rule-status/` |
| 1 | #47 | `plumb check`로 묶기 + 표 출력 + `rule list`·UI 상태 열 연결 |

### M6 오케스트레이터 + 실행 화면 `[L]`

**종료 증거**: 규칙 1개로 파이프라인 ②③④가 사람 개입 없이 끝까지 돈다 · 앱을 닫아도 프로세스가 산다

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #86 | 오케스트레이터 코어: ②(test-writer) → 테스트 → ③(implementer) → 테스트 → ④(`plumb check`), Stop hook 증거 = 어댑터 `runTests` JUnit, `runs/<id>.json` 전이·heartbeat, 실패·예산 초과 → 검토 대기열 |
| 1 | #87 | `plumb run --rules … --detach`(detached 자식 + unref) · `plumb runs list/show/abort`(pid SIGTERM) |
| 1 | #88 | 이의 제기 파일 → test-writer 재검토(advisory, 읽기 전용) → `disputes[].advisory` + 검토 대기열 `kind: dispute` |
| 2 | #89 | UI `/runs`: 목록 · 상세(단계 ①~④ · 역할 사용량 · 이의 제기 · 출력 꼬리) · `POST /api/runs` spawn · abort. `area/ui`, #87 뒤 위임 가능 |

#86 · #87 · #88는 `env/local`(SDK 실행이 증거). #89는 `runs/*.json` 픽스처로 CI 가능 → 위임 후보.

### M7 위반 주입 + 차이 탐색 `[L]`

**종료 증거**: `pay.refund-window` 주입이 검사 실패로 잡히고 유효성 기록이 남는다

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #90 | injector 역할(`test/**` 읽기 금지 · `rule.scope` 안 `src/**`만 쓰기) + 임시 worktree 패치 1건 → 인수 테스트 실패 = 유효 ✔ → `injections/<ruleId>/<id>.json` · 격리 시험 항목 추가 |
| 1 | #91 | 차이 탐색 러너(에이전트 아님): fast-check 입력 N개 → 원본·위반 출력 비교 → `DiffSearch` 판정, 미판정은 검토 대기열 |

단계 ⑤를 파이프라인에 잇는 것(잡히지 않은 주입 → ②로)은 M9 첫 슬라이스 점검에서.

### M8 View 6개 + View 화면

**종료 증거**: `plumb views`가 6개 파일을 파서 출력에서만 생성 · UI가 목 데이터 없이 렌더링 — **충족** (testbed `plumb check --views` → `views/` 12 파일, 각 View에 파서·실행·저장소 출처 표시줄)

| wave | 이슈 | 내용 |
|---|---|---|
| 0 | #53 | View 공통부: `ViewGenerator` · `ViewHeader` · Markdown 헬퍼(표 · Mermaid · `plumb://open` 앵커 · 출처 표시줄) · `store.views`(JSON 정본 + md) |
| 1 | #54 | 아키텍처 (블록 그래프 → Mermaid L0/L1 + 블록·간선·미분류·필수 검사 표) |
| 1 | #55 | 데이터 모델·계약 (어댑터 `readSchemas`: Prisma DMMF · OpenAPI → 모델 표 · erDiagram · API 표 · 계약 해시 `store.contracts`) |
| 1 | #56 | 외부 의존성 (pnpm lockfile 모노레포 `importers` · externals · L0 서비스 · 30일 의존 이벤트 + 결정 기록) |
| 1 | #57 | 검증 상태 (CheckRun + rule-status → §6.3 화면, 검사 범위 밖 절 생략 불가) |
| 1 | #59 | 도메인 흐름도 spike → **A안**(Vitest 중 OTel 스팬 수집 + 정적 호출 그래프, 실선·점선. 트레이스 0개면 static 자동 전환) — 결정 #67 |
| 2 | #58 | 기술 변경 로그 (설계 변경 이벤트 6종 감지: base 커밋 worktree 전후 비교 · 결정 기록 연결 · "사유 없음") |
| 3 | #60 | `plumb views` · `plumb check --views` · `plumb open`(이유 필수, `code-opens.jsonl`) · UI `/views` + `/api/views/:name`·`regenerate`·`open` |
| 4 | #63 | 타입 보완 — PR들의 "타입 보완 후보" 일괄 반영, 임시 어댑터 타입 제거 |

### M9 첫 슬라이스 통과 점검 `[L]`

**종료 증거**: 기획안 §15.1 다섯 항목 ✔ · M0 와이어프레임과 실제 화면의 대조표

| 내용 |
|---|
| 통과 기준 스크립트 + 수동 항목 체크리스트 |
| 와이어프레임 대조 → 빠진 항목을 M10 이슈로 |

### M10 넓히기

기획안 §15.2. 이슈는 M9 결과를 보고 등록한다. 슬라이스 반복 → `plumb init` 연동 일반화 → 해시 체인 · 승인 모델 · 병합 게이트 → 작업 화면(추적성 매트릭스 등) → 데스크톱 포장.

## 이슈 등록 시점

M0~M8 이슈는 모두 등록했다(M6 · M7은 M4 격리 시험 #79 통과 뒤 등록). M9 · M10은 M7이 끝나면. M2 이후는 **각 마일스톤을 시작할 때** 등록한다. 그 시점의 타입과 구조를 반영해야 범위와 범위 밖이 정확해지기 때문이다.
