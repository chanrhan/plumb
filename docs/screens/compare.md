# 와이어프레임 대조표 — M0 화면 구상 vs 실제 화면 · CLI

이슈 #104의 산출물 (ROADMAP M9 종료 증거 둘째 항목). M0 와이어프레임(`docs/screens/README.md` 2절, `work-*.md` · `view-*.md` 3절 항목 표)의 항목 하나하나를 실제 구현(`apps/ui`, `packages/core/src/cli/commands`, `packages/core/src/views`, `packages/adapter-nextjs`)과 대조한다. 기준 커밋은 `origin/main` `f87af08`(#102 단계 ⑤⑥ 연결 머지 직후). 와이어프레임 원문은 바꾸지 않는다 — 빠진 것과 다른 것은 마지막 절의 M10 이슈 후보로만 남긴다.

## 0. 읽는 법

- 아래 요약표의 구현됨 · 다르게 · 빠짐은 각각 **있음 · 다름 · 없음**의 행 수다.
- **구현 상태**는 세 값 중 하나다. **있음** = 와이어프레임의 항목이 그 출처 접두어대로 화면(또는 View Markdown · CLI 출력)에 나온다. **다름** = 나오긴 하나 출처 · 위치 · 범위가 와이어프레임과 다르거나, 정본 JSON에만 있고 그려지지 않는다. **없음** = 코드가 없다.
- **근거**는 존재하는 파일 경로와 함수 · 컴포넌트 이름이다. 없음의 근거는 "해당 파일 없음" 또는 그 자리를 대신하는 코드다.
- **M10 후보** 열은 "아니오" 또는 "예 → M10-nn"(13절의 번호). M9의 다른 이슈(#105 🟢 판정) 범위인 것은 "아니오 (#105 범위)".
- 항목 앞의 `X-nn`은 이 문서의 행 번호다. 13절의 후보가 이 번호를 가리킨다. 표 머리 행은 `|항목`으로 시작해 `grep -c "^| "`가 데이터 행만 센다.
- View 6개의 본문은 `plumb views`가 쓴 Markdown을 `apps/ui/components/views/ViewBody.tsx`가 그대로 렌더링한다. 그래서 View 항목의 근거는 대부분 `packages/core/src/views/*.ts`의 생성기(`generate`)와 렌더러(`render`)다. 와이어프레임의 클릭 · 토글 · 선택 패널은 Markdown에 없으므로 그 항목은 "없음" 또는 "다름"이다.

|절 | 화면 | 와이어프레임 행 | 구현됨 | 다르게 | 빠짐 |
|---|---|---|---|---|---|
|1 | 공통 레이아웃 (README 2절) | 7 | 3 | 2 | 2 |
|2 | `/rules` (work-approve 3절) | 28 | 22 | 4 | 2 |
|3 | `/runs` (work-run 3절) | 31 | 30 | 1 | 0 |
|4 | `/views` 틀 (work-views 3절) | 15 | 13 | 1 | 1 |
|5 | View 아키텍처 | 18 | 13 | 3 | 2 |
|6 | View 흐름도 | 21 | 17 | 2 | 2 |
|7 | View 변경 로그 | 22 | 15 | 3 | 4 |
|8 | View 검증 상태 | 37 | 20 | 9 | 8 |
|9 | View 외부 의존성 | 14 | 10 | 3 | 1 |
|10 | View 데이터 모델 / 계약 | 21 | 17 | 2 | 2 |
|11 | paper-walkthrough 5절 추가 항목 | 6 | 2 | 2 | 2 |
|12 | 열린 질문 (view-*.md · work-*.md 6절) | 62 | 43 | 12 | 7 |

## 1. 공통 레이아웃 (README 2절 — 상단 바 · 블록 트리)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| C-01 · 프로젝트 이름 | 파서: | 있음 | `apps/ui/app/layout.tsx:RootLayout` — `status.project` ← `packages/core/src/store/status.ts:toStatusResponse` | 아니오 |
| C-02 · 보호 저장소 상태 (정상 / 변조 증거) | 실행: | 다름 | `apps/ui/app/layout.tsx:STORE_LABEL` — `ok` · `tampered` · `unverified` 세 값. 판정은 `rules.yaml` 해시와 마지막 승인 해시 비교(`store/status.ts`)이고 해시 체인 검증(M10)이 아니다. CLI는 `packages/core/src/cli/commands/shared.ts:statusLine` | 예 → M10-01 |
| C-03 · 마지막 검사 커밋 · 시각 | 저장소: | 있음 | `apps/ui/app/layout.tsx:formatLastCheck` ← `status.lastCheck` (`store/status.ts`) | 아니오 |
| C-04 · 미확인 항목 수 `⚠ n` | 저장소: | 있음 | `apps/ui/app/layout.tsx` — `unconfirmed.total` = 잠정 규칙 + 검토 대기열 (`store/status.ts:toStatusResponse`) | 아니오 |
| C-05 · 블록 트리 L0 / L1 | 파서: | 없음 | `apps/ui/app/layout.tsx` `<aside>`가 "블록 아직 없음" 고정. `GET /api/blocks` route 없음(`apps/ui/app/api/`에 `blocks` 없음). 타입 `BlocksResponse`만 `packages/core/src/types/api.ts`에 있다 | 예 → M10-02 |
| C-06 · 블록 옆 상태 점 (최악 상태) | 저장소: | 없음 | 해당 파일 없음 — 블록 트리 자체가 없다. 집계 함수는 `packages/core/src/checks/summary.ts:computeBlockSummaries`에 있다 | 예 → M10-02 |
| C-07 · 미분류 파일 수 (항상 보인다) | 파서: | 다름 | 사이드바에 없다. 아키텍처 View 본문(`packages/core/src/views/architecture.ts:renderSummaryBand` · `renderL1`)에만 보인다 | 예 → M10-02 |

## 2. `/rules` — 규칙 목록 · 승인 (work-approve 3절)

### 2.1 목록 · 머리 (3.1)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| A-01 · 규칙 ID | 저장소: | 있음 | `apps/ui/components/rules/RuleRow.tsx:RuleRow` · `apps/ui/lib/rules.ts:listItem` · CLI `packages/core/src/cli/commands/rule.ts:collectRows` | 아니오 |
| A-02 · 블록 (트리에 없으면 `?`) | 저장소: | 있음 | `RuleRow.tsx` (`blockKnown` 거짓 → ` ?`) · `lib/rules.ts:listItem` — 블록 트리가 없어 `config.blocks` 키로 판정한다 | 아니오 |
| A-03 · 종류 (arch · tech · biz 축약) | 저장소: | 있음 | `RuleRow.tsx` · `apps/ui/components/rules/format.ts:KIND_SHORT` · CLI `shared.ts:KIND_SHORT` | 아니오 |
| A-04 · EARS 한 줄 진술 (목록 한 줄 · 상세 전문) | 저장소: | 있음 | `RuleRow.tsx` `.statement` · `apps/ui/app/rules/[id]/page.tsx:RuleDetailPage` "진술" | 아니오 |
| A-05 · 상태 🟢🟡🟠🔴⬜ | 저장소: (원자료 실행:) | 다름 | `apps/ui/components/rules/StatusIcon.tsx` ← `store.ruleStatus` (`lib/rules.ts:listItem`). 🟢 · 🟠 판정이 `packages/core/src/checks/status.ts`에 아직 없어 통과는 전부 🟡 `no-injection` — #105 범위 | 아니오 (#105 범위) |
| A-06 · 상태의 커밋 · 시각 | 저장소: | 있음 | `StatusIcon.tsx` `title`(`statusAt`) · `apps/ui/app/rules/page.tsx` 머리줄 "마지막 검사" | 아니오 |
| A-07 · 승인 상태 (잠정 · 승인 · 기각, 기각은 기본 숨김) | 저장소: | 있음 | `lib/rules.ts:approvalStateOf` · `applyRuleListFilter` (`approval=rejected`로만 본다) | 아니오 |
| A-08 · `⚠ 미확인` 표시 | 저장소: | 있음 | `RuleRow.tsx` (`approval === 'provisional'`) | 아니오 |
| A-09 · `⚡` 고위험 표시 (규칙 `risk` · 블록 선언) | 저장소: | 있음 | `lib/rules.ts:isHighRiskRule` — `risk: high` 또는 `config.blocks[block].risk === 'high'`. 블록 선언(M10 예정)까지 이미 된다 | 아니오 |
| A-10 · 미확인 n건 · 최장 n일 체류 | 저장소: | 있음 | `apps/ui/app/rules/page.tsx` 머리줄 ← `lib/rules.ts:readRuleList` (`store.status()`) | 아니오 |
| A-11 · 대기열 상한 경고 띠 | 저장소: | 있음 | `apps/ui/app/rules/page.tsx` (`queueLimit.exceeded`, `config.reviewQueue`). 신규 제안 중단은 문구 "(M10)"만 | 예 → M10-06 |
| A-12 · 필터 (블록 · 종류 · 승인 · 상태) URL 쿼리 | 사용자 입력: | 다름 | `lib/rules.ts:parseRuleListFilter` · `apps/ui/app/rules/page.tsx` `<form>` select. 블록 트리 클릭 연동은 없다(C-05) — 블록도 select로 고른다 | 예 → M10-02 |

### 2.2 상세 (3.2)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| D-01 · 출처 (plan · code · reference) | 저장소: | 있음 | `apps/ui/app/rules/[id]/page.tsx` "출처:" (`shown.source`) · CLI `rule.ts:showRule` | 아니오 |
| D-02 · 변경 종류 (추가 · 강화 · 완화 · 삭제 · 경계 변경) | 저장소: | 있음 | `apps/ui/app/rules/[id]/page.tsx` · `components/rules/format.ts:CHANGE_KIND_LABEL` (5종 라벨 전부) | 아니오 |
| D-03 · 사전 승인 필요 표시 (승인 전까지 기존 규칙 유효) | 저장소: | 있음 | `apps/ui/app/rules/[id]/page.tsx` · `components/rules/ApprovePanel.tsx` (`requiresPriorApproval`). 승인 자체는 코어가 거부(`applied: false`) — 결정 단위 승인은 M10 | 예 → M10-03 |
| D-04 · 의존 규칙 (`depends_on`) 과 각각의 상태 (클릭 이동) | 저장소: | 있음 | `apps/ui/app/rules/[id]/page.tsx` "의존" (`detail.depends`, `Link`) ← `lib/rules.ts:readRuleDetail` | 아니오 |
| D-05 · 부착된 검사 파일 (`checks[]`) | 저장소: | 있음 | `apps/ui/app/rules/[id]/page.tsx` "검사" 목록 ← `lib/rules.ts:checkDetails` | 아니오 |
| D-06 · 검사 파일 존재 여부 | 파서: | 있음 | `lib/rules.ts:checkDetails` (`fileExists`) → "⬜ 파일 없음" | 아니오 |
| D-07 · 검사 파일별 결과 (🔴 실패 · 커밋 · 시각) | 실행: | 있음 | `lib/rules.ts:checkDetails` (`store.checks.latest()` → `lastResult`) · `page.tsx` | 아니오 |
| D-08 · 검사 파일 `[IDE ↗]` | 사용자 입력: | 없음 | `apps/ui/app/rules/[id]/page.tsx`에 열람 링크 없음 (`<code>` 텍스트만). 대화창은 `apps/ui/components/views/OpenDialog.tsx`에만 붙어 있다 | 예 → M10-04 |
| D-09 · 결정 기록 D-xxxx 네 항목 (결정 · 이유 · 기각 · 감수) | 저장소: | 다름 | `apps/ui/app/rules/[id]/page.tsx` "결정" — 파일 유무만(`decisionFile`). 파서 `packages/core/src/decisions/format.ts:parseDecision`은 있으나 `lib/rules.ts:readRuleDetail`이 `DecisionRecord`를 채우지 않는다 | 예 → M10-05 |
| D-10 · 변경 diff | 저장소: | 있음 | `lib/rules.ts:diffRules` · `page.tsx` `.rule-diff` | 아니오 |
| D-11 · 제안자 · 제안 시각 (클릭 → `/runs/<id>`) | 저장소: | 다름 | `page.tsx` "제안 p-… · 시각 · run r-…" 텍스트만 — `/runs?id=` 링크 없음 | 예 → M10-04 |
| D-12 · 승인 이력 (제안 → 승인/기각 → …) | 저장소: | 있음 | `page.tsx` "이력" (`detail.approvals`) · `GET /api/rules/:id` (`apps/ui/app/api/rules/[id]/route.ts`) | 아니오 |
| D-13 · `[승인]` 버튼 | 사용자 입력: | 있음 | `ApprovePanel.tsx:post('approve')` → `apps/ui/app/api/rules/[id]/approve/route.ts` → `lib/rules-api.ts:handleApprove` (401 · 409 문구는 4절 표 그대로) | 아니오 |
| D-14 · `[기각]` 버튼 (사유 비면 비활성) | 사용자 입력: | 있음 | `ApprovePanel.tsx` (`reasonEmpty` → disabled) → `lib/rules-api.ts:handleReject` (400 `reason-required`) | 아니오 |
| D-15 · 기각 사유 | 사용자 입력: | 있음 | `ApprovePanel.tsx` `<textarea name="reason">` · 승인 기록 `reason`. 재제안 입력 연결은 M10 | 아니오 |
| D-16 · M10 자리 표시 (이의 제기 · 해석 불일치 · 결정 승인 묶음 비활성 탭) | 저장소: | 없음 | `apps/ui/app/rules/page.tsx`에 자리 없음 (`ViewTabs.tsx`의 `.tab-later`는 `/views`에만) | 예 → M10-07 |

## 3. `/runs` — 실행 · 진행 상황 (work-run 3절)

### 3.1 새 실행

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| N-01 · `[▶ 새 실행]` 버튼 (승인 0개면 비활성) | 사용자 입력: | 있음 | `apps/ui/components/runs/new-run-panel.tsx:NewRunPanel` (`disabledReason` — 규칙 없음 · 승인 없음 · 진행 중) | 아니오 |
| N-02 · 규칙 선택 목록 (ID · 상태 · 승인, 잠정은 선택 불가) | 저장소: | 있음 | `new-run-panel.tsx` (`PanelRule`, `selectable`) ← `apps/ui/app/runs/page.tsx` `readRuleList()` | 아니오 |
| N-03 · 선택한 규칙 (첫 슬라이스 1개) | 사용자 입력: | 있음 | `new-run-panel.tsx` `selected` 단일 — 여러 개는 M10 | 예 → M10-08 |
| N-04 · 예산 상한 · maxTurns · stopBlockLimit | 저장소: | 있음 | `apps/ui/lib/runs.ts:readRunLimits` · `new-run-panel.tsx:limitsText` (상한 없으면 `[시작]` 비활성) | 아니오 |
| N-05 · `[시작]` 버튼 → `POST /api/runs { ruleIds }` | 사용자 입력: | 있음 | `new-run-panel.tsx:start` → `apps/ui/app/api/runs/route.ts:POST` → `lib/runs.ts:startDetachedRun` (`plumb run --detach --json`) | 아니오 |

### 3.2 실행 목록

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| L-01 · 실행 ID | 저장소: | 있음 | `apps/ui/components/runs/run-list.tsx:RunList` ← `apps/ui/app/api/runs/route.ts:GET` (`store.runs.list()`) · CLI `packages/core/src/cli/commands/run.ts:runsListText` | 아니오 |
| L-02 · 시작 시각 (오늘이면 시각만) | 저장소: | 있음 | `apps/ui/components/runs/format.ts:startedLabel` | 아니오 |
| L-03 · 상태 (진행중 · 완료 · 실패 · 예산초과 · 중단) | 저장소: | 있음 | `format.ts:RUN_STATUS_LABEL` — CLI `run.ts:STATUS_LABEL`과 같은 라벨 | 아니오 |
| L-04 · 현재(마지막) 단계 ①~⑥ | 저장소: | 있음 | `run-list.tsx` (`STAGE_MARK[run.stage]`) | 아니오 |
| L-05 · 선택된 실행 (`?id=`, 기본 최근) | 사용자 입력: | 있음 | `apps/ui/app/runs/page.tsx` (`selectedId = requested ?? runs[0]`) | 아니오 |

### 3.3 실행 상세

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| S-01 · 경과 시간 | 저장소: | 있음 | `apps/ui/components/runs/run-detail.tsx:RunDetail` (`elapsedLabel`, 1초 시계) | 아니오 |
| S-02 · 마지막 갱신 n초 전 (60초 경고) | 저장소: | 있음 | `run-detail.tsx` (`updatedAgoSec`, `STALE_MS`) | 아니오 |
| S-03 · pid | 저장소: | 있음 | `run-detail.tsx` 머리 (`state.pid`) · CLI `run.ts:runShowText` | 아니오 |
| S-04 · 대상 규칙과 현재 상태 (클릭 → `/rules`) | 저장소: | 있음 | `run-detail.tsx` (`ruleIds` `Link` + `STATUS_ICON[ruleStatus]`) | 아니오 |
| S-05 · 단계 ① 승인 ✔ · 시각 | 저장소: | 있음 | `apps/ui/components/runs/stage-track.tsx:stageResultText` case 1 (`approvedAt`) | 아니오 |
| S-06 · 단계 ②~⑥ 현재 위치 (● ✔ 빈칸 · n회차) | 저장소: | 있음 | `stage-track.tsx:stageRows` (`stages[]` 최신 기록, `attempt > 1` → "n회차") | 아니오 |
| S-07 · 단계 ② 결과 (`🔴 n/n 실패`) | 실행: | 있음 | `stage-track.tsx:stageResultText` case 2 (`allFailed`) | 아니오 |
| S-08 · 단계 ③ 결과 (`n/n 통과`) | 실행: | 있음 | `stage-track.tsx` case 3 (`allPassed`, `disputeId`) | 아니오 |
| S-09 · 단계 ④ 결과 (규칙별 상태) | 실행: | 있음 | `stage-track.tsx` case 4 (`byRule`) | 아니오 |
| S-10 · 단계 ⑤ 결과 (주입 n · 잡힘 n) | 실행: | 있음 | `stage-track.tsx` case 5 · `packages/core/src/run/pipeline.ts` (`finishStage({ stage: 5, injections, caught, weak })`) | 아니오 |
| S-11 · 단계 ⑥ 결과 (갱신된 View n · 대기열 n) | 저장소: | 있음 | `stage-track.tsx` case 6 · `pipeline.ts` (`viewsUpdated`, `queued`) | 아니오 |
| S-12 · 현재 역할 | 저장소: | 있음 | `apps/ui/components/runs/role-usage.tsx:RoleUsage` (`currentRole`, 없으면 `—`) | 아니오 |
| S-13 · 역할별 반복 횟수 / 상한 | 저장소: | 있음 | `role-usage.tsx` (`roles[role].turns` / `limits.maxTurns`) | 아니오 |
| S-14 · 역할별 종료 차단 횟수 / 상한 | 저장소: | 있음 | `role-usage.tsx` (`stopBlocks` · 현재 역할은 `consecutiveStopBlocks` / `stopBlockLimit`) | 아니오 |
| S-15 · 예산 사용량 (추정) / 상한 + 막대 | 저장소: | 있음 | `role-usage.tsx:budgetText` (`costUsd === null` → "비용 정보 없음") | 아니오 |
| S-16 · 이의 제기 (건수 · 시각 · 역할 → 역할 · 요지) | 저장소: | 있음 | `run-detail.tsx` `.run-disputes` (`disputes[]`, `DISPUTE_STATUS_LABEL`) — 판정 화면은 M10 | 예 → M10-07 |
| S-17 · 마지막 실행 출력 (가로챈 stdout/stderr 꼬리) | 실행: | 다름 | `apps/ui/components/runs/output-tail.tsx:OutputTail` ← `RunState.capturedOutput.tail` — 상태 파일 안의 꼬리이고 `runs/<id>/output.log` 파일이 아니다. 전체 로그는 `runs/<id>/run.log`(`run.ts:childLogPath`)에만 | 아니오 |
| S-18 · 마지막 실행 출력의 시각 · 종료 코드 | 실행: | 있음 | `output-tail.tsx` `.output-foot` (`finishedAt`, `exitCode`) | 아니오 |
| S-19 · 종료 상태 · 시각 | 저장소: | 있음 | `run-detail.tsx:outcomeText` (`outcome.status`, `finishedAt`) | 아니오 |
| S-20 · 종료 사유 한 줄 (→ 검토 대기열) | 저장소: | 있음 | `run-detail.tsx:outcomeText` · `format.ts:FAIL_REASON_LABEL` (`queueItemId` 표시) | 아니오 |
| S-21 · `[중단]` 버튼 (확인 → SIGTERM) | 사용자 입력: | 있음 | `run-detail.tsx:requestAbort` → `apps/ui/app/api/runs/[id]/abort/route.ts` → `lib/runs.ts:abortRun`. README 3.3에 `POST /api/runs/:id/abort`로 들어갔다 | 아니오 |

## 4. `/views` — View 보기 틀 (work-views 3절)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| V-01 · 탭 6개의 활성 여부 | 저장소: | 있음 | `apps/ui/components/views/ViewTabs.tsx` (`generated` ← `apps/ui/lib/views.ts:listGeneratedViews`) · `apps/ui/app/api/views/[name]/route.ts` 404 `not-generated` | 아니오 |
| V-02 · 선택된 탭 (`?view=`, 기본 architecture, 모르는 값 → "그런 View 없음") | 사용자 입력: | 있음 | `apps/ui/app/views/page.tsx:ViewsPage` (`DEFAULT_VIEW`, `isViewName`) | 아니오 |
| V-03 · 블록 필터 칩 (× 로 해제) | 사용자 입력: | 다름 | `apps/ui/app/views/page.tsx:BlockFilter` — 칩은 그리되 `aria-disabled`, 블록 트리 클릭이 없다 | 예 → M10-02 |
| V-04 · 필터가 본문에 적용되는 범위 (항목별 블록 태그) | 파서: | 없음 | 본문 Markdown에 항목별 블록 태그가 없다 — `packages/core/src/views/markdown.ts:anchorUrl`은 `file` · `line`만 싣는다 (`Anchor.block`은 JSON에만) | 예 → M10-02 |
| V-05 · View 본문 (Markdown + Mermaid, 렌더 실패 시 원문) | 저장소: | 있음 | `apps/ui/components/views/ViewBody.tsx` (react-markdown + remark-gfm) · `Mermaid.tsx` ("다이어그램 렌더 실패" + 원문) | 아니오 |
| V-06 · 항목의 `file:line` 링크 | 파서: | 있음 | `packages/core/src/views/markdown.ts:anchorLink` (`plumb://open?file=&line=`) → `ViewBody.tsx` `a` 가로채기 | 아니오 |
| V-07 · `[IDE ↗]` 버튼 (클릭만으로는 안 열림) | 사용자 입력: | 있음 | `ViewBody.tsx` (`preventDefault` → `OpenDialog`) | 아니오 |
| V-08 · 이유 종류 라디오 하나 필수 | 사용자 입력: | 있음 | `apps/ui/components/views/OpenDialog.tsx` (`reason === null` → 비활성) · `reasons.ts:REASON_OPTIONS` · `apps/ui/app/api/open/route.ts` 400 `reason-required` · CLI `packages/core/src/cli/commands/open.ts` exit 2 | 아니오 |
| V-09 · 메모 한 줄 (선택) | 사용자 입력: | 있음 | `OpenDialog.tsx` `note` → `CodeOpenInput.note` (`packages/core/src/store/code-opens.ts`) | 아니오 |
| V-10 · 열람 횟수 (이 View · 이 생성 커밋 이후) | 저장소: | 있음 | `apps/ui/lib/views.ts:readViewResponse` (`store.codeOpens.count(name, generatedAt)`) · `page.tsx` "열람 n회" | 아니오 |
| V-11 · 생성 출처 표시줄 (`sources[]` → 접두어) | 저장소: | 있음 | `apps/ui/app/views/page.tsx` `.view-sourcebar` ← `packages/core/src/views/markdown.ts:formatSource` (`SOURCE_PREFIX` 5종 1:1) | 아니오 |
| V-12 · 마지막 생성 시각 | 저장소: | 있음 | `page.tsx` `.view-foot` (`header.generatedAt`) | 아니오 |
| V-13 · 마지막 생성 커밋 (7자리) | git: | 있음 | `page.tsx` (`shortCommit(header.commit)`, 없으면 "생성 커밋 기록 없음") ← `packages/core/src/views/context.ts:buildViewContext` | 아니오 |
| V-14 · 오래됨 표시 (`⚠ HEAD와 다름`) | git: | 있음 | `apps/ui/lib/views.ts:staleOf` · `page.tsx` `.view-stale` · 갱신은 `components/views/RegenerateButton.tsx` → `apps/ui/app/api/views/regenerate/route.ts` | 아니오 |
| V-15 · M10 자리 표시 (추적성 매트릭스 · 검토 대기열 · 규칙·계약 편집) | 저장소: | 있음 | `ViewTabs.tsx` `.tab-later` 비활성 항목 | 아니오 |

## 5. View — 아키텍처 다이어그램 (view-architecture 3절)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| AR-01 · L1 블록 노드 (이름 · 경로 · 파일 수) | 파서: | 있음 | `packages/adapter-nextjs/src/extract-dependencies.ts` (파일 → 블록 접기) → `packages/core/src/views/architecture.ts:renderL1` · `renderBlocksTable` | 아니오 |
| AR-02 · L1 간선 (방향 · import 수) | 파서: | 있음 | `architecture.ts:renderL1` (`edge.count`) · `renderEdgesTable` | 아니오 |
| AR-03 · 간선의 "공개 / 내부 파일" 구분 | 파서: | 있음 | `architecture.ts:renderL1` (`site.viaPublic` → "공개" / "내부 n") | 아니오 |
| AR-04 · 간선의 "선언 / 미선언" 구분 | 파서: | 있음 | `architecture.ts:renderL1` (`edge.declared` → 실선 / 점선) · `configMissing` 안내 | 아니오 |
| AR-05 · 순환 수 | 파서: | 있음 | `architecture.ts:blockCycles` (Tarjan, 블록 수준만) | 아니오 |
| AR-06 · 필수 검사 (1)(2) 결과 🔴 n건 + `file:line` | 실행: | 있음 | `architecture.ts:computeRequiredChecks` ← `packages/core/src/checks/common.ts:computeCommonRows` (최신 `CheckRun`) · `renderRequiredChecks` | 아니오 |
| AR-07 · 필수 검사 (3) 공개 계약 시그니처 변경 △ n건 | git: | 없음 | `architecture.ts:computeRequiredChecks` `signatureChanges: { changes: [] }` 고정 · `checks/common.ts` 행 3 `unchecked` 고정 — 비교 코드 없음 (렌더가 "M8 wave 1 — 아직 비교하지 않았다") | 예 → M10-09 |
| AR-08 · 요약 띠 (블록 수 · 경계 넘는 import · 위반 · 순환) | 파서: + 실행: | 있음 | `architecture.ts:renderSummaryBand` | 아니오 |
| AR-09 · 미분류 파일 수 ▲ + 목록 | 파서: | 있음 | `architecture.ts:renderArchitecture` "미분류 파일 n개" (각 파일 `anchorLink`) | 아니오 |
| AR-10 · 마지막 커밋 영향 범위 (n 블록 + 미분류 m) | git: | 있음 | `architecture.ts:computeImpact` (`git diff --name-only HEAD~1..HEAD`) · `renderImpact` | 아니오 |
| AR-11 · 생성 커밋 · 시각 · 도구 버전 | 파서: | 있음 | `architecture.ts:renderArchitecture` "생성:" (`header.commit`, `generatedAt`, `tool`) | 아니오 |
| AR-12 · L0 노드 — 앱 | 파서: | 있음 | `architecture.ts:withSystemNode` · `appLabel` (`package.json` `name`) · `renderL0` | 아니오 |
| AR-13 · L0 노드 — DB | 파서: | 있음 | `extract-dependencies.ts:detectPrisma` (+ compose `image: postgres*`를 하나로 합침) | 아니오 |
| AR-14 · L0 노드 — 캐시 · 큐 · 외부 API | 파서: | 다름 | `extract-dependencies.ts:parseComposeServices` (compose `image` → 종류). `.env.example` 변수 이름 스캔이 없어 compose에 없는 외부 API 노드는 안 생긴다. 미감지는 "감지된 설정 없음" 점선 노드(`renderL0`) | 예 → M10-10 |
| AR-15 · L0 간선 (앱 → 인프라) + 쓰는 L1 블록 | 파서: | 다름 | `extract-dependencies.ts:infraEdgesOf` (클라이언트 패키지 매핑표). `process.env.<이름>` 참조 스캔 없음 — 파일 머리 "M8 … 지금은 하지 않는다" | 예 → M10-10 |
| AR-16 · L0 선택 패널의 근거 `file:line` | 파서: | 다름 | `BlockNode.evidence`는 JSON에 있으나(`extract-dependencies.ts:evidenceAt`) `architecture.ts:renderL0` · 표가 근거 행을 그리지 않는다. 의존성 View 서비스 표(`dependencies.ts:renderServices`)에만 보인다 | 예 → M10-11 |
| AR-17 · 블록 필터 (블록 트리 클릭) | 사용자 입력: | 없음 | 해당 파일 없음 — 본문은 정적 Markdown이고 필터 적용이 없다 (V-03 · V-04) | 예 → M10-02 |
| AR-18 · `[IDE에서 열기]` | 사용자 입력: | 있음 | `architecture.ts` `anchorLink` (간선 첫 import · 위반 행 · 미분류 파일) → `ViewBody.tsx` / `OpenDialog.tsx` · CLI `open.ts` | 아니오 |

## 6. View — 도메인별 흐름도 (view-flow 3절)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| F-01 · 마지막 실행 커밋 · 시각 | 저장소: | 다름 | `packages/core/src/views/flow.ts:createFlowGenerator` (`view.lastCheck` ← `store.checks.latest()`) — JSON에만 있고 `renderFlow`가 머리글에 그리지 않는다 | 예 → M10-12 |
| F-02 · 수집된 트레이스 수 (A안) | 실행: | 있음 | `flow.ts` (`traceCount = traces.files.length`) · `renderFlow` "스팬 파일 n개" | 아니오 |
| F-03 · 테스트가 안 지나간 흐름 수 (검증 View로 전달) | 실행: − 파서: | 다름 | `flow.ts:computeUncovered` · `renderFlow` 마지막 절. 검증 View로의 전달이 없다 — `verification.ts`가 `untestedFlows: { unavailable: 'no-trace' }` 고정, `checks/out-of-scope.ts`도 같다 | 예 → M10-13 |
| F-04 · 시나리오 목록 (A안: 인수 테스트 하나 = 시나리오) | 실행: + 저장소: | 있음 | `flow.ts:buildTraceScenario` (`test/**` JUnit testcase, `isAcceptanceTestFile`) · `buildCheckIndex` (규칙 매핑) | 아니오 |
| F-05 · 정적 그래프에서만 도출된 시나리오 (전부 점선) | 파서: | 있음 | `flow.ts:derivedScenario` (`derivedFromStatic`) | 아니오 |
| F-06 · 진입점 목록 (B안: `route.ts` export) | 파서: | 있음 | `packages/adapter-nextjs/src/call-graph.ts` (`entryGlob` 기본 `src/app/api/**/route.ts`) → `flow.ts:staticScenario` | 아니오 |
| F-07 · 시나리오 결과 ✔/✘ (실패 지점) | 실행: | 있음 | `flow.ts:buildTraceScenario` (`result`, `failurePoint` = 마지막 스팬) · `scenarioStatusLine` | 아니오 |
| F-08 · 연결 규칙과 상태 점 | 저장소: | 있음 | `flow.ts:rulesFor` · `scenarioStatusLine` ("(규칙 없음)" 포함) | 아니오 |
| F-09 · 실선 노드 · 순서 · 중첩 (A안 스팬 트리) | 실행: | 있음 | `flow.ts:buildSpanForest` · `spanForestToNodes` (`startTimeUnixNano` 순) | 아니오 |
| F-10 · 점선 노드 (A안: 정적 − 스팬) | 파서: | 있음 | `flow.ts:overlayStatic` (`evidence: 'static'`) · `scenarioMermaid` `-.->` | 아니오 |
| F-11 · 정적 엣지 (B안 심볼 수준 호출 그래프) | 파서: | 있음 | `packages/adapter-nextjs/src/call-graph.ts` (TS 컴파일러 API, `internalDepth` 한 단계 규칙) | 아니오 |
| F-12 · 외부 시스템 노드 ⬡ (A안 스팬 속성) | 실행: | 있음 | `flow.ts:spanToNode` (`prisma:client:operation`, `db.system`) | 아니오 |
| F-13 · 외부 시스템 노드 ⬡ (B안 import) | 파서: | 있음 | `call-graph.ts` (`ext:` 노드) · `flow.ts:staticScenario` (`testRef: 'static'`) — "호출 가능성" 범례는 `renderFlow` 머리글 | 아니오 |
| F-14 · 이벤트 노드 `emit <topic>` · 핸들러 | 실행: / 파서: | 있음 | `flow.ts:spanToNode` (`messaging.destination`, producer / consumer) · `staticScenario` (`handlerUnknown`) | 아니오 |
| F-15 · `file:line` (심볼 위치) | 파서: | 있음 | `flow.ts:spanToNode` (`graph.symbols[id]` → `anchor`) · `scenarioTable` "위치" 열 | 아니오 |
| F-16 · 진입점의 "테스트 있음 / 없음" (B안) | 저장소: + 파서: | 있음 | `flow.ts:staticScenario` (`graph.testRefs` ∩ 검사 매핑) · `scenarioStatusLine` | 아니오 |
| F-17 · 노드의 "참조됨 / 내부 / 정적" (B안) | 파서: | 있음 | `flow.ts:staticScenario` (`testRef`) · `evidenceLabel` | 아니오 |
| F-18 · "트레이스 없음 (B안)" 안내 + 모드 표시 | 실행: | 있음 | `flow.ts` (`mode`, `fallback`) · `renderFlow` 머리글 "모드: 트레이스 / 정적" | 아니오 |
| F-19 · 도메인 묶음 (좌측 시나리오 목록) | 파서: | 없음 | `flow.ts:renderFlow`는 시나리오를 순서대로 나열 — 블록별 묶음 · 좌측 목록 없음 (`scenario.block`은 JSON에만) | 예 → M10-14 |
| F-20 · 시나리오 · 진입점 선택 (`?scenario=`) | 사용자 입력: | 없음 | `apps/ui/app/views/page.tsx`가 `?scenario=`를 읽지 않는다. 모든 시나리오를 한 페이지에 그린다 | 예 → M10-14 |
| F-21 · 코드 열람 점프 | 사용자 입력: | 있음 | `flow.ts:scenarioTable` `anchorLink` → `ViewBody.tsx` / `OpenDialog.tsx` | 아니오 |

## 7. View — 기술 변경 로그 (view-changelog 3절)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| CL-01 · 기준 커밋 범위 (`a1b2c3 ← 9f8e7d`) | 저장소: + git: | 있음 | `packages/core/src/views/changelog.ts:resolveBase` (마지막 changelog 커밋 → `CheckRun.commit` → HEAD만) · `rangeLabel` | 아니오 |
| CL-02 · 사유 없는 설계 변경 이벤트 비율 | 저장소: | 다름 | `changelog.ts:generateChangelogView` (`metric`) — 이벤트를 `changelog/events.jsonl`에 쌓지 않고 매번 재감지한다 (View JSON이 유일한 기록) | 예 → M10-15 |
| CL-03 · 최근 5회 추이 | 저장소: | 없음 | `changelog.ts:trendOf`는 `CheckRun.metrics`를 읽지만 `plumb check`(`packages/core/src/checks/run-check.ts`)가 `metrics`를 쓰지 않는다 → 항상 "추이 없음" | 예 → M10-15 |
| CL-04 · 커밋 묶음 머리글 (해시 · 시각) | git: | 있음 | `changelog.ts:groupByCommit` · `renderGroup` (커밋 메시지는 쓰지 않는다) | 아니오 |
| CL-05 · 커밋 묶음 머리글 세션 `s-nnn` | 저장소: | 없음 | `changelog.ts:groupByCommit` `session: 'manual'` 고정 · `packages/core/src/changelog/detect.ts` `session: 'manual'` — `runs/*.json` 커밋 범위 역매핑 없음 | 예 → M10-16 |
| CL-06 · 이벤트 ID `E-nnnn` (근거 해시 멱등) | 저장소: | 다름 | `changelog/detect.ts:eventId` — `E-` + sha1 앞 8자리 (순번이 아니라 해시. 멱등은 지킨다) | 아니오 |
| CL-07 · ⊕⊖ 새 의존성 도입 / 제거 | git: + 파서: | 있음 | `detect.ts` (`dependency-added` · `dependency-removed`, lockfile 전후 — `views/lockfile.ts` 공유) | 아니오 |
| CL-08 · ▣ 새 블록 · 블록 경계 변경 | 파서: | 있음 | `detect.ts` (`block-boundary`, 블록 그래프 전후 — base는 임시 worktree `withBaseWorktree`) | 아니오 |
| CL-09 · ⇄ 블록 경계를 넘는 새 의존 관계 | 파서: | 있음 | `detect.ts` (`cross-block-dependency`, 엣지 전후 + depcruise 위반 여부) | 아니오 |
| CL-10 · ≡ 계약 변경 | git: + 파서: | 있음 | `detect.ts` (`contract-changed`, `readSchemas()` 전후) | 아니오 |
| CL-11 · ⚖ 규칙 변경 · 완화 제안 | 저장소: | 있음 | `detect.ts` (`rule-changed`, `approvals/` + `proposals/` 이력). 이의 제기 → 완화 제안 연결은 없다 (Q-C6) | 아니오 |
| CL-12 · ⬡ 새 외부 시스템 연결 | 파서: + git: | 있음 | `detect.ts` (`external-system`, L0 노드 집합 전후) | 아니오 |
| CL-13 · 이벤트 제목 (템플릿 + 식별자) | 파서: | 있음 | `detect.ts` (`title`) · `changelog.ts:renderGroup` "대상" 열 | 아니오 |
| CL-14 · 이벤트의 블록 (여럿 · 미분류) | 파서: | 있음 | `changelog.ts:blocksCell` (`blocks[]`, `unclassified`) | 아니오 |
| CL-15 · 감지 근거 `file:line` + 전후 값 | git: / 파서: | 있음 | `changelog.ts:evidenceCell` (`anchorLink` 또는 `excerpt`) — 근거마다 `source`가 `ChangeEvidence`에 있다 | 아니오 |
| CL-16 · 결정 기록 D-nnnn 전문 (결정 · 이유 · 기각 · 감수 · 연결) | 저장소: | 다름 | `changelog.ts:renderDecisions` — ID · 연결 이벤트 · 연결 규칙 · 이유 유무만. 전문은 "저장소 `decisions/`에서 읽는다" (`ChangelogView`에 `DecisionRecord[]` 자리 없음, #63 보류) | 예 → M10-05 |
| CL-17 · 이벤트 ↔ 결정 기록 연결 | 저장소: | 있음 | `packages/core/src/changelog/link.ts:linkDecisions` (명시 `links` 우선, 없으면 커밋 · 블록 일치) | 아니오 |
| CL-18 · "사유 없음" 표시 (`no-record` / `empty-reason`) | 저장소: | 있음 | `changelog.ts:decisionCell` · `NO_REASON_LABEL` | 아니오 |
| CL-19 · 연결 규칙의 상태 점 | 저장소: | 있음 | `changelog.ts:ruleCell` (`linkedRules`, "(없는 규칙)") | 아니오 |
| CL-20 · 세션 링크 `/runs/s-nnn` | 저장소: | 없음 | `changelog.ts:sessionCell`은 "수동" 또는 코드 텍스트 — 링크 없음 (CL-05와 같은 원인) | 예 → M10-16 |
| CL-21 · 필터 (블록 · 종류 · 사유 없음만 · 기간) | 사용자 입력: | 없음 | `apps/ui/app/views/page.tsx`에 changelog 전용 필터 없음. 본문은 정적 Markdown | 예 → M10-14 |
| CL-22 · 코드 열람 점프 | 사용자 입력: | 있음 | `changelog.ts:evidenceCell` `anchorLink` → `ViewBody.tsx` (결정 기록 본문에는 링크를 만들지 않는다 — 4절 그대로) | 아니오 |

## 8. View — 테스트/검증 상태 (view-verification 3절)

### 8.1 상단 요약 (3.1)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| VF-01 · 미확인 항목 n건 (잠정 규칙 + 대기열) | 저장소: | 있음 | `packages/core/src/views/verification.ts:generateVerificationView` (`status.unconfirmed + status.reviewQueue`) · `headline` · CLI `packages/core/src/cli/commands/check.ts:renderCheck` | 아니오 |
| VF-02 · 최장 체류 (일수 · 규칙 ID) | 저장소: | 있음 | `verification.ts` (`longestPendingDays`, `longestPendingRule` ← 가장 오래된 잠정 제안) | 아니오 |
| VF-03 · 보호 저장소 상태 (정상 / 변조 증거) | 실행: | 다름 | `verification.ts:storeStatusText` — 해시 체인이 아니라 `rules.yaml` 해시 vs 마지막 승인 해시 (C-02와 같다) | 예 → M10-01 |
| VF-04 · 마지막 검사 커밋 · 시각 (모든 절에 반복) | 실행: | 있음 | `verification.ts:headline` · `blockSection` · `outOfScopeSection` (`commitTime`) | 아니오 |
| VF-05 · 규칙 수 · 승인 수 | 저장소: | 있음 | `verification.ts:summaryLine` (`rows.length`, `approvalStates`) | 아니오 |
| VF-06 · 상태 집계 🟢🟡🟠🔴⬜ (0 포함) | 실행: | 있음 | `verification.ts:summaryLine` ← `packages/core/src/checks/summary.ts:computeStatusCounts` | 아니오 |
| VF-07 · 검사 수 (JUnit n · 정적 m) · 격리 수 | 실행: | 있음 | `verification.ts:summaryLine` (`latestRun.counts`, `quarantined.length`) | 아니오 |
| VF-08 · 상태 토글 · 정렬 | 사용자 입력: | 없음 | `apps/ui`에 verification 전용 토글 · 정렬 없음 — 본문은 Markdown | 예 → M10-14 |

### 8.2 블록별 집계 (3.2)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| VF-09 · 블록 이름 · 순서 (블록 그래프, 최악 상태 우선) | 파서: | 다름 | `verification.ts` ← `checks/summary.ts:computeBlockSummaries`는 규칙의 `block` 값으로만 묶는다 (블록 그래프를 읽지 않는다 — 5절 "블록 그래프 없음" 경로가 기본) | 예 → M10-13 |
| VF-10 · 블록의 규칙 수 · 승인 수 | 저장소: | 있음 | `verification.ts:blockSection` (`block.rules`, `block.approved`) | 아니오 |
| VF-11 · 블록의 상태 집계 | 실행: | 있음 | `verification.ts:blockSection` (`countsText(block.byStatus)`) | 아니오 |
| VF-12 · "블록 공통" 절 — 필수 검사 (1)(2)(3) | 실행: + git: + 저장소: | 다름 | `verification.ts:commonSection` ← `checks/common.ts:computeCommonRows` — (3)은 항상 `unchecked` "검사 없음 (M8 — git 공개 진입점 diff)" (AR-07) | 예 → M10-09 |
| VF-13 · 블록 행 오른쪽 커밋 · 시각 | 실행: | 있음 | `verification.ts:blockSection` (`block.lastCheck ?? view.lastCheck`) | 아니오 |

### 8.3 규칙별 행 (3.3)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| VF-14 · 규칙 ID · 진술 요약 · 블록 | 저장소: | 있음 | `verification.ts:buildRow` (`ruleSummary` ← `checks/run-check.ts`) · `ruleTable` | 아니오 |
| VF-15 · 승인 시각 · 승인자 · 결정 기록 ID | 저장소: | 있음 | `verification.ts:buildRow` (`latestApprovalOf`, `decisionsForRule`) · `reasonCell` 메타 줄 | 아니오 |
| VF-16 · 검사 종류 (인수 · 계약 · PBT · 정적 · 트레이스) + 등급 | 저장소: | 있음 | `verification.ts:ruleTable` (`CHECK_KIND_LABEL[checks[0].kind]`) · `gradeOf` (정적 = 1등급) | 아니오 |
| VF-17 · 상태 🟢 (통과 + 유효한 주입) | 실행: | 없음 | `packages/core/src/checks/status.ts` 판정 7단계에 `pass-verified`가 없다 (통과는 전부 `pass-unverified/no-injection`). `injections/` 기록(`store/injections.ts`)은 쌓인다 — #105 범위 | 아니오 (#105 범위) |
| VF-18 · 상태 🟡 (통과 · 유효성 미확인) | 실행: | 있음 | `checks/status.ts` 7번 (`pass-unverified`, `no-injection`) | 아니오 |
| VF-19 · 상태 🟠 (검사 파일 바뀜 · 해석 불일치 보류) | git: / 저장소: | 없음 | `checks/status.ts`에 `recheck` 판정 없음 (`Validity.checkFileHashes`는 기록만). 검토 대기열 `interpretation` 항목과의 연결도 없다 — 해시 변경 → 🟠은 #105, 대기열 보류는 M10 | 예 → M10-17 |
| VF-20 · 상태 🔴 (검사 실패) | 실행: | 있음 | `checks/status.ts` 6번 (`fail` + `failures[]`) | 아니오 |
| VF-21 · 상태 ⬜ (검사 없음 · 미승인 · 격리) | 저장소: + 실행: | 있음 | `checks/status.ts` 1~5번 (`no-checks` · `check-missing` · `unapproved` · `quarantined` · `not-run`) · `describeStatusDetail` | 아니오 |
| VF-22 · 상태 계산 우선순위 (⬜ → 🔴 → 🟠 → 🟢 → 🟡) | 실행: | 다름 | `checks/status.ts` 머리 주석의 순서 — 🟠 · 🟢 단계가 없다 (#105) | 아니오 (#105 범위) |
| VF-23 · 유효성 (유효 ✔ · 무효 ✘ · 미확인) + 주입 설명 · 커밋 · 시각 | 실행: | 다름 | `verification.ts:reasonCell`은 `row.validity`를 그리지만 `buildRow`가 `validity`를 채우지 않는다 (`injections/`를 읽지 않음) → 항상 "유효성 미확인 (주입 기록 없음)" | 예 → M10-18 |
| VF-24 · 무효 → 차이 탐색 링크 (run) | 실행: + 저장소: | 없음 | `Validity.diffSearch` 타입(`packages/core/src/types/rules.ts`)과 러너(`checks/diff-search.ts`)는 있으나 `verification.ts`가 그리지 않는다 | 예 → M10-18 |
| VF-25 · 실패 위치 `file:line` + 메시지 | 실행: | 있음 | `verification.ts:whereCell` (`anchorLink`) · `reasonCell` (메시지 첫 줄) ← `checks/junit.ts` | 아니오 |
| VF-26 · PBT 반례 · 시드 | 실행: | 있음 | `verification.ts:reasonCell` ("fast-check 반례 · 시드") ← `CheckFailure.counterexample` · `seed` | 아니오 |
| VF-27 · 결과 커밋 · 시각 · 소요 | 실행: | 다름 | `verification.ts:buildRow` `lastResult { commit, finishedAt, durationSec }`는 JSON에 있으나 `ruleTable`이 소요(초)를 그리지 않는다. 커밋 · 시각은 블록 머리에만 | 예 → M10-12 |
| VF-28 · 이력 (최근 n회 상태) | 실행: | 다름 | `RuleRow.history`는 JSON에 채우지만(`buildRow`) `renderVerificationView`가 그리지 않는다. `/rules/[id]`(`page.tsx`)와 CLI `rule show`는 그린다 | 예 → M10-12 |
| VF-29 · ⚠ 체류 일수 (잠정 행) | 저장소: | 있음 | `verification.ts:reasonCell` (`pendingSince` → "⚠ n일 체류") | 아니오 |
| VF-30 · `[IDE에서 열기]` | 사용자 입력: | 있음 | `verification.ts:whereCell` `anchorLink` → `ViewBody.tsx` | 아니오 |

### 8.4 검사 범위 밖 (3.4, 생략 불가)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| VF-31 · 규칙 0개 블록 | 파서: − 저장소: | 다름 | `verification.ts` — `config.blocks` 키 − 규칙 `block` (블록 그래프가 아니라 설정 키). CLI `check`는 그래프가 있으면 그래프(`checks/out-of-scope.ts:computeOutOfScope`) | 예 → M10-13 |
| VF-32 · 요구사항에 없는 코드 | 파서: − 저장소: | 없음 | `checks/out-of-scope.ts` `codeWithoutRules: []` 고정 (규칙 `scope` 미도입 — 6절 3번) · `verification.ts` 같은 값 "없음 (규칙 scope 미도입)" | 예 → M10-19 |
| VF-33 · 코드에 없는 요구사항 (매칭 0 / 검사 파일 없음) | 저장소: + 파서: | 다름 | `verification.ts` (`check-missing` 행만). `scope` 글롭 매칭 0(`no-match`)은 `scope` 미도입이라 나오지 않는다 | 예 → M10-19 |
| VF-34 · 테스트가 안 지나간 흐름 (n / 진입점 m) | 파서: + 실행: | 없음 | `verification.ts` `untestedFlows: { unavailable: 'no-trace' }` 고정 — 흐름도 View JSON의 `uncovered`를 읽지 않는다 (F-03) | 예 → M10-13 |
| VF-35 · 미분류 파일 수 ▲ | 파서: | 없음 | `verification.ts` `unclassifiedFiles: { unavailable: 'no-graph' }` 고정 ("측정 불가"). CLI `check`는 그래프가 있으면 센다 | 예 → M10-13 |
| VF-36 · 불안정으로 격리된 검사 (3회 중 통과 수) | 실행: | 없음 | `checks/run-check.ts` `quarantined: []` 고정 ("3회 실행 격리는 M10 `--stability`") | 예 → M10-20 |
| VF-37 · 절 오른쪽 커밋 · 시각 | 실행: | 있음 | `verification.ts:outOfScopeSection` (`commitTime(view.lastCheck)`) | 아니오 |

## 9. View — 외부 의존성 (view-dependencies 3절)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| DP-01 · 직접 패키지 (이름 · 버전 · prod/dev) | 파서: | 있음 | `packages/core/src/views/lockfile.ts:parsePnpmLock` (`importers`, 모노레포 `importerKey`) · `dependencies.ts:renderPackages`. npm · yarn은 `unsupported` 표시만 (M10) | 예 → M10-27 |
| DP-02 · 간접 패키지 (수 · 트리 펼치기) | 파서: | 다름 | `lockfile.ts:reachableFrom` (수) — `renderPackages`는 "간접 의존 n개" 한 줄만, 트리 펼치기 없음 | 예 → M10-21 |
| DP-03 · 패키지를 import하는 블록 | 파서: | 있음 | `packages/adapter-nextjs/src/extract-dependencies.ts` `externals` → `dependencies.ts:blocksCell` (분석 없으면 "분석 없음") | 아니오 |
| DP-04 · import 없는 직접 패키지 ▲ | 파서: | 있음 | `dependencies.ts:packageEntries` (`unused`, 분석 없으면 `null` → "▲ ?"). "(설정 파일만)" 구분은 없다 | 아니오 |
| DP-05 · 패키지 `file:line` (lockfile · import 문) | 파서: | 다름 | lockfile 줄은 있다(`lockfile.ts:lineOf` → `anchorLink(p.lockfile)`). import 문 줄은 `importSites: []` 고정 (`dependencies.ts:packageEntries`) | 예 → M10-21 |
| DP-06 · 외부 서비스 (종류 · 이름 · 근거) | 파서: | 다름 | `dependencies.ts:serviceEntries` (그래프 L0 노드 + compose 줄 보조 `composeServiceLine`). `.env.example` 이름 스캔 없음 (AR-14) | 예 → M10-10 |
| DP-07 · 서비스의 클라이언트 패키지 · 쓰는 블록 | 파서: | 있음 | `dependencies.ts:serviceEntries` (`infraEdges` → `clientPackages`, `usedBy`) · 매핑표는 `extract-dependencies.ts` | 아니오 |
| DP-08 · 의존성 이벤트 (커밋 · 시각 · 추가/제거/버전 변경) | git: | 있음 | `dependencies.ts:collectEvents` (`git log --since` + `git show` 전후, `diffDirect`, `transitiveDelta`) | 아니오 |
| DP-09 · 이벤트의 결정 기록 유무 (D-xxxx / 사유 없음 ⚠) | 저장소: | 있음 | `dependencies.ts:decisionFor` (`links.packages` · `links.commits` 명시 연결만 — 문자열 일치 없음) | 아니오 |
| DP-10 · 제약 규칙과의 연결 (규칙 ID + 상태) | 저장소: + 실행: | 있음 | `dependencies.ts:rulesForPackage` · `rulesForService` (`Rule.constraint.targets`) | 아니오 |
| DP-11 · 요약 띠 | 파서: + git: + 저장소: | 있음 | `dependencies.ts:summaryLine` | 아니오 |
| DP-12 · 생성 커밋 · 시각 · 파서 버전 | 파서: | 있음 | `dependencies.ts` 머리말 `sources` (`pnpm-lock 9.0` · depcruise 버전) → `sourceBar`. 생성 커밋 · 시각은 UI 하단(V-12 · V-13) | 아니오 |
| DP-13 · 블록 필터 | 사용자 입력: | 없음 | 해당 파일 없음 (V-03 · V-04) | 예 → M10-02 |
| DP-14 · `[IDE에서 열기]` | 사용자 입력: | 있음 | `dependencies.ts` `anchorLink` (lockfile 행 · 서비스 근거) → `ViewBody.tsx` | 아니오 |

## 10. View — 데이터 모델 / 계약 (view-data-contract 3절)

|와이어프레임 항목 | 출처 접두어 | 구현 상태 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| CT-01 · 계약 파일 목록 + 현재 해시 | 파서: | 있음 | `packages/adapter-nextjs/src/read-schemas.ts` (`SchemaFile.hash`) → `packages/core/src/views/contract.ts:toContractFile` · `renderFiles` | 아니오 |
| CT-02 · 승인된 해시 · 승인 ID · 시각 | 저장소: | 다름 | `packages/core/src/store/contracts.ts` (`contracts/<파일>.json`) · `contract.ts:toContractFile` — 저장소 API만 있고 쓰는 입구(CLI · UI)가 없다 (`cli/commands/`에 contracts 없음) | 예 → M10-22 |
| CT-03 · 계약 상태 (일치 🟢 / 변경 🔴 / 미승인 ⚠) | 파서: + 저장소: | 있음 | `contract.ts:toContractFile` (`match` · `changed` · `unapproved` · `missing`) · `FILE_STATUS_LABEL` | 아니오 |
| CT-04 · 코드 일치 🟢 / 불일치 🔴 / 미검사 ⬜ + 통과 수 | 실행: | 있음 | `contract.ts:codeConformanceOf` (`check.kind === 'contract'`) · `renderConformance` (§5.4 안내 포함) | 아니오 |
| CT-05 · "파이프라인 대기" 표시 | 저장소: | 없음 | `contract.ts`가 `runs/*.json`을 읽지 않는다 — `renderConformance`는 §5.4 안내 문장만 | 예 → M10-22 |
| CT-06 · 모델 · 필드 · 속성 | 파서: | 있음 | `read-schemas.ts` (Prisma DMMF) → `contract.ts:renderDb` 필드 표 | 아니오 |
| CT-07 · 관계 (카디널리티 · onDelete) | 파서: | 있음 | `contract.ts:relationFieldLabel` · `renderErDiagram` | 아니오 |
| CT-08 · enum | 파서: | 있음 | `contract.ts:renderDb` "enum" 표 | 아니오 |
| CT-09 · 모델 `file:line` | 파서: | 있음 | `read-schemas.ts` (`model.anchor`) → `contract.ts:renderDb` 머리 `anchorLink` | 아니오 |
| CT-10 · 엔드포인트 (경로 · 메서드 · operationId) | 파서: | 있음 | `read-schemas.ts` (OpenAPI `paths`) → `contract.ts:renderApi` | 아니오 |
| CT-11 · 요청 · 응답 스키마 (이름 · 필드 · 제약) | 파서: | 다름 | `contract.ts:renderApi`는 스키마 **이름**과 응답 코드만(`responsesCell`). 필드 · required · format 전개는 JSON(`SchemaRef.properties`)에 있고 Markdown에 없다 | 예 → M10-23 |
| CT-12 · 엔드포인트 소속 블록 (tags vs 핸들러, 🟠 불일치) | 파서: | 있음 | `contract.ts:resolveOperation` · `blockCell` (`mismatch` → 🟠 둘 다 표시) | 아니오 |
| CT-13 · 핸들러 파일 + 공개 진입점 사용 🟢 / 🔴 | 파서: | 있음 | `contract.ts:handlerBlocks` · `handlerCell` (`viaPublic`) | 아니오 |
| CT-14 · 엔드포인트 `file:line` | 파서: | 있음 | `read-schemas.ts` (YAML 위치 → `op.anchor`) → `contract.ts:renderApi` `anchorLink` | 아니오 |
| CT-15 · 스키마 ↔ 모델 필드 차이 ⚠ | 파서: | 있음 | `contract.ts:schemaModelDiff` · `renderApi` "스키마 ↔ 모델 필드 차이" 절 | 아니오 |
| CT-16 · 이벤트 (채널 · 메시지 스키마) | 파서: | 있음 | `read-schemas.ts` (AsyncAPI) → `contract.ts:renderEvents` ("이벤트 계약 없음" 기본) | 아니오 |
| CT-17 · 계약 변경 diff (파일 · +/− · 줄) | git: | 있음 | `contract.ts:gitDiff` · `parseHunks` · `renderDiff` | 아니오 |
| CT-18 · diff ↔ 승인 ID 연결 | 저장소: | 있음 | `contract.ts:generateContractView` (`entry.decision = approved.decision`) · `renderDiff` "승인 D-…" | 아니오 |
| CT-19 · 생성 커밋 · 시각 · 파서 버전 | 파서: | 있음 | `contract.ts:parserSource` (`prisma x.y.z` · `openapi 3.1`) → `sourceBar`. 생성 커밋 · 시각은 UI 하단(V-12 · V-13) | 아니오 |
| CT-20 · 블록 필터 | 사용자 입력: | 없음 | 해당 파일 없음 (V-03 · V-04). `renderDb`는 "스키마는 블록 필터 대상이 아니다" 문구만 | 예 → M10-02 |
| CT-21 · `[IDE에서 열기]` | 사용자 입력: | 있음 | `contract.ts` `anchorLink` (모델 · 엔드포인트 · 핸들러 · diff 헝크 · 파싱 오류) → `ViewBody.tsx` | 아니오 |

## 11. paper-walkthrough 5절 "와이어프레임에 없어서 추가해야 할 항목"의 현재 상태

상태 열: **해결** = 코드에 들어갔다 · **미해결** = 아직 없다 · **결정 필요** = 어디에 어떻게 둘지 정해야 한다.

|항목 | 화면 | 구현 상태 | 근거(파일:함수/컴포넌트) | 상태 · M10 후보 |
|---|---|---|---|---|
| PW-01 · 이 실행이 바꾼 파일 목록 (git: worktree `diff --stat`) | work-run 3.3 | 없음 | `RunState`(`packages/core/src/types/run.ts`)에 `changedFiles` 없음 · `apps/ui/components/runs/run-detail.tsx`에 자리 없음 (`worktree` 경로만 있다) | 미해결 → M10-24 |
| PW-02 · 테스트 입력 샘플 (PBT 경계 입력) | view-verification 3.3 | 없음 | `RuleRow`(`packages/core/src/types/views.ts`)에 `inputSamples` 없음 · `verification.ts`가 그리지 않는다 | 미해결 → M10-18 |
| PW-03 · 주입 위치 `file:line` (`Validity.anchor`) | view-verification 3.3 | 다름 | 타입 `Validity.anchor` 있음(`types/rules.ts`) · `run/inject.ts`가 기록한다. `verification.ts`가 `validity`를 안 채워 화면엔 없다 (VF-23) | 미해결 → M10-18 |
| PW-04 · ⬜ "검사 파일 없음"과 "검사 없음" 구분 | work-approve 3.2 · view-verification 3.3 | 있음 | `checks/status.ts` 2 · 3번 (`no-checks` / `check-missing`) · `apps/ui/lib/rules.ts:uncheckedDetail` · `describeStatusDetail` | 해결 |
| PW-05 · `rule-changed` 이벤트의 "사유 없음" 기준 | view-changelog 3절 | 있음 | `changelog/link.ts:linkDecisions` — `Rule.decision` 없고 명시 연결 없으면 `no-record` (`detect.ts` `rule-changed`) | 해결 |
| PW-06 · 집계 `{ total: 0 }`일 때 "JUnit 결과 없음" 문구 | work-run 4절 | 다름 | `stage-track.tsx:stageResultText`는 `0/0 실패`로 그린다 — 문구 없음. `verification.ts:renderVerificationView`와 CLI `check.ts`에는 "JUnit 결과 없음 — 리포터 설정 확인"이 있다 | 미해결 → M10-24 |

## 12. 열린 질문의 현재 상태 (각 문서 6절)

열: **상태** = 해결 / 미해결 / 결정 필요. **코드 반영** = 그 답이 코드에 있음 / 다름(부분 또는 다른 답) / 없음.

### 12.1 work-approve 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-A1 · 제안 기록의 저장 형식 | 해결 | 있음 | `proposals/<rule>/<p-id>.json` (`packages/core/src/store/proposals.ts`, `types/rules.ts` `Proposal`) — `rules.yaml`과 분리 | 아니오 |
| Q-A2 · 승인 단위 (규칙 하나 vs 결정 묶음) | 결정 필요 | 다름 | `POST /api/rules/:id/approve` 규칙 단위만. 사전 승인은 코어가 거부(`applied: false`) — 결정 단위 승인(`POST /api/decisions/:id/approve`)은 없다 (D-03) | 예 → M10-03 |
| Q-A3 · 블록의 고위험 선언 위치 | 해결 | 있음 | `plumb.config.json` `blocks.<id>.risk` (`apps/ui/lib/rules.ts:isHighRiskRule` · CLI `shared.ts:isHighRiskRule`) | 아니오 |
| Q-A4 · 결정 기록 없는 규칙의 승인 허용 | 해결 (첫 슬라이스 허용) | 있음 | `apps/ui/lib/rules-api.ts:handleApprove`가 결정 유무를 보지 않는다. "결정 없는 완화 · 삭제 불가"는 M10 | 예 → M10-03 |
| Q-A5 · 목록의 기본 필터 (전체 vs 잠정만) | 해결 (전체, 기각 제외) | 있음 | `apps/ui/lib/rules.ts:applyRuleListFilter` | 아니오 |
| Q-A6 · README 3.3 보완 (409 · 기각 사유 필수) | 해결 | 있음 | `packages/core/src/types/api.ts` `proposal-changed` 409 · `reason-required` 400 · README 3.3 표에 반영 | 아니오 |

### 12.2 work-run 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-R1 · 동시 실행 수 | 해결 (1개) | 있음 | `packages/core/src/run/pipeline.ts:checkPreconditions` `run-in-progress` · `new-run-panel.tsx` `activeRunId`. 재검토는 M10 | 예 → M10-08 |
| Q-R2 · 중단 API | 해결 | 있음 | `POST /api/runs/:id/abort` (`apps/ui/app/api/runs/[id]/abort/route.ts`, pid SIGTERM) · CLI `plumb runs abort` · README 3.3 | 아니오 |
| Q-R3 · pid 생존 여부 | 해결 (60초 경고로 대체) | 있음 | `run-detail.tsx` `STALE_MS` · `apps/ui/lib/runs.ts:abortRun` (ESRCH도 202) | 아니오 |
| Q-R4 · `RunState` 타입 (⑤→② 표현) | 해결 | 있음 | `types/run.ts` `stages[]` + `attempt` (`stage-track.tsx` "n회차") | 아니오 |
| Q-R5 · 실행 출력의 보관 (`output.log` vs 꼬리) | 해결 (상태 파일 `capturedOutput.tail`) | 다름 | `types/run.ts` `CapturedOutput` — 별도 `output.log` 없음, 전체 로그 보기는 M10 (S-17) | 예 → M10-24 |
| Q-R6 · 비용의 원자료 | 해결 (SDK 결과 메시지 누적) | 있음 | `run/pipeline.ts` `recordRole(…, costUsd)` · `role-usage.tsx` "(추정)" | 아니오 |
| Q-R7 · README 보완 (중단 · 400 조건 · 출력 꼬리) | 해결 | 있음 | README 3.3 표에 abort · 400 조건 있음 · 출력 꼬리는 `GET /api/runs/:id` 본문에 포함 (`apps/ui/app/api/runs/[id]/route.ts` 주석) | 아니오 |

### 12.3 work-views 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-V1 · 항목별 블록 태그와 `file:line`의 표현 형식 | 결정 필요 | 다름 | `file:line`은 `plumb://open` 링크(`views/markdown.ts`)로 해결. 블록 태그는 Markdown에 없다 (JSON `Anchor.block`만) — (b) JSON 정본 + Markdown 렌더를 택했으나 UI는 Markdown만 그린다 | 예 → M10-02 |
| Q-V2 · `views/<name>.md` 머리말 타입 | 해결 | 있음 | `types/views.ts` `ViewHeader { view, generatedAt, commit?, sources[] }` · `SourceRef.kind` ↔ 접두어 1:1 (`markdown.ts:SOURCE_PREFIX`) | 아니오 |
| Q-V3 · IDE 열기 실패 시 기록 | 해결 (실패도 기록, `result.status: 'failed'`) | 있음 | `apps/ui/app/api/open/route.ts` · `cli/commands/open.ts` · `store/code-opens.ts` | 아니오 |
| Q-V4 · 블록 필터의 L0 선택 | 미해결 | 없음 | 블록 트리가 없다 (C-05) | 예 → M10-02 |
| Q-V5 · README 보완 (404 · 머리말 반환) | 해결 | 있음 | `apps/ui/app/api/views/[name]/route.ts` 404 `unknown-view` / `not-generated` · `ViewResponse` (`types/api.ts`) | 아니오 |

### 12.4 view-architecture 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-AR1 · 블록 그래프 JSON 형태 (L0 · L1 한 파일) | 해결 | 있음 | `types/views.ts` `BlockGraph` · `BlockNode` · `BlockEdge` · `InfraEdge` — 한 파일, `level`로 구분 | 아니오 |
| Q-AR2 · 선언된 방향의 위치 (config vs 저장소 규칙) | 해결 (config `dependsOn`) | 있음 | `extract-dependencies.ts` (`declaredBy: 'config' | 'entry'`). 저장소 규칙(승인 통로)으로 옮기는 안은 미채택 — 결정 이슈 후보 | 예 → M10-25 |
| Q-AR3 · 필수 검사 (3)의 "시그니처" 정의 | 결정 필요 | 없음 | 비교 코드 없음 (AR-07) | 예 → M10-09 |
| Q-AR4 · 환경변수 이름 참조 스캔의 위치 | 미해결 | 없음 | `extract-dependencies.ts` 머리 "지금은 하지 않는다" | 예 → M10-10 |
| Q-AR5 · 변경 영향 범위의 기간 | 해결 (HEAD 커밋 하나) | 있음 | `architecture.ts:computeImpact` `HEAD~1..HEAD` — 추세는 M10 | 아니오 |
| Q-AR6 · `app/` 블록의 지위 | 해결 (`kind: 'entry'`) | 있음 | `extract-dependencies.ts` (3) `src/app/**` → `app` entry · `BlockEdgeDeclaredBy 'entry'` | 아니오 |

### 12.5 view-flow 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-F1 · `FlowNode` 타입 (A/B안을 `mode`로 통합) | 해결 | 있음 | `types/views.ts` `FlowNode` (`evidence` / `testRef`) · `FlowView.mode` | 아니오 |
| Q-F2 · `FlowScenario` 타입 (시나리오 · 진입점 같은 타입) | 해결 | 있음 | `types/views.ts` `FlowScenario.unit: 'scenario' | 'entry'` | 아니오 |
| Q-F3 · 검사 범위 밖 항목 타입 (`OutOfScope` 공유) | 미해결 | 다름 | `UncoveredFlow` 타입은 있으나 `verification.ts`가 흐름도 JSON을 읽지 않는다 (VF-34) | 예 → M10-13 |
| Q-F4 · 정적 호출 그래프 깊이 상한 · "내부 한 단계" 위치 | 해결 (어댑터 상수) | 있음 | `adapter-nextjs/src/call-graph.ts` `internalDepth` · `resolveValue` `depth > 8` | 아니오 |
| Q-F5 · spike 1 — Prisma · ioredis 계측이 Vitest 안에서 스팬을 내는가 | 해결 (Prisma만) | 다름 | `adapter-nextjs/src/collect-traces.ts` · `flow.ts:spanToNode` `prisma:client:operation`. ioredis 계측은 코드에 없다 | 아니오 |
| Q-F6 · spike 2 — `SimpleSpanProcessor` + 파일 exporter 시간 영향 | 미해결 | 없음 | 측정 코드 없음 — `collect-traces.ts`에 시간 측정 없음. `plumb views` 소요 시간으로만 체감 | 아니오 |
| Q-F7 · spike 3 — 워커 · `concurrent`에서 루트 스팬이 섞이지 않는가 | 해결 | 있음 | `flow.ts:spanTestId` (`test.file` · `test.name` 속성으로 묶음) · `collect-traces.ts` (워커별 `spans-<POOL_ID>-<pid>.jsonl`) | 아니오 |
| Q-F8 · 공개 진입점 감싸는 vite 플러그인과 tsc · depcruise 충돌 | 해결 | 있음 | `collect-traces.ts` — 계측은 testbed `instrumentation-test.ts`(Vitest `setupFiles`)에서만, 소스 변환 없음 | 아니오 |
| Q-F9 · 인수 테스트가 Route Handler를 거치는가 | 해결 (우회 시 표시) | 있음 | `flow.ts:buildTraceScenario` "스팬 0개 — 공개 진입점을 거치지 않는 테스트" · "테스트 직접 호출 (진입점 없음)" | 아니오 |
| Q-F10 · 함수 안 `if` 분기를 어떻게 드러낼지 | 결정 필요 | 없음 | 분기 커버리지 보조 재료 없음 — `flow.ts`는 호출 노드만 그린다 (paper-walkthrough 4절 #4) | 예 → M10-26 |
| Q-F11 · B안 정적 호출 그래프 도구 | 해결 (TS 컴파일러 API) | 있음 | `adapter-nextjs/src/call-graph.ts` | 아니오 |
| Q-F12 · 스팬 파일 형식을 어댑터 인터페이스에 | 해결 | 있음 | `packages/core/src/adapter/types.ts` `Adapter.collectTraces` · `TraceSpan` · `TraceResult` | 아니오 |

### 12.6 view-changelog 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-C1 · `ChangeEvent` 타입 (멱등 키) | 해결 | 있음 | `types/views.ts` `ChangeEvent` (`evidenceHash`) · `changelog/detect.ts:eventId` | 아니오 |
| Q-C2 · `DecisionRecord` 타입 (`links`, 이벤트 ID 역채움) | 해결 | 있음 | `types/rules.ts` `DecisionRecord.links { rules, commits, packages?, services?, events? }` · `decisions/format.ts` (events는 도구가 채운다) | 아니오 |
| Q-C3 · 이유 외 항목(기각 · 감수)이 비면 "사유 없음"인가 | 해결 (불완전 기록 따로 셈) | 있음 | `changelog.ts` `incompleteRecords` · `decisions/validate.ts` | 아니오 |
| Q-C4 · 비율 값 저장 위치 (`CheckResult` vs `metrics.jsonl`) | 결정 필요 | 다름 | `CheckRun.metrics` 자리(`types/rules.ts` · `store/checks.ts` 스키마)는 있으나 쓰는 코드가 없다 (CL-03) | 예 → M10-15 |
| Q-C5 · 감지 단위 (커밋마다 vs 범위 한 번) | 해결 (범위 한 번, base worktree) | 있음 | `changelog.ts:snapshot` · `detect.ts:withBaseWorktree` | 아니오 |
| Q-C6 · "규칙 완화 제안"의 원천 (이의 제기 파일) | 미해결 | 다름 | `detect.ts` `rule-changed`는 `approvals/` · `proposals/` 이력만. 이의 제기(`review-queue` `dispute`) → 완화 제안 연결 없음 | 예 → M10-17 |
| Q-C7 · 외부 시스템 판정 목록 공유 (의존성 View와) | 해결 | 있음 | 두 View 모두 블록 그래프 L0 노드 (`extract-dependencies.ts`) 한 곳 | 아니오 |
| Q-C8 · 사람 커밋(세션 없음)의 "사유 없음" 분리 집계 | 미해결 | 다름 | `changelog.ts:summaryLine` "수동(세션 없음) 커밋 이벤트 n" — 모든 이벤트가 `manual`이라 분리가 의미 없다 (CL-05) | 예 → M10-16 |
| Q-C9 · 상단 바 `⚠ n`에 사유 없음 이벤트 포함 여부 | 해결 (미포함) | 있음 | `store/status.ts:toStatusResponse` (`provisionalRules + reviewQueue`만) | 아니오 |

### 12.7 view-verification 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-VF1 · 규칙 ↔ 검사 매핑의 키 | 해결 (파일 경로 `checks[].ref`) | 있음 | `checks/junit-to-results.ts:checkRefsOf` · `flow.ts:buildCheckIndex` | 아니오 |
| Q-VF2 · 상태 기록의 위치 (`CheckRun` vs `rule-status`) | 해결 (둘 다, `rule-status`가 `since`를 든다) | 있음 | `store/rule-status.ts` · `store/checks.ts` (docs/types/README "상태 기록은 두 곳") | 아니오 |
| Q-VF3 · "요구사항에 없는 코드"의 단위 (`scope`) | 결정 필요 | 없음 | `checks/out-of-scope.ts` `codeWithoutRules: []` | 예 → M10-19 |
| Q-VF4 · 흐름의 정의 (분모) | 해결 (정적 그래프 진입점 · 모드별) | 다름 | `flow.ts:computeUncovered` (`total` = 정적 노드 수 / 진입점 수) — 검증 View에 연결 안 됨 (VF-34) | 예 → M10-13 |
| Q-VF5 · 3회 실행의 비용 (`--stability`) | 미해결 | 없음 | `checks/run-check.ts` "3회 실행 격리는 M10 `--stability`" | 예 → M10-20 |
| Q-VF6 · View 타입 초안 | 해결 | 있음 | `types/views.ts` `VerificationView` · `RuleRow` · `OutOfScope` | 아니오 |

### 12.8 view-dependencies 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-D1 · 규칙 ↔ 의존성 연결 필드 | 해결 (`constraint.targets[]`) | 있음 | `types/rules.ts` `Rule.constraint` · `dependencies.ts:rulesForPackage` | 아니오 |
| Q-D2 · 결정 기록 ↔ 패키지 연결 (`refs`) | 해결 (`links.packages` · `links.services`) | 있음 | `decisions/format.ts` front matter · `dependencies.ts:decisionFor` | 아니오 |
| Q-D3 · 패키지 → 서비스 매핑표의 위치 | 해결 (어댑터 내장) | 다름 | `extract-dependencies.ts` 매핑표 (`'@prisma/client': 'db'` …). config 재정의(`services[].clientPackages`)는 없다 | 예 → M10-10 |
| Q-D4 · `test/`를 블록으로 볼지 | 미해결 | 다름 | `types/views.ts` `BlockKind 'test'`와 `architecture.ts:blockKindLabel` "테스트"는 있으나 `extract-dependencies.ts`가 `test` 블록을 만들지 않는다 (파일 → 블록 규칙 (1)~(5)에 없음) | 예 → M10-25 |
| Q-D5 · View 타입 초안 | 해결 | 있음 | `types/views.ts` `DependenciesView` · `PackageEntry` · `ServiceEntry` · `DependencyEvent` | 아니오 |

### 12.9 view-data-contract 6절

|질문 | 상태 | 코드 반영 | 근거(파일:함수/컴포넌트) | M10 후보 |
|---|---|---|---|---|
| Q-CT1 · 계약 해시 기록의 위치와 형태 | 해결 (`contracts/<파일>.json`) | 다름 | `store/contracts.ts` 있음 · 쓰는 입구 없음 (CT-02) | 예 → M10-22 |
| Q-CT2 · 모델의 블록 소속 | 해결 ((b) config 매핑 + `repo.ts` 단일 블록) | 있음 | `contract.ts:generateContractView` (`config.contracts.models` · `blocksWithRepo`). (c) AST 스캔은 미채택 | 아니오 |
| Q-CT3 · 엔드포인트 소속의 두 출처가 다를 때 | 해결 (둘 다 보이고 🟠) | 있음 | `contract.ts:resolveOperation` · `blockCell` | 아니오 |
| Q-CT4 · 계약 테스트의 식별 | 해결 (`checks[].kind === 'contract'`) | 있음 | `contract.ts:codeConformanceOf` · `checks/run-check.ts` `CHECK_KIND_LABEL.contract` | 아니오 |
| Q-CT5 · 엔드포인트 ↔ 모델 연결 | 해결 (그리지 않음) | 있음 | `contract.ts` 머리 주석 "6절 5번 — 그리지 않는다" | 아니오 |
| Q-CT6 · View 타입 초안 | 해결 | 있음 | `types/views.ts` `ContractView` · `ContractFile` · `Operation` | 아니오 |

## 13. M10 이슈 후보

제목 한 줄과 근거 행 번호. 이슈 등록은 M9가 끝난 뒤(ROADMAP "이슈 등록 시점"). 결정이 먼저 필요한 것은 "결정 이슈"로 표시했다.

1. **M10-01** 보호 저장소 해시 체인 검증 — "변조 증거" 판정을 승인 기록 체인으로 (C-02 · VF-03)
2. **M10-02** 블록 트리 + `GET /api/blocks` + 블록 필터의 본문 적용 (항목별 블록 태그를 Markdown 또는 JSON 렌더에) (C-05 · C-06 · C-07 · A-12 · V-03 · V-04 · AR-17 · DP-13 · CT-20 · Q-V1 · Q-V4)
3. **M10-03** 결정 단위 승인 (`POST /api/decisions/:id/approve`) · 고위험 완화 · 삭제 · 경계 변경의 사전 승인 처리 · "결정 없는 완화 · 삭제 승인 불가" (D-03 · Q-A2 · Q-A4)
4. **M10-04** `/rules` 상세의 링크 — 검사 파일 `[IDE ↗]`(이유 대화창 재사용) · 제안자 run → `/runs?id=` (D-08 · D-11)
5. **M10-05** 결정 기록 네 항목 표시 — `/rules` 상세와 변경 로그 View에 `DecisionRecord` 전문 (`parseDecision`은 있다) (D-09 · CL-16)
6. **M10-06** 대기열 상한 초과 시 신규 제안 중단 — `POST /api/runs` 400 · 띠 문구 (A-11)
7. **M10-07** 검토 대기열 화면 — 이의 제기 판정 · 해석 불일치 · 설계 변경 승인 묶음 + `/rules` 머리의 비활성 탭 자리 (D-16 · S-16)
8. **M10-08** 여러 규칙 동시 선택 · 동시 실행 · 규칙별 worktree (N-03 · Q-R1)
9. **M10-09** 필수 검사 (3) 공개 계약 시그니처 비교 — 결정 이슈(`tsc --declaration` 텍스트 diff vs 구조 비교) 뒤 구현 (AR-07 · VF-12 · Q-AR3)
10. **M10-10** `.env.example` 변수 이름 · `process.env.<이름>` 참조 스캔 → L0 외부 API 노드 · 간선 · 쓰는 블록, 패키지 → 서비스 매핑표의 config 재정의 (AR-14 · AR-15 · DP-06 · Q-AR4 · Q-D3)
11. **M10-11** 아키텍처 View 선택 패널 — 간선 import 목록 · 노드 파일 목록 · L0 근거 `file:line` · L0/L1 토글 (AR-16 · AR-02)
12. **M10-12** View Markdown에 JSON에만 있는 값 그리기 — 흐름도 `lastCheck` · 검증 행 이력 · 소요 시간 (F-01 · VF-27 · VF-28)
13. **M10-13** 검증 View "검사 범위 밖"을 블록 그래프 · 흐름도 JSON과 연결 — 규칙 0개 블록 · 미분류 파일 · 테스트가 안 지나간 흐름 · 블록 순서 (VF-09 · VF-31 · VF-34 · VF-35 · F-03 · Q-F3 · Q-VF4)
14. **M10-14** View 화면의 상호작용 — 흐름도 시나리오 선택 `?scenario=` · 좌측 블록 묶음 · 변경 로그 필터 · 검증 상태 토글 · 정렬 (F-19 · F-20 · CL-21 · VF-08)
15. **M10-15** 변경 로그 지표 영속화 — `plumb check`가 `CheckRun.metrics`를 쓰고 `changelog/events.jsonl`에 이벤트를 쌓아 추이를 그린다 (CL-02 · CL-03 · Q-C4)
16. **M10-16** 커밋 ↔ 실행(세션) 역매핑 — `runs/*.json` 커밋 범위로 `s-nnn` 채움 · `/runs` 링크 · 수동 커밋 분리 집계 (CL-05 · CL-20 · Q-C8)
17. **M10-17** 🟠 보류 — 검토 대기열 `interpretation` 항목 ↔ 규칙 상태 연결, 이의 제기 → 규칙 완화 제안 감지 (VF-19 · Q-C6)
18. **M10-18** 검증 View 유효성 열 — `injections/` 읽어 `RuleRow.validity` 채움 · 주입 위치 `Validity.anchor` · 차이 탐색 run 링크 · PBT 입력 샘플 (#105 🟢 판정 뒤) (VF-23 · VF-24 · PW-02 · PW-03)
19. **M10-19** 규칙 `scope` 도입 — "요구사항에 없는 코드" · "코드에 없는 요구사항(매칭 0)" 계산 (VF-32 · VF-33 · Q-VF3)
20. **M10-20** `plumb check --stability 3` — 불안정 격리 판정과 격리 해제(사용자 입력) (VF-36 · Q-VF5)
21. **M10-21** 의존성 View 보강 — import 문 `file:line`(`importSites`) · 간접 트리 펼치기 · 패키지 상세(도입 커밋 · 결정) · `&since=` (DP-02 · DP-05)
22. **M10-22** 계약 승인 입구 — `plumb contract approve` 또는 `POST /api/contracts/:path/approve` · "파이프라인 대기" 표시(`runs/*.json` 연결) (CT-02 · CT-05 · Q-CT1)
23. **M10-23** 계약 View 요청 · 응답 스키마 필드 전개 (`properties` · `required` · `format` · `minimum`) (CT-11)
24. **M10-24** 실행 상세 보강 — 이 실행이 바꾼 파일 목록(git: worktree `diff --stat`) · 집계 0/0일 때 "JUnit 결과 없음" 문구 · 전체 로그 보기(`runs/<id>/run.log`) (PW-01 · PW-06 · Q-R5 · S-17)
25. **M10-25** 결정 이슈 — 선언된 방향의 위치(config `dependsOn` vs 저장소 규칙) · `test/` 블록 지위 (Q-AR2 · Q-D4)
26. **M10-26** 결정 이슈 / spike — 함수 안 분기를 드러내는 방법 (Vitest 분기 커버리지 보조 재료) (Q-F10)
27. **M10-27** npm · yarn lockfile 파서 (`unsupported` 표시만인 것을 읽기로) (DP-01)
