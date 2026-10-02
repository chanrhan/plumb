# View — 테스트/검증 상태 (`/views?view=verification`)

이슈 #3의 산출물. `docs/screens/README.md`의 공통 레이아웃, 출처 표기 규칙 2.1, 코드 열람 점프 2.2를 전제로 한다. 출처 접두어 사용 기준과 가정하는 testbed는 `view-architecture.md` 머리에 있다. 기획안 §6.3의 화면을 그대로 항목화한다. 와이어프레임 안의 값은 `plumb check` 결과가 그 입력에서 나오는 모양의 예시다.

상태는 다섯 가지뿐이고 근거는 인수 테스트 실행 결과뿐이다 (기획안 §7.3). LLM 판정은 언제나 ⬜다. 모든 행에 마지막 실행 커밋·시각이 붙는다.

## 1. 답하는 질문

"믿어도 되나" (README 1 표). 구체적으로:

- 승인된 규칙 중 몇 개가 검사로 확인됐고, 그 검사는 **실제로 위반을 잡는가**(위반 주입 유효성)
- 실패한 규칙은 어디서 실패했나 (`file:line`)
- 지금 보는 결과는 어느 커밋·언제의 것인가. 보호 저장소는 변조되지 않았나
- **무엇이 검사 범위 밖인가.** "15/15 통과"의 15가 무엇의 15인지 — 규칙이 없는 블록, 규칙이 가리키지 않는 코드, 코드가 없는 규칙, 테스트가 안 지나간 흐름, 미분류 파일, 불안정으로 격리된 검사

## 2. 와이어프레임

```
┌ View 보기 ─ 아키텍처 · 흐름도 · 변경 로그 · [검증] · 의존성 · 계약 ──────────────────────────────┐
│ 필터: 전체 ▾    상태: 🟢 🟡 🟠 🔴 ⬜ (전부 켜짐)    정렬: 상태 ▾                                   │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 미확인 항목 6건 · 최장 3일 (auth.cookie-transport)      보호 저장소 정상 · 마지막 검사 2분 전 (a1b2c3) │
│ 규칙 12 · 승인 9 · 🟢 5 🟡 2 🟠 1 🔴 2 ⬜ 2 · 검사 15 (JUnit 13 · 정적 2) · 격리 1                   │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ auth — 규칙 8 · 승인 6 · 🟢 4 🟡 1 🔴 1 ⬜ 2                                        a1b2c3 · 2분 전 │
│   🟢 refresh 회전                   계약 테스트  유효 ✔ (주입 f1e2d3 · 3일 전)                        │
│   🟡 쿠키로 토큰 전달               인수 테스트  유효성 미확인 (주입 기록 없음)          ⚠ 3일 체류       │
│   🔴 세션 저장소 = redis            인수 테스트  test/acceptance/auth.session-store.spec.ts:42 [IDE에서 열기] │
│        AssertionError: expected MapStore to be RedisStore                                      │
│        주입 f1e2d3: 저장소를 Map으로 교체 → 검사 통과 ✘ 무효 → 차이 탐색 (run r-0012)                 │
│   🟢 로그인 실패 5회 잠금           PBT         유효 ✔                                              │
│   🟢 로그아웃 시 토큰 폐기          인수 테스트  유효 ✔                                              │
│   🟢 비밀번호 해시 = argon2         정적 분석    유효 ✔ (의존성 검사)                                 │
│   ⬜ 로그아웃 시 세션 무효화         검사 없음                                           승인 1일 전   │
│   ⬜ 동시 로그인 제한               미승인                                                           │
│                                                                                              │
│ payment — 규칙 4 · 승인 3 · 🟢 1 🟡 1 🟠 1 🔴 1                                      a1b2c3 · 2분 전 │
│   🟠 환불 7일 이내 (pay.refund-window)  인수 테스트  검사 파일 바뀜 (git a1b2c3: refund-window.spec.ts) → 유효성 무효 · 재주입 대기 │
│   🔴 환불 금액 ≤ 결제 금액           PBT         test/acceptance/pay.refund-amount.spec.ts:17 [IDE에서 열기] │
│        fast-check 반례: { amount: 1000, refund: 1001 } · 시드 1699…                             │
│   🟡 결제 상태 전이                  인수 테스트  유효성 미확인                                       │
│   🟢 외부 PG 호출은 payment 블록만   정적 분석    유효 ✔                                              │
│                                                                                              │
│ 블록 공통 (필수 검사, 기획안 §12) — 🔴 1 🟢 2                                         a1b2c3 · 2분 전 │
│   🟢 (1) 공개 계약으로만 접근        정적 분석    —                                                  │
│   🔴 (2) 선언된 방향만 · 순환 금지    정적 분석    src/domains/auth/refresh.ts:2 [IDE에서 열기] → 아키텍처 View │
│   🟢 (3) 공개 계약 시그니처 변경 = 설계 변경 이벤트  정적 분석  이벤트 1 · 사유 기록됨 (D-0007)              │
│                                                                                              │
│ ━━ 검사 범위 밖 ━━                                                                   a1b2c3 · 2분 전 │
│   규칙 0개 블록:          notification, admin                                                     │
│   요구사항에 없는 코드:    src/export/ (파일 2) · src/domains/payment/report.ts                      │
│   코드에 없는 요구사항:    AUTH-09 (scope 글롭 매칭 0) · PAY-03 (검사 파일 없음)                       │
│   테스트가 안 지나간 흐름: 7개 / 진입점 11 (OTel 트레이스 기준)                                       │
│   미분류 파일:            12개 ▲                                                                 │
│   불안정으로 격리된 검사:  1 — test/acceptance/auth.refresh-race.spec.ts (3회 중 2회 통과)            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

출처: `실행: plumb check 결과` (JUnit XML 파싱 + dependency-cruiser → 상태 · 실패 위치 · 커밋·시각 · 격리) · `실행: 위반 주입 기록` (유효성) · `저장소: 규칙·승인 기록` (규칙 수 · 승인 수 · 진술 · 검사 종류 · 체류) · `파서: 블록 그래프 JSON` (블록 목록 · 미분류) · `git: 검사 파일 변경` (🟠). 항목별 상세는 3절.

규칙 행 하나를 펼친 모양 (모든 행이 같은 구조):

```
🔴 세션 저장소 = redis   auth.session-store   승인 2026-09-20 (km) · 결정 D-0004
   진술      WHEN 세션을 저장할 때, 시스템은 redis 저장소를 사용해야 한다          (저장소: 규칙 YAML)
   검사      인수 테스트 · test/acceptance/auth.session-store.spec.ts            (저장소: 규칙 checks[])
   결과      실패 · a1b2c3 · 2026-10-02 01:37 · 1.2s                              (실행: JUnit XML)
             test/acceptance/auth.session-store.spec.ts:42  [IDE에서 열기]
             AssertionError: expected MapStore to be RedisStore
   유효성    무효 ✘ · 주입 f1e2d3 (3일 전): 저장소를 Map으로 교체 → 검사 통과       (실행: 위반 주입 기록)
             → 차이 탐색 run r-0012 (fast-check 입력 200개 · 출력 차이 0)   → 실행 화면
   이력      🟢 → 🔴 (a1b2c3) · 최근 5회: 🟢 🟢 🟢 🟢 🔴                            (실행: plumb check 이력)
