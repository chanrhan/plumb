# M0 타입 초안 — 결정 메모

> **정본은 `packages/core/src/types`다.** 이 폴더의 `*.ts`는 M0 산출물(#5) 그대로 두며, M3~M8 구현에서 나온 보완은 #63에서 `packages/core/src/types/**`에만 반영했다 (아래 5절).

이슈 #5의 산출물. `docs/screens/*.md`(#1~#4)의 **3절 항목 표**를 타입으로 옮기고, 각 문서 **6절 열린 질문** 중 타입에 영향을 주는 것을 여기서 하나씩 정했다. M1 #6에서 `packages/core/src/types/`로 이식되며, 그 뒤로는 공유 타입 변경 규칙(CONTRIBUTING 2.1)을 따른다.

| 파일 | 내용 |
|---|---|
| `views.ts` | View 6개 + 공통 `ViewHeader` `SourceRef` `Anchor` `OutOfScope` + URL 쿼리 `ViewQuery` |
| `rules.ts` | `Rule` `RuleStatus`/`RuleStatusDetail` `Grade` `Approval` `Proposal` `DecisionRecord` `CheckRef`/`CheckResult`/`CheckRun` `Validity` `CodeOpenRecord` `ReviewQueueItem` `ContractApproval` |
| `run.ts` | `RunState` `Stage` `Role` `StageRecord` `Dispute` `RunOutcome` `CapturedOutput` |
| `api.ts` | README 3.3 표의 요청·응답 + `ApiError`(401 · 400 · 404 · 409 · 500) + `ApiSurface` |
| `config.ts` | `plumb.config.json` |

확인: `npx -y -p typescript@5 tsc --noEmit -p docs/types/tsconfig.json` (이슈의 명령 `npx -y typescript@5 tsc …`는 npm ≥ 7에서 `typescript` 패키지의 bin이 둘(`tsc` · `tsserver`)이라 "could not determine executable to run"으로 실패한다. `-p`를 붙여야 한다 — PR #5 본문 참조).

## 1. 기획안 원칙을 타입으로 묶은 곳

| 원칙 | 타입 |
|---|---|
| 🔴는 검사 실패에서만 나온다 (§7.3) | `RuleStatusDetail`의 `fail` 변형은 `failures: [CheckFailure, ...CheckFailure[]]` — 비어 있는 배열로는 만들 수 없다. 정적 검사 `StaticCheckResult`도 같다 (`fail`은 `violations` 비어 있지 않음) |
| LLM 판정은 상태를 바꾸지 못한다 (§7.3, §8.4) | 이의 제기 재검토 결과는 `Dispute.advisory` 아래에만 있다. `RuleStatusDetail`에는 판정 필드가 없다. `unchecked` 변형의 주석에 "LLM 판정의 결과는 언제나 여기" |
| 자기 보고는 입력이 아니다 (§8.3) | `RunState`에 에이전트 메시지 필드가 없다. 가로챈 명령 출력만 `CapturedOutput { command, exitCode, tail, logPath }` |
| 승인은 검사가 아니다 (§9.1) | `ApprovalState`(잠정·승인·기각)와 `RuleStatus`(🟢🟡🟠🔴⬜)는 서로 다른 축. `ApproveResponse`는 상태를 돌려주지 않는다 |
| 모든 결과에 커밋·시각 (§7.3) | `CheckRun.commit/finishedAt`, `RuleStatusRecord.commit/checkedAt`, `LastCheck`, `ViewHeader.commit/generatedAt`, `RuleRow.lastResult` |
| 검사 범위 밖은 생략 불가 (§12, §14) | `VerificationView.outOfScope: OutOfScope`는 필수 필드. `untestedFlows`는 측정 불가를 `{ unavailable }`로 적지 0으로 쓰지 않는다 |
| 환경변수 값은 읽지 않는다 | `Evidence.excerpt`, `BlockNode.envVars`, `ServiceConfig.envVars` 주석. 이름만 |

## 2. 와이어프레임 사이의 모순과 통일

| 모순 | 통일 |
|---|---|
| 규칙 상태 타입 이름 — view-verification 초안 `Status`, work-approve "상태", 기획안 §7.3 영문 이름 | `RuleStatus` 하나 (`'pass-verified' \| 'pass-unverified' \| 'recheck' \| 'fail' \| 'unchecked'`). 아이콘은 화면 몫 |
| 세션 ID — view-changelog `s-118`, work-run `r-0003` | `RunId` = `` `r-${string}` `` 하나. 변경 로그의 "세션"은 실행 ID다. 사람이 직접 한 커밋은 `'manual'` |
| 검사 매핑 — 기획안 §5.2 `checks: [경로]`, view-verification `checks[]: [{ kind, ref }]` | 정규화 타입 `Rule.checks: CheckRef[]`. YAML 원문은 `RuleYaml.checks: (string \| CheckRef)[]` — 문자열은 `{ kind: 'acceptance', ref }`로 읽는다 |
| 공개 진입점 파일 — view-architecture `index.ts`, view-flow `public.ts` | 기본 `index.ts`, 재정의 `BlockConfig.public`. 타입은 어느 쪽도 박지 않는다 |
| "테스트가 안 지나간 흐름" — view-verification 5절 "OTel 없으면 측정 불가", view-flow 3절 "B안은 테스트 참조 없는 진입점 수" | #4(나중 문서)를 따른다. `OutOfScope.untestedFlows`는 `{ mode, count, total, items }` 또는 `{ unavailable: 'no-trace' \| 'no-graph' }`. 트레이스도 정적 그래프도 없을 때만 측정 불가 |
| 결정 기록 "연결" — view-changelog `links: { rules[], events[], commits[] }`, view-dependencies `refs.packages[]/services[]` | `DecisionRecord.links { rules, commits, events, packages?, services? }` 하나 |
| 아키텍처 초안 `evidence: [{ node, file, line, excerpt }]` (View 수준 배열) vs L0 선택 패널(노드별) | `BlockNode.evidence: Evidence[]` — 노드에 붙인다. `Evidence`는 의존성 서비스 근거·변경 로그 감지 근거와 공유 |
| 계약 초안 `codeConformance.status: 'pass'\|'fail'\|'none'` 평면 객체 | discriminated union으로. `fail`은 `failed ≥ 1`과 `failures[]`가 있을 때만 (원칙 1) |
| README 2 표 "프로젝트 이름 — 저장소: plumb.config.json" vs 2.1 정의 | `파서:`로 정정 (README 고침, #3 코멘트) |

## 3. 열린 질문 → 결정

표기: **되돌리기 비용 높음**은 저장 형식·외부 계약·승인 통로에 닿는 것. PR 본문에도 모아 사람이 결정한다. `→ M6` 등은 그 마일스톤으로 미룬 것(타입에는 자리만).

### work-views.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 항목별 블록 태그·`file:line` 표현 | **(b) `views/<name>.json`(이 타입) + 렌더러가 `views/<name>.md`를 만든다.** 항목 메타는 `Anchor { block?, file?, line? }` | 타입이 파서의 출력 목표가 되려면 구조가 정본이어야 한다. HTML 주석(a)은 파싱이 한 겹 더 든다 | **높음** (저장 형식) |
| 2 | 머리말 타입 | `ViewHeader { view, generatedAt, commit?, sources: SourceRef[] }`. `SourceRef.kind`는 2.1 접두어와 1:1 (`parser` `execution` `store` `git` `user-input`) | 접두어를 그대로 쓰면 "생성 출처 표시줄"이 기계적으로 나온다 | 낮음 |
| 3 | IDE 열기 실패 기록 | 남긴다. `CodeOpenRecord.result: { status: 'opened' } \| { status: 'failed', error }`. API는 200 | "보려 했다"가 명제 검증의 원자료 | 낮음 |
| 4 | L0 선택 = 필터 해제? | → M8. `ViewQuery.block`에 `L0` 값을 넣지 않는다 | | 낮음 |
| 5 | README 3.3 보완 | 404 · 머리말 반환 → README 고침. `ViewResponse { header, markdown, data, stale?, codeOpens }` | | 낮음 |

### work-approve.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 제안 기록 저장 형식 | **`rules.yaml`에는 현재 승인 버전만. 제안은 `proposals/<ruleId>/<p-id>.json`(`Proposal`), 승인 이력은 `approvals/<ruleId>.jsonl`(`Approval`)** | 승인 행위로만 바뀌는 파일과 에이전트가 제안을 쓰는 파일을 분리해야 §10 "승인 기록은 승인 행위로만"이 파일 권한으로 지켜진다 | **높음** (저장소 레이아웃, M3) |
| 2 | 승인 단위 | M3는 규칙 하나 (`POST /api/rules/:id/approve`). 결정 단위 `POST /api/decisions/:id/approve` → M10 | 첫 슬라이스 규칙 1개 | 낮음 (경로 추가) |
| 3 | 블록 고위험 선언 위치 | `plumb.config.json` `blocks.<id>.risk` (`BlockConfig.risk`). `RuleListItem.highRisk`는 규칙 `risk` OR 블록 선언 | 블록 경계와 같은 파일에 두면 `파서:` 하나로 끝난다 | 낮음 |
| 4 | 결정 기록 없는 규칙의 승인 | 허용. `Rule.decision?`, `RuleDetailResponse.decision?: DecisionRecord \| { missing }` | 막으면 M3가 못 끝난다 | 낮음 |
| 5 | 목록 기본 필터 | 전체. `RuleListFilter`는 전부 optional | 타입에 영향 없음 | 낮음 |
| 6 | README 3.3 보완 | 409 `proposal-changed`(요청에 `proposalHash` 동봉), 기각 사유 필수(400 `reason-required`) → README 고침 | | 낮음 |

### work-run.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 동시 실행 수 | 1. `POST /api/runs` 409 `run-in-progress`. `PlumbConfig.run.concurrent?: 1` | worktree 충돌 · 예산 합산 | 낮음 |
| 2 | 중단 API | `POST /api/runs/:id/abort` → UI 서버가 `pid`로 SIGTERM (README 3.4). 202. 실제 종료는 파일 폴링 → M6 구현 | README 3.4 "감수하는 것"과 같다. `.abort` 파일 폴링은 `plumb run`이 블로킹 SDK 호출 중이면 늦다 | 낮음 |
| 3 | pid 생존 | 화면에 두지 않는다. `RunState.updatedAt`이 heartbeat → M6 | 2.1 접두어에 안 들어간다 | 낮음 |
| 4 | `RunState` 타입 · ⑤→② 되돌아감 | `stages: StageRecord[]`에 같은 단계가 반복 + `attempt` 카운터 둘 다. `outcome: RunOutcome`(종료 상태별 사유) | 화면은 마지막 항목 + "n회차" | 낮음 |
| 5 | 출력 보관 | `runs/<id>/output.log`에 명령별 구분자, `CapturedOutput.tail` 20줄을 `RunState`에 포함. 전체 보기 → M10 | | 낮음 |
| 6 | 비용 원자료 | SDK 결과 메시지의 비용 그대로. 없으면 `costUsd: null` ("비용 정보 없음") | "추정" 표기는 어느 쪽이든 | 낮음 |
| 7 | README 3.3 보완 | (a) abort (b) 400 조건 (c) 출력 꼬리는 `GET /api/runs/:id`에 포함, 별도 경로 없음 → README 고침 | | 낮음 |

### view-architecture.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 블록 그래프 JSON 형태 · L0/L1 분리 | **한 파일.** `ArchitectureView { blocks: BlockNode[](level), edges: BlockEdge[](L1), infraEdges: InfraEdge[](L0), undetectedInfra, unclassified, requiredChecks, impact, summary }` | 블록 트리(README 2)가 L0·L1을 한 번에 읽는다 | 낮음 |
| 2 | 선언된 방향의 위치 | **첫 슬라이스는 `plumb.config.json` `blocks.<id>.dependsOn`(파서). 저장소 규칙(승인 필요)으로 옮기는 것은 M10** | M3 저장소 레이아웃을 넓히지 않는다. 다만 선언 변경이 설계 변경이라면 승인 통로를 거쳐야 한다는 §12의 요구는 미해결 | **높음** (출처 접두어와 승인 통로가 바뀐다) |
| 3 | 시그니처 정의 | `tsc --declaration` 출력 텍스트 diff. `SignatureChange { before?, after? }` 문자열 → M8 spike에서 구조 비교로 바꿀 수 있다 | | 낮음 |
| 4 | 환경변수 이름 참조 스캔 | 어댑터 `extractDependencies()`에 넣는다 → M8. 없으면 `InfraEdge.blocks: []` | | 낮음 |
| 5 | 영향 범위 기간 | HEAD 커밋 하나. `impact: { commit, blocks, unclassified }` | 추세는 M10 | 낮음 |
| 6 | `app/` 지위 | `BlockKind: 'entry'`. `test/`는 `'test'` (view-dependencies 6절 4번) | L1에 그려야 필수 검사 (1)을 적용할 수 있다 | 낮음 |

### view-data-contract.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 계약 해시 기록 | **`ContractApproval { path, hash, approvedAt, decision?, commit }` → 저장소 `contracts/<파일>.json`. M3 저장소 레이아웃에 포함할지는 M3 이슈 등록 때 결정** | 기획안 §5.1이 요구. 타입은 둔다 | **높음** (저장소 레이아웃) |
| 2 | 모델의 블록 소속 | 그리지 않는다. `Model.block?`은 비움. `ContractsConfig.models` 자리만 → M10 | 파서로 알 수 없다 | 낮음 |
| 3 | 엔드포인트 소속 두 출처 | 둘 다 보이고 다르면 🟠. `Operation.block { fromTags?, fromHandler?, mismatch }` | 어느 쪽도 "믿지" 않는다 | 낮음 |
| 4 | 계약 테스트 식별 | `checks[].kind === 'contract'` | 검증 View와 같은 결정 | 낮음 |
| 5 | 엔드포인트 ↔ 모델 연결 | 그리지 않는다. 이름 일치 비교(`schemaModelDiff`)만 → OTel은 M8 spike | 추론 금지 | 낮음 |
| 6 | View 타입 초안 | `ContractView`로 채택, `codeConformance` discriminated, `diff`에 `{ unavailable }` | | 낮음 |

### view-dependencies.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 규칙 ↔ 의존성 연결 | `Rule.constraint?: { targets: ConstraintTarget[] }` (`package` · `service`) | 문자열 검색은 추정 | 낮음 (optional 추가) |
| 2 | 결정 기록 ↔ 패키지 연결 | `DecisionRecord.links.packages?/services?` | 본문 일치만으로 "사유 있음" 판정은 오탐 | 낮음 |
| 3 | 매핑표 위치 | 어댑터 내장 + `PlumbConfig.services` 재정의 (`ServiceConfig`) | | 낮음 |
| 4 | `test/`를 블록으로 | `BlockKind: 'test'`. `PackageEntry.importedBy`에 `'test'` | | 낮음 |
| 5 | View 타입 초안 | `DependenciesView`로 채택. `lockfile`에 미지원·없음 변형, `importAnalysis: 'missing'`이면 `unused: null` | 5절 "▲ ?" | 낮음 |

### view-verification.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | 규칙 ↔ 검사 매핑의 키 | **`CheckRef.ref` = 테스트 파일 경로. 파일 하나 = 규칙 하나.** `describe('[rule.id]')` 매핑 → M10 | M5 wave 0 전에 가장 단순한 것 | **높음** (`ref`의 의미가 바뀌면 JUnit 파서와 규칙 YAML이 같이 바뀐다) |
| 2 | 상태 기록의 위치 | **둘 다. `CheckRun`(실행: `checks/<runId>.json`)이 입력이자 진실, `RuleStatusRecord`(저장소: `rule-status/<ruleId>.json`)는 `plumb check`가 계산해 쓰는 출력.** `since`(체류)는 후자에만 | 체류 일수는 상태 전이를 기억해야 계산된다 | **높음** (저장소 레이아웃, 두 파일의 일관성 책임) |
| 3 | "요구사항에 없는 코드"의 단위 | `Rule.scope?` 선택. 없으면 블록 전체 | 필수로 하면 M3 규칙 작성 비용 | 낮음 |
| 4 | 흐름의 정의 | #4를 따른다: `mode: 'trace'`면 점선 노드, `'static'`이면 테스트 없는 진입점. `UncoveredFlow.mode`에 기록 | | 낮음 |
| 5 | 3회 실행 비용 | `PlumbConfig.checks.stability` (기본 3) → 매번/변동 시 → M5 | | 낮음 |
| 6 | View 타입 초안 | `VerificationView`/`RuleRow`로 채택. `status` 문자열 대신 `detail: RuleStatusDetail` | 원칙 1 | 낮음 |
| — | (추가) ⬜ 사유에 `check-missing` | `checks[]`는 있는데 레포에 파일이 없음. `no-checks`와 구분 | 종이 시뮬레이션 1단계에서 필요해졌다 (승인 직후 상태) | 낮음 |

### view-flow.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | `FlowNode` · 두 안을 한 타입으로 | `FlowView.mode: 'trace' \| 'static'` 하나의 타입. A안 필드 `evidence`, B안 필드 `testRef` 모두 optional. 자동 전환은 `fallback` | 5절 "자동 전환"이 자연스럽다 | 낮음 |
| 2 | `FlowScenario` 시나리오/진입점 단위 | 같은 타입, `unit: 'scenario' \| 'entry'` | | 낮음 |
| 3 | 검사 범위 밖 항목 타입 | `UncoveredFlow { kind: 'uncovered-flow', scenarioOrEntry, nodeIds, mode }` — `OutOfScope.untestedFlows.items`에 그대로 | #3과 같은 `OutOfScope` | 낮음 |
| 4 | 깊이 상한 · 내부 한 단계 | 설정 `FlowConfig.internalDepth` (기본 1). 타입에는 두지 않는다 | | 낮음 |
| 5~12 | spike 항목 | → M8. `FlowConfig.mode: 'auto'`로 spike 결과를 받는다 | | — |

### view-changelog.md

| # | 질문 | 선택한 기본값 | 이유 | 되돌리기 |
|---|---|---|---|---|
| 1 | `ChangeEvent` · 멱등 키 | 채택 + `evidenceHash: string`을 타입에 둔다. 6종을 7개 리터럴로 (`dependency-added`/`-removed` 분리 — 아이콘 ⊕⊖이 다르다) | 재실행 멱등 보장을 데이터에 남긴다 | 낮음 |
| 2 | `DecisionRecord` 연결 키 | **에이전트는 `links.rules/commits/packages/services`만 쓴다. `links.events`는 도구가 역으로 채운다.** 매핑: 명시 연결 → 세션+블록 일치 | 이벤트 ID는 감지 뒤에만 있다 | **높음** (M3 결정 기록 형식 — 에이전트 프롬프트가 의존) |
| 3 | 기각·감수가 빌 때 | "사유 없음"은 `reason`만 본다. 불완전 수는 `ChangelogView.incompleteRecords`로 따로 | §14 지표 정의 | 낮음 |
| 4 | 비율 값 위치 | `CheckRun.metrics?: { noReasonEvents, totalEvents }`. 별도 `metrics.jsonl` 없음 | 파일 하나 덜 | 낮음 |
| 5~9 | 감지 단위 · 완화 제안 원천 · 외부 시스템 판정 · 사람 커밋 · `⚠ n` 포함 | → M8. 타입은 `ChangeEvent.session: RunId \| 'manual'`로 사람 커밋을 구분해 둔다. `⚠ n`에 사유 없음 이벤트는 **포함하지 않음**(기본) | | — |

### 이슈 #5 코멘트 (#2 · #3에서 넘어온 것)

| 항목 | 처리 |
|---|---|
| `POST /api/runs/:id/abort` | `api.ts` + README 3.3 |
| 400 · 409 · 404 오류 코드 | `ApiError` discriminated union. 경로별 허용 집합은 `ApiSurface` |
| pid 생존 → `updatedAt` | `RunState.updatedAt` 주석 |
| README 2 표 프로젝트 이름 `파서:` | 고침 |
| 2.1 "검사를 돌려 나온 값은 `실행:`" 한 줄 | 추가 |
| View 재생성 트리거 | `POST /api/views/regenerate { names? }` (`plumb views` spawn). View별 `/refresh` 대신 하나 |

## 4. 되돌리기 비용이 높은 결정 (사람이 확인할 것)

1. View 저장 형식 — JSON 정본 + Markdown 렌더링 (work-views 1)
2. 제안·승인 기록을 `rules.yaml` 밖 별도 파일로 (work-approve 1)
3. 선언된 방향을 첫 슬라이스는 설정 파일에 (view-architecture 2)
4. 계약 해시 기록을 저장소에 두되 M3 포함 여부는 M3 이슈에서 (view-data-contract 1)
5. 검사 매핑 키 = 파일 경로 (view-verification 1)
6. 상태 기록 두 곳 — `CheckRun` 입력 / `RuleStatusRecord` 출력 (view-verification 2)
7. 결정 기록의 연결은 커밋·규칙·패키지로, 이벤트 ID는 도구가 채움 (view-changelog 2)

이 일곱은 CLAUDE.md "되돌리기 비싼 결정은 결정 이슈로"에 해당한다. 이 PR은 타입에 기본값을 둔 것이고, 반대가 있으면 M3 시작 전에 결정 이슈로 연다.

## 5. #63 보완 — 저장 형식에 닿은 항목의 결정 메모

M3~M8 PR들의 "타입 보완 후보"를 #63에서 한 번에 반영했다. 4절의 7건은 바꾸지 않았다(#17 대기). 아래는 그중 저장되는 JSON · jsonl · Markdown의 모양이 타입과 함께 바뀐(또는 이미 그렇게 쓰이고 있던 것을 타입이 뒤늦게 담은) 항목이다. 전부 선택 필드 추가이거나 "측정 불가" 표현이라 기존 파일은 그대로 읽힌다.

| 항목 | 결정 | 출처 |
|---|---|---|
| `approvals/<ruleId>.jsonl` 줄 | `Approval`에 `rulesHash?`(승인 줄의 반영 후 `rules.yaml` sha256) · `note?`. 기각 줄에는 `rulesHash`를 쓰지 않는다. `action: 'propose'`는 읽기만 허용 — 코어는 제안 줄을 쓰지 않는다 (§10) | #38 |
| `contracts/<파일>.json` | `ContractApproval.by`(승인자) 필수. 저장소가 처음부터 요구하던 값이다 | #66 |
| `code-opens.jsonl` 줄 | `CodeOpenRecord.view?` 선택 — `plumb open <file>:<line>`은 View 밖(셸)에서도 부른다. `item`은 저장 시 `file:line`으로 채운다 | #71 |
| `decisions/D-xxxx.md` | `DecisionRecord.links.events?` 선택(도구가 채우는 값이라 비어 있으면 쓰지 않는다) · `extra?`(모르는 `## 절` 보존). 필드 이름 `date`↔front matter `at`, `accepted`↔절 `tradeoff`는 **그대로** — View JSON(`orphanDecisions`)의 키가 바뀌므로 보류 | #39 |
| `views/verification.json` · `plumb check --json` | `OutOfScope.blocksWithoutRules` · `unclassifiedFiles`에 `{ unavailable: 'no-graph' }` 변형. 블록 그래프를 못 얻으면 `[]` · `0`이 아니라 측정 불가로 쓴다 (§12, `untestedFlows`와 같은 모양). `VerificationView.staleResult.previousCommit`은 이전 기록이 없으면 `''`가 아니라 `null` | #62 #68 |
| 블록 그래프 JSON (`BlockGraph`) | `BlockNode.declared? · risk? · shared? · rules?`, `BlockEdge.declaredBy?`, `BlockGraph.externals? · reusedReport?` — 어댑터가 이미 쓰던 필드를 공통 형식에 올렸다. `BlockKind`에 `'shared'`를 더했지만 어댑터는 아직 `kind: 'domain' + shared: true`로 쓴다(값 변경은 별도) | #50 #65 |
| `CheckRun.runner.exitCode` | `-1`(프로세스가 안 돌았다 · 시그널) · `127`(러너 없음) 관례를 주석으로만 적었다. `number \| null`로 바꾸는 것은 저장 형식 결정이라 보류 | #49 #62 |