```

## 3. 항목 표

### 3.1 상단 요약

| 항목 | 출처 | 생성 방식 (어느 파서의 어느 필드) | 도입 마일스톤 | 비고 |
|---|---|---|---|---|
| 미확인 항목 n건 | 저장소: 규칙 상태 + 검토 대기열 | 상태가 잠정(🟡 유효성 미확인, 🟠 재확인 필요)인 규칙 수 + `review-queue/*.json` 미처리 수 | M5 (상태) · M6 (대기열) | README 2 상단 바 `⚠ n`과 같은 값 |
| 최장 체류 (일수 · 규칙 ID) | 저장소: 규칙 상태 기록 | 잠정 상태가 된 시각(`statusSince`)과 지금의 차 중 최대 | M5 | 기획안 §6.3 "최장 3일" |
| 보호 저장소 상태 (정상 / 변조 증거) | 실행: plumb check 해시 체인 검증 | M3는 "정상" 고정, 해시 체인은 M10 (README 2 표와 같음) | M3 · M10 | 변조 증거면 이 View 전체 위에 🔴 띠 |
| 마지막 검사 커밋 · 시각 | 실행: plumb check 결과 헤더 | `checks/<runId>.json` `{ commit, finishedAt }` | M5 wave 1 | 모든 블록·행 오른쪽에도 반복 (기획안 §7.3 "모든 결과에") |
| 규칙 수 · 승인 수 (전체) | 저장소: 규칙 YAML + 승인 기록 | `rules/*.yaml` 수 · `approvals/*.json` 중 상태 `approved` | M3 | |
| 상태 집계 🟢🟡🟠🔴⬜ (전체) | 실행: plumb check 결과 → 상태 계산 | 3.3의 상태 계산을 규칙마다 적용해 센 것 | M5 wave 0 | |
| 검사 수 (JUnit n · 정적 m) · 격리 수 | 실행: plumb check 결과 | JUnit `testcase` 수 + dependency-cruiser 규칙 수 · `quarantined[]` 길이 | M5 wave 0 | "15/15의 15" |
| 상태 토글 · 정렬 | 사용자 입력: 필터 | 4절 | M8 wave 2 | |

### 3.2 블록별 집계

| 항목 | 출처 | 생성 방식 (어느 파서의 어느 필드) | 도입 마일스톤 | 비고 |
|---|---|---|---|---|
| 블록 이름 · 순서 | 파서: 블록 그래프 JSON | L1 블록 목록. 순서는 최악 상태 우선 (🔴 > 🟠 > 🟡 > 🟢 > ⬜) | M8 wave 0 | README 2 블록 트리와 같은 목록 |
| 블록의 규칙 수 · 승인 수 | 저장소: 규칙 YAML `block` 필드 + 승인 기록 | `rules/*.yaml` 중 `block == <이름>` | M3 | 블록 없는 규칙(`block` 비움)은 "블록 공통" 아래 |
| 블록의 상태 집계 | 실행: plumb check 결과 → 상태 계산 | 그 블록 규칙들의 상태를 센 것 | M5 wave 0 | 블록 트리의 상태 점(README 2)은 이 집계의 최악값 |
| "블록 공통" 절 — 필수 검사 (1)(2)(3) | 실행: plumb check (dependency-cruiser → 1등급) + git: 공개 진입점 diff + 저장소: 설계 변경 이벤트 | 아키텍처 View 3절의 같은 행 | M5 wave 0 · M8 wave 1 | 상세는 아키텍처 View로 링크. (3)은 "이벤트가 있고 사유가 기록돼 있는가"를 본다 |
| 블록 행 오른쪽 커밋 · 시각 | 실행: plumb check 결과 헤더 | 3.1과 같음 | M5 wave 1 | |

### 3.3 규칙별 행

| 항목 | 출처 | 생성 방식 (어느 파서의 어느 필드) | 도입 마일스톤 | 비고 |
|---|---|---|---|---|
| 규칙 ID · 진술 요약 · 블록 | 저장소: 규칙 YAML | `id`, `statement`(EARS 한 줄), `block`, `summary`(없으면 statement 앞 30자) | M3 wave 0 | |
| 승인 시각 · 승인자 · 결정 기록 ID | 저장소: 승인 기록 + 결정 기록 | `approvals/<rule>.json` `{ approvedAt, by }` · `decision` | M3 wave 1 | 미승인이면 ⬜ "미승인" |
| 검사 종류 (인수 테스트 · 계약 테스트 · PBT · 정적 분석 · 트레이스) | 저장소: 규칙 YAML `checks[].kind` | `checks[]: [{ kind, ref }]`. `ref`는 테스트 파일 경로 또는 정적 규칙 이름 | M3 wave 0 · M5 wave 0 (`checks` 매핑) | 보장 등급(§7.2)은 kind에서 유도: 정적 분석 = 1등급, 나머지 = 2등급 |
| 상태 아이콘 🟢 | 실행: plumb check (JUnit XML `testcase` 통과) + 실행: 위반 주입 기록 (`valid == true`) | 규칙의 모든 `checks[]` 통과 **그리고** 유효한 주입 기록이 있고 그 뒤 검사 파일이 안 바뀜 | M5 · M7 | 비고: 근거 = 인수 테스트 통과 + 주입으로 유효성 확인 (§7.3). 정적 분석 검사는 주입 없이 통과만으로 🟢 (1등급 증명) |
| 상태 아이콘 🟡 | 실행: plumb check (JUnit 통과) + 실행: 위반 주입 기록 없음 또는 `valid == false` | 통과했지만 유효성이 확인되지 않음 | M5 · M7 | 비고: 근거 = 통과·미검증. M7 전에는 모든 통과가 🟡 |
| 상태 아이콘 🟠 | git: 검사 파일 변경 (유효성 기록 커밋 → HEAD) 또는 저장소: 검토 대기열의 "해석 불일치 보류" 항목 | `git diff --name-only <validity.commit> HEAD -- <checks[].ref>` 가 비어 있지 않음 · 또는 대기열 항목이 이 규칙을 가리킴 | M6 (대기열) · M7 (유효성) | 비고: 근거 = 검사 파일이 바뀌면 유효성 무효(§7.4) · 해석 불일치는 사람이 풀 때까지 보류 |
| 상태 아이콘 🔴 | 실행: plumb check (JUnit `failure` · `error` 또는 dependency-cruiser `violations[]`) | `checks[]` 중 하나라도 실패 | M5 wave 0 | 비고: 근거 = 검사 실패뿐. 추정으로 🔴를 만들지 않는다 (§7.3). 주입이 "무효 ✘"여도 검사가 통과면 🟡이지 🔴가 아니다 |
| 상태 아이콘 ⬜ | 저장소: 규칙 YAML `checks[]` 비어 있음 · 승인 기록 없음 · 실행: plumb check `quarantined[]` 에 포함 | 검사 없음 / 미승인 / 불안정 격리 중 하나 | M3 · M5 · M7 | 비고: 근거 = 검사가 없거나 돌지 않았다. LLM 판정(rule-drafter 등)의 결과는 언제나 ⬜ |
| 상태 계산 우선순위 | 실행: plumb check → 상태 계산 | ⬜(검사 없음·미승인·격리) → 🔴(실패) → 🟠(검사 파일 바뀜·보류) → 🟢(통과+유효) → 🟡(통과) | M5 wave 0 | 한 규칙에 검사가 여럿이면 최악값 |
| 유효성 (유효 ✔ · 무효 ✘ · 미확인) + 주입 설명 한 줄 + 주입 커밋·시각 | 실행: 위반 주입 기록 | `injections/<rule>/<id>.json` `{ description, result: "check-failed"|"check-passed", valid, commit, at, checkFileHashes }` | M7 | 사람은 설명 한 줄과 결과만 본다 (§7.4). 패치 내용은 보이지 않는다 |
| 무효 → 차이 탐색 링크 | 실행: 위반 주입 기록 `diffSearchRun` + 저장소: 실행 기록 | run ID → 실행 화면(#2) | M7 | 차이 탐색은 에이전트가 아닌 러너 |
| 실패 위치 `file:line` + 메시지 | 실행: plumb check (JUnit XML `testcase/failure`) | `failure` 텍스트의 스택에서 `test/**` 첫 프레임의 `file:line`, `message` 속성. 정적 분석은 `violations[].from` + import 문 줄 | M5 wave 0 | Vitest JUnit 리포터는 스택을 `failure` 본문에 넣는다. 파싱 실패 시 파일만 (`:1`) |
| PBT 반례 · 시드 | 실행: plumb check (JUnit `failure` 본문) | fast-check 메시지의 `Counterexample:` · `Seed:` 줄 | M5 wave 0 | 재현에 필요. 없으면 메시지 그대로 |
| 결과 커밋 · 시각 · 소요 | 실행: plumb check 결과 | `commit`, `finishedAt`, `testcase@time` | M5 wave 1 | 행마다 반복 |
| 이력 (최근 n회 상태) | 실행: plumb check 이력 | `checks/*.json` 을 시각순으로 읽어 이 규칙의 상태 나열 | M5 wave 1 | 저장소에 쌓인 실행 결과. 출처는 `실행:` (머리의 기준) |
| ⚠ 체류 일수 | 저장소: 규칙 상태 기록 `statusSince` | 3.1 최장 체류와 같은 계산 | M5 | 잠정 상태 행에만 |
| [IDE에서 열기] | 사용자 입력: 이유 선택 → `plumb open` | README 2.2 | M8 wave 2 | |

### 3.4 검사 범위 밖 (생략 불가)

| 항목 | 출처 | 생성 방식 (어느 파서의 어느 필드) | 도입 마일스톤 | 비고 |
|---|---|---|---|---|
| 규칙 0개 블록 | 파서: 블록 그래프 JSON − 저장소: 규칙 YAML `block` | L1 블록 목록에서 `block` 값으로 한 번도 안 나오는 것 | M5 wave 0 | 블록 공통 필수 검사는 세지 않는다 (모든 블록에 자동이므로 "규칙"이 아니다) |
| 요구사항에 없는 코드 | 파서: 블록 그래프 JSON − 저장소: 규칙 YAML `scope` | 블록 안 파일 중 어느 규칙의 `scope` 글롭(기본값: 블록 전체)에도 안 맞는 것. 디렉토리로 접어 표시 | M5 wave 0 | `scope`가 없는 규칙은 블록 전체를 덮는 것으로 본다 — 그러면 이 항목은 "규칙 0개 블록"의 파일과 같아진다. 세분화는 6절 |
| 코드에 없는 요구사항 | 저장소: 규칙 YAML + 파서: 파일 존재 여부 | 승인된 규칙 중 `scope` 글롭 매칭 파일 0개 또는 `checks[].ref` 파일 없음 | M5 wave 0 | 괄호 안에 이유(매칭 0 / 검사 파일 없음) |
| 테스트가 안 지나간 흐름 (n / 진입점 m) | 파서: OpenAPI operations (진입점 m) + 실행: 테스트 실행 중 OTel 트레이스 (span이 찍힌 진입점) | m − (테스트 실행 중 `http.route` span이 한 번이라도 잡힌 operation 수) | M8 wave 1 (`[L]` OTel spike) | OTel 불가면 **"측정 불가 (트레이스 없음)"** 를 쓴다. 0이라고 쓰지 않는다. 정적 호출 그래프 대안은 #4 흐름도의 결정을 따른다 |
| 미분류 파일 수 ▲ | 파서: 블록 그래프 JSON | 아키텍처 View와 같은 값 | M8 wave 0 | 항상 표시 (§12) |
| 불안정으로 격리된 검사 (파일 · 3회 중 통과 수) | 실행: plumb check `quarantined[]` | 같은 커밋에서 3회 실행해 결과가 갈린 `testcase` (§7.5) `{ ref, passes: 2, runs: 3 }` | M5 wave 0 (3회 실행) · M7 | 격리된 검사를 가진 규칙은 ⬜. 격리 해제는 사람(`사용자 입력:`)이고 M10 |
| 절 오른쪽 커밋 · 시각 | 실행: plumb check 결과 헤더 | 3.1과 같음 | M5 wave 1 | 이 절의 값도 같은 실행의 것이다 |

## 4. 동작

- **블록 필터**: 블록 트리에서 `auth`를 누르면 auth 절과 "블록 공통" 절만 남는다. 상단 요약과 **"검사 범위 밖" 절은 필터와 무관하게 전체 값**을 유지한다 — 범위 밖은 "전체의 범위 밖"이어야 의미가 있다. 다만 "요구사항에 없는 코드"는 선택 블록 안의 것을 먼저 보인다
- **상태 토글**: 🟢🟡🟠🔴⬜ 각각 켜고 끈다. 다 끄면 빈 화면이 아니라 "상태 필터로 전부 숨김 (규칙 12)"
- **정렬**: 상태(최악 우선, 기본) · 블록 · 체류 일수 · 승인 시각
- **규칙 행 펼치기**: 2절의 펼친 모양. 진술 전문 · 검사 · 결과 · 유효성 · 이력
- **`file:line` 점프 위치**: 🔴 행의 실패 위치(`test/acceptance/….spec.ts:42`) · 정적 분석 위반 위치(`src/…:2`) · 격리된 검사 파일 · "요구사항에 없는 코드"의 파일 · "코드에 없는 요구사항"의 검사 파일(존재할 때). 모두 README 2.2 (이유 선택 → `plumb open`). 규칙 YAML 자체는 열지 않는다 — 규칙은 `/rules` 화면(#2)에서 본다
- **링크 (IDE 아님)**: 규칙 ID → `/rules/<id>` · 결정 D-xxxx → 변경 로그 View · 차이 탐색 run → `/runs/<id>` · 필수 검사 (2) 위반 → 아키텍처 View · "테스트가 안 지나간 흐름" → 흐름도 View(#4)
- **수준 전환**: 없다. 블록(L1) 아래 규칙 행이 고정 구조. L0 수준 집계는 상단 요약이 맡는다
- **새로고침**: `plumb check`가 끝나 `checks/<runId>.json`이 생기면 다시 그린다 (UI는 저장소 파일 폴링, README 3.1)

## 5. 비어 있을 때

| 상황 | 화면 |
|---|---|
| `plumb check`를 한 번도 안 돌림 | 상단 요약: "마지막 검사 없음". 모든 규칙 ⬜ "검사 안 됨". "검사 범위 밖" 절은 파서·저장소만으로 되는 항목(규칙 0개 블록 · 요구사항에 없는 코드 · 코드에 없는 요구사항 · 미분류)은 그리고, 실행이 필요한 항목(흐름 · 격리)은 "검사 없음" |
| `plumb check` 실패 (테스트 러너 자체가 죽음) | "검사 실패 (exit n) · stderr 마지막 20줄" + 이전 성공 결과를 **커밋·시각을 크게 표시한 채** 그린다. 상태 아이콘은 이전 결과 그대로이되 행마다 "(이전 결과 e5f6a7)" |
| JUnit XML이 없거나 깨짐 | "JUnit 결과 없음 — 리포터 설정 확인 (`vitest --reporter=junit`)". 정적 검사(dependency-cruiser)만 반영 |
| 규칙 0개 (M3 전 또는 빈 저장소) | 블록 절 없음. "규칙 없음 — `/rules`에서 규칙을 만들고 승인하세요". "검사 범위 밖"은 그린다: 규칙 0개 블록 = 모든 블록, 요구사항에 없는 코드 = 모든 블록 파일 |
| 규칙은 있으나 승인 0개 | 모든 행 ⬜ "미승인". 검사가 통과해도 🟢로 올리지 않는다 |
| 주입 기록 없음 (M7 전) | 유효성 열 전부 "유효성 미확인". 통과한 규칙은 전부 🟡. 🟢가 하나도 없는 것이 M7 전의 정상 |
| 블록 그래프 없음 | 블록별 절은 규칙 YAML의 `block` 값으로만 묶는다. "규칙 0개 블록"·"미분류"는 "블록 그래프 없음 — `plumb views` 실행 필요" |
| OTel 트레이스 없음 | "테스트가 안 지나간 흐름: 측정 불가 (트레이스 없음)". 진입점 수 m은 OpenAPI가 있으면 보인다 |
| git 없음 | 🟠 "검사 파일 바뀜" 판정 불가 → 유효성 기록의 `checkFileHashes`와 현재 파일 해시 비교로 대체 (파서). 둘 다 없으면 🟡 |

## 6. 열린 질문 (#5 타입 설계로 넘김)

1. **규칙 ↔ 검사 매핑의 키.** `checks[].ref`가 테스트 파일 경로이면 파일 하나에 규칙 하나다. 파일 안의 `describe('[auth.session-store]')` 이름으로 매핑하면 여러 규칙이 한 파일을 쓸 수 있지만 JUnit `classname`·`name` 파싱이 리포터마다 다르다. M5 wave 0 "`checks` 매핑" 전에 결정
2. **상태 기록의 위치.** 상태는 `plumb check`가 계산해 `checks/<runId>.json`에 쓰는가(실행), 저장소가 규칙별 `status.json`을 갱신하는가(저장소). 둘 다면 어느 쪽이 진실인가. `statusSince`(체류 일수)는 후자가 있어야 계산된다
3. **"요구사항에 없는 코드"의 단위.** 규칙 `scope`가 없으면 블록 전체를 덮는다고 봐서 이 항목이 "규칙 0개 블록"과 겹친다. `scope`를 필수로 할지, 블록 단위면 충분한지
4. **흐름의 정의.** "테스트가 안 지나간 흐름"의 분모를 OpenAPI operation으로 둘지, OTel의 `http.route` 집합으로 둘지, #4 흐름도의 정적 호출 그래프 진입점으로 둘지. #4 결정과 맞춘다
5. **3회 실행의 비용.** 격리 판정(§7.5)을 매번 3회 돌릴지, 실패·결과 변동 때만 재실행할지. `plumb check`의 옵션(`--stability 3`)으로 둘지
6. **View 타입 초안.** `VerificationView { generatedAt, commit, store: { status: "ok"|"tampered"|"unverified" }, lastCheck?: { runId, commit, finishedAt }, summary: { unconfirmed, longestPendingDays, longestPendingRule?, rules, approved, byStatus: Record<Status, number>, checks: { junit, static }, quarantined }, blocks: [{ id, rules, approved, byStatus, lastCheck, items: RuleRow[] }], common: RuleRow[], outOfScope: { blocksWithoutRules: string[], codeWithoutRules: [{ path, files }], rulesWithoutCode: [{ ruleId, reason: "no-match"|"check-missing" }], untestedFlows: { count, total } | { unavailable: "no-trace" }, unclassifiedFiles: number, quarantined: [{ ref, passes, runs }] } }` · `RuleRow { ruleId, block?, summary, statement, status: "pass-verified"|"pass-unverified"|"recheck"|"fail"|"unchecked", statusReason, checkKind, validity?: { valid, description, commit, at, diffSearchRun? }, failure?: { file, line, message, counterexample?, seed? }, approvedAt?, by?, decision?, pendingSince?, history: Status[] }`
