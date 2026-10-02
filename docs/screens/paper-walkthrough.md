# 첫 슬라이스 종이 시뮬레이션 — `pay.refund-window`

이슈 #5의 산출물. 규칙 하나("환불은 결제 후 7일 이내만")를 세 작업 화면으로 한 바퀴 돌린다: `/rules`에서 초안을 확인·승인하고, `/runs`에서 실행을 시작해 단계 ②③④⑤⑥이 지나가는 동안 화면이 어떻게 바뀌는지 보고, `/views`에서 검증 상태 → 흐름도 → 변경 로그 순으로 읽는다. 각 장면마다 그 화면이 `docs/types`의 어떤 타입·필드를 그리는지 적는다. 와이어프레임 안의 값은 예시이며, 실제 화면은 파서·실행 결과가 있을 때만 그려진다.

목적은 기획안 §15.3의 **코드 열람 기록을 미리 해보는 것**이다. 마지막 두 절("코드를 열고 싶은 지점", "와이어프레임에 없어서 추가해야 할 항목")이 이 문서의 결과다.

## 0. 전제

- testbed는 M2 종료 상태: `src/domains/payment/refund.ts`의 naive `refund()`가 8일 지난 결제도 환불한다. 인수 테스트 디렉토리 `test/acceptance/`는 비어 있다
- 보호 저장소에는 기술 규칙 `pay.payment-record`(🟡 pass-unverified, 승인)와 결정 기록 `D-0007`이 있다. 상단 바 `⚠ 6`은 다른 블록의 잠정 규칙과 대기열 항목이다
- `plumb.config.json` (`PlumbConfig`): `roles.test-writer.maxTurns 40`, `roles.implementer.maxTurns 40`, `stopBlockLimit 5`, `run.maxBudgetUsd 10`, `ide: "code --goto {file}:{line}"`, `flow.mode: "auto"`, `blocks.payment { include: ["src/domains/payment/**"], dependsOn: ["auth"], risk: "high" }`
- `plumb check`가 한 번 돌아 있다 (`CheckRun c-0011`, 커밋 `a1b2c3`). `plumb views`도 돌아 있다 (M8 전이므로 흐름도는 `mode: 'static'`)
- 개발자는 `plumb ui`를 켜고 `/auth?token=…`를 거쳐 쿠키를 받았다 (README 3.2)

## 1. `/rules` — 초안 확인 · 승인

### 1.1 초안 만들기 (화면 밖)

```
$ plumb rule draft --block payment --source plan:PAY-02 "환불은 결제 후 7일 이내만"
```

rule-drafter(LLM, `maxTurns 1`)가 EARS 한 줄을 만들고 **제안**으로 저장한다. 규칙이 아니라 제안이다 — `rules.yaml`에는 아직 아무것도 없다.

| 저장되는 것 | 타입 · 필드 |
|---|---|
| `proposals/pay.refund-window/p-0001.json` | `Proposal { id: 'p-0001', ruleId: 'pay.refund-window', changeKind: 'add', proposedBy: 'cli', proposedAt, before: undefined, after: Rule, requiresPriorApproval: false, applied: 'provisional' }` |
| `after` | `Rule { id, block: 'payment', kind: 'business', statement: 'WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다', source: 'plan:PAY-02', risk: 'high', depends_on: ['pay.payment-record'], checks: [{ kind: 'pbt', ref: 'test/acceptance/refund-window.property.spec.ts' }], decision: undefined }` |
| `approvals/pay.refund-window.jsonl` 첫 줄 | `Approval { action: 'propose', by: 'cli', at, proposalId: 'p-0001', proposalHash }` |

`risk: 'high'`는 블록 선언(`blocks.payment.risk`)에서 왔다. `changeKind: 'add'`이므로 §9.1에 따라 즉시 잠정 적용 — `requiresPriorApproval: false`.

### 1.2 목록

브라우저에서 `/rules`를 연다. `GET /api/rules` → `RuleListResponse`.

```
│ 규칙 · 승인              ⚠ 미확인 7건 · 최장 3일 체류       │
│ 필터: 블록 payment ×  종류 [전체 ▾]  승인 [전체 ▾]  상태 [전체 ▾] │
│ ID                 종류 상태 승인                           │
│ pay.refund-window  biz  ⬜  잠정 ⚠미확인 ⚡                   │
│ pay.payment-record tech 🟡  승인                            │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 머리 `⚠ 미확인 7건 · 최장 3일` | `RuleListResponse.unconfirmed = 7`, `longestPendingDays = 3` (상단 바는 `StatusResponse.unconfirmed.total`, 같은 값) |
| 경고 띠 없음 | `RuleListResponse.queueLimit.exceeded = false` |
| 행 `pay.refund-window biz ⬜ 잠정 ⚡` | `RuleListItem { id, kind: 'business', status: 'unchecked', approval: 'provisional', highRisk: true, statusAt: undefined }` |
| 필터 칩 `payment ×` | `RuleListFilter.block = 'payment'` (URL `?block=payment`) |

상태가 ⬜인 이유는 아직 보이지 않는다 — 상세에서 `RuleStatusDetail.reason`으로 안다.

### 1.3 상세

행 클릭 → `/rules?id=pay.refund-window` → `GET /api/rules/pay.refund-window` → `RuleDetailResponse`.

```
│ pay.refund-window                                    │
│ business · payment · ⚡ 고위험                          │
│ 변경: 추가 (잠정 적용 · 사후 확인)                       │
│ WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL  │
│ 요청을 거절한다                                        │
│ 출처: plan:PAY-02                                     │
│ 의존: pay.payment-record 🟡                            │
│ 검사: test/acceptance/refund-window.property.spec.ts   │
│   파일 없음 · ⬜                                        │
│ 결정 기록 없음                                          │
│ 변경 diff                                              │
│   + id: pay.refund-window                              │
│   + statement: WHEN … 7일 …                             │
│   + …                                                  │
│ 이력: 제안 10-02 14:01 (cli)                            │
│ 기각 사유 [                 ]                           │
│          [기각]   [승인]                                │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| `변경: 추가 (잠정 적용 · 사후 확인)` | `RuleDetailResponse.proposal.changeKind = 'add'`, `requiresPriorApproval = false`, `applied = 'provisional'` |
| 진술 · 출처 | `proposal.after.statement`, `.source` (`rule`은 아직 없음 — 승인된 버전이 없다) |
| `의존: pay.payment-record 🟡` | `depends: [{ ruleId, status: 'pass-unverified', exists: true }]` |
| `검사: … 파일 없음 · ⬜` | `checks: [{ check: { kind: 'pbt', ref }, exists: false, lastResult: undefined }]`, `status: { status: 'unchecked', reason: 'check-missing' }` |
| `결정 기록 없음` | `decision: undefined` (파일이 없는 것은 `{ missing }`, 가리키지 않는 것은 없음) |
| diff 전부 `+` | `diff: RuleDiffLine[]`, 모두 `op: '+'` |
| 이력 한 줄 | `approvals: [Approval(action: 'propose')]` |

`[기각]`은 사유가 비어 있어 비활성 (`RejectRequest.reason` 필수).

### 1.4 승인

`[승인]` → `POST /api/rules/pay.refund-window/approve` 본문 `ApproveRequest { proposalId: 'p-0001', proposalHash }`. 쿠키가 있으므로 200.

| 바뀌는 것 | 타입 · 필드 |
|---|---|
| 응답 | `ApproveResponse { approval: Approval(action: 'approve', by: 'ui'), approvalState: 'approved', unconfirmed: 6 }` |
| 목록 행 | `RuleListItem.approval → 'approved'`, `⚠ 미확인` 사라짐. **`status`는 그대로 `'unchecked'`** — 승인은 검사가 아니다 |
| 상단 바 | `StatusResponse.unconfirmed.total 7 → 6` |
| 저장소 | `rules.yaml`에 `Rule` 항목 생김. `Proposal.applied → 'applied'`. `approvals/…jsonl`에 둘째 줄 |

만약 그 사이 CLI에서 이미 승인했다면 `proposalHash`가 달라 409 `ApiError { status: 409, code: 'proposal-changed' }` → 화면이 다시 읽는다.

## 2. `/runs` — 실행 시작, 단계 ②③④⑤⑥

### 2.1 새 실행

`[▶ 새 실행]` → 패널. `GET /api/rules`의 `RuleListItem[]` 중 `approval === 'approved'`만 체크 가능.

```
│ 규칙 선택 (승인된 규칙만)                                  │
│  ☑ pay.refund-window    ⬜  승인                           │
│  ☐ pay.payment-record   🟡  승인                           │
│ 예산 상한 $10.00 · 역할별 maxTurns 40 · stopBlockLimit 5    │
│                                         [취소] [시작]     │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 예산 · 상한 줄 | `PlumbConfig.run.maxBudgetUsd`, `roles.*.maxTurns`, `stopBlockLimit` (파서:). 없으면 `[시작]` 비활성 |
| `[시작]` | `POST /api/runs` `CreateRunRequest { ruleIds: ['pay.refund-window'] }` → 201 `CreateRunResponse { id: 'r-0001' }` |

실패 경로: 잠정 규칙을 보냈으면 400 `rule-not-approved`; 이미 도는 실행이 있으면 409 `run-in-progress { runId }`; `plumb` 바이너리가 없으면 500 `spawn-failed`.

### 2.2 spawn 직후 (단계 ① ✔, ② 전)

`/runs?id=r-0001`로 이동, 1~2초 폴링 `GET /api/runs/r-0001` → `RunState`.

```
│ r-0001 · 10-02 14:03 · 경과 0:02                           │
│ 마지막 갱신 1초 전 · pid 4812                                │
│ 대상: pay.refund-window ⬜                                   │
│ ① 승인 ✔ 14:02                                             │
│ ② 테스트 작성                                               │
│ …                                                          │
│ 현재 역할 —   반복 0 · 종료 차단 0                            │
│ 예산 $0.00 / $10.00                                          │
│ 이의 제기: 없음                                              │
│ 아직 실행 출력 없음                                          │
│ 종료: — (진행 중)                                  [중단]    │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 머리 | `RunState { id, startedAt, updatedAt, pid, status: 'running', stage: 1 }` |
| `① 승인 ✔ 14:02` | `stages[0]: StageRecord { stage: 1, attempt: 1, role: null, result: { stage: 1, approvedAt: { 'pay.refund-window': '…14:02' } } }` |
| `현재 역할 —` | `currentRole: null` |
| 예산 | `costUsd: 0`, `limits.maxBudgetUsd: 10` |
| 출력 없음 | `capturedOutput: undefined` |
| `[중단]` | 보임 (`status === 'running'`). 누르면 `AbortRunRequest { confirm: true }` → 202 `AbortRunResponse` |

### 2.3 단계 ② 테스트 작성 (test-writer)

test-writer는 `src/**`를 읽을 수 없고 `tsc --declaration` 스텁과 규칙 진술만 받는다. PBT 테스트를 쓴다. Stop hook은 "전부 실패"를 요구한다.

첫 시도: 테스트가 7일 **정각**을 통과시키는 쪽으로 쓰여 naive `refund()`에서도 통과 → Stop hook 차단 1회. 둘째 시도: 8일 입력으로 실패 확인 → 종료.

```
│ ② 테스트 작성 ● 14:03→           🔴 1/1 실패                 │
│ 현재 역할 test-writer   반복 5 / 40 · 종료 차단 1 / 5          │
│ 마지막 실행 출력 (가로챈 vitest 출력)                          │
│ │ FAIL test/acceptance/refund-window.property.spec.ts        │
│ │   ✗ rejects refund after 7 days                             │
│ │ Tests  1 failed · 1 total                                   │
│ │ 14:07:02 · exit 1                                           │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| `② ● … 🔴 1/1 실패` | `stages[1]: StageRecord { stage: 2, attempt: 1, role: 'test-writer', startedAt, result: { stage: 2, tests: { total: 1, passed: 0, failed: 1 }, allFailed: true } }` |
| `반복 5 / 40 · 종료 차단 1 / 5` | `roles['test-writer'] = { turns: 5, stopBlocks: 1, consecutiveStopBlocks: 0, costUsd: 1.1 }`, `limits.maxTurns['test-writer'] = 40`, `limits.stopBlockLimit = 5` |
| 출력 블록 | `capturedOutput: CapturedOutput { command: 'vitest run --reporter=junit …', exitCode: 1, tail: [...], finishedAt, logPath: 'runs/r-0001/output.log' }` |

화면 어디에도 test-writer가 "테스트를 작성했습니다"라고 말한 문장은 없다. `RunState`에 그 필드가 없다.

`allFailed: true`이므로 ② ✔. `stage → 3`.

### 2.4 단계 ③ 구현 (implementer)

implementer는 `test/acceptance/**`에 쓸 수 없다. 테스트가 통과할 때까지 또는 이의 제기까지. 두 번 차단된 뒤 이의를 제기한다: "7일 정각은 허용인가 거절인가 — 테스트는 `> 7d`를 거절로 보는데 규칙 진술 '초과'와 같다고 보지만 경계 입력이 없다".

```
│ ③ 구현 ● 14:07→                 🔴 0/1 통과                   │
│ 현재 역할 implementer   반복 7 / 40 · 종료 차단 2 / 5           │
│ 이의 제기: ⚠ 1건  14:10 implementer → test-writer 재검토 중      │
│   "refund-window.property.spec.ts 의 경계값(7일 정각)이 규칙과 다름" │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| `③ ● 🔴 0/1 통과` | `stages[2]: { stage: 3, attempt: 1, role: 'implementer', result: { stage: 3, tests: { total: 1, passed: 0, failed: 1 }, allPassed: false, disputeId: 'd-0001' } }` |
| 이의 제기 줄 | `disputes: [Dispute { id: 'd-0001', at, by: 'implementer', reviewer: 'test-writer', summary: '…', file: '.work/implementer/disputes/d-0001.md', status: 'reviewing' }]` |

test-writer가 재검토해 "경계 7일 정각 = 허용, 테스트는 `> 7d`만 거절 — 테스트가 맞다"는 판정과 근거 입력(`paidAt + 7d exactly`)을 낸다. 이것은 LLM 출력이므로 `Dispute.advisory`에만 들어가고 **어떤 상태도 바꾸지 않는다**.

```
│ 이의 제기: 1건 해결  14:12 test-writer 판정: 테스트가 맞음 (근거 입력: paidAt + 7d) │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 판정 줄 | `disputes[0].status = 'resolved'`, `advisory: { by: 'test-writer', at, verdict: 'test-correct', evidenceInput: 'paidAt + 7d exactly' }` |

implementer가 `refund.ts`에 `differenceInDays(now, payment.paidAt) > 7`를 넣고(이때 `date-fns`를 추가한다) 테스트가 통과한다.

```
│ ③ 구현 ✔ 14:07→14:18            🟢 1/1 통과                   │
│ │ PASS test/acceptance/refund-window.property.spec.ts        │
│ │ Tests  1 passed · 1 total                                   │
│ │ 14:18:40 · exit 0                                           │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| `③ ✔ 🟢 1/1` | `result: { stage: 3, tests: { total: 1, passed: 1, failed: 0 }, allPassed: true }`, `finishedAt` |
| 출력 | `capturedOutput.exitCode = 0` |

implementer는 세션 끝에 결정 기록 `D-0029`를 남겼다 (결정: 일수 계산은 `date-fns` `differenceInDays`, UTC 기준 / 이유 / 기각: 직접 ms 나눗셈 — DST 경계 / 감수: 의존 1개 추가 / 연결: `pay.refund-window`, `packages: ['date-fns']`). 이것은 `DecisionRecord`이고 3등급(기록)이다. 실행 화면에는 보이지 않는다 — 변경 로그 View의 몫.

### 2.5 단계 ④ 전체 검사

역할 없음. 오케스트레이터가 `plumb check`를 돌린다.

```
│ ④ 전체 검사 ✔ 14:18→14:21        pay.refund-window 🟡 · 전체 🟢 1 🟡 2 ⬜ 0 │
│ 현재 역할 —                                                      │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| ④ 결과 | `result: { stage: 4, checkRunId: 'c-0012', byRule: { 'pay.refund-window': 'pass-unverified', 'pay.payment-record': 'pass-unverified', … } }` |
| 저장소에 생기는 것 | `CheckRun c-0012 { commit: 'b7c8d9', results: [CheckResult { check, ruleIds: ['pay.refund-window'], outcome: 'pass', durationSec: 1.2 }], quarantined: [], counts: { junit: 14, static: 2 }, storeStatus: 'ok' }`, `RuleStatusRecord { ruleId: 'pay.refund-window', detail: { status: 'pass-unverified', reason: 'no-injection' }, since, commit: 'b7c8d9', checkedAt, history: ['unchecked', 'pass-unverified'] }` |

🟡인 이유는 주입이 아직 없어서다 (`reason: 'no-injection'`). ④는 통과했지만 🟢가 아니다 — 이것이 M7 전의 정상.

### 2.6 단계 ⑤ 위반 주입 (injector)

injector가 임시 worktree에 "7일을 70일로 바꾼다"는 위반을 넣고 검사를 돌린다. 검사가 실패하면 유효.

```
│ ⑤ 위반 주입 ✔ 14:21→14:26        주입 1건 · 잡힘 1건              │
│ 현재 역할 injector   반복 3 / 30 · 종료 차단 0 / 5                 │
│ │ FAIL test/acceptance/refund-window.property.spec.ts (worktree .work/injector/wt-1) │
│ │ Tests  1 failed · 1 total                                        │
│ │ 14:25:50 · exit 1                                                │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| ⑤ 결과 | `result: { stage: 5, injections: 1, caught: 1, weak: false }` |
| 저장소에 생기는 것 | `Validity { id: 'i-0001', ruleId, description: '환불 기간 7일 → 70일', anchor: { file: 'src/domains/payment/refund.ts', line: 17 }, result: 'check-failed', valid: true, commit: 'b7c8d9', at, checkFileHashes: { 'test/acceptance/refund-window.property.spec.ts': 'sha…' } }` |
| 상태 전이 | `RuleStatusRecord.detail → { status: 'pass-verified', reason: 'passed-and-injection-valid', validity }`, `history: [..., 'pass-verified']` |

`weak: true`였다면(검사가 통과) ②로 되돌아가 `stages[]`에 `{ stage: 2, attempt: 2 }`가 생기고 화면은 "② 2회차"를 덧붙인다. 이번엔 아니다.

### 2.7 단계 ⑥ View 갱신 · 종료

```
│ ⑥ View 갱신 ✔ 14:26→14:27        갱신된 View 6 · 검토 대기열 올림 0 │
│ 예산 $4.80 / $10.00 ▓▓▓▓▓░░░░░ 48%                                │
│ 종료: 완료 14:27 (24분)                                            │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| ⑥ 결과 | `result: { stage: 6, viewsUpdated: 6, queued: 0 }` |
| 예산 | `costUsd: 4.8` (역할별 합: `roles.*.costUsd`) |
| 종료 | `status: 'completed'`, `finishedAt`, `outcome: { status: 'completed', finishedAt }` |
| 커밋 범위 | `commits: { from: 'a1b2c3', to: 'b7c8d9' }` — 변경 로그 View가 이 실행을 세션으로 역매핑 |

폴링이 멈춘다. `[중단]`이 사라진다. 실행 목록 `GET /api/runs` → `RunSummary { id: 'r-0001', status: 'completed', stage: 6, … }`.

## 3. `/views` — 검증 상태 → 흐름도 → 변경 로그

### 3.1 검증 상태 (`?view=verification&block=payment`)

`GET /api/views/verification` → `ViewResponse { header, markdown, data: VerificationView, stale: undefined, codeOpens: 0 }`.

```
│ 필터: payment ×   생성 출처: 실행 plumb check c-0012 · 저장소 규칙 · git b7c8d9 · 열람 0회 │
│ ⚠ 미확인 5건 · 최장 3일 (auth.cookie-transport)   보호 저장소 정상 · 마지막 검사 1분 전 (b7c8d9) │
│ 규칙 13 · 승인 10 · 🟢 1 🟡 2 🟠 0 🔴 1 ⬜ 2 · 검사 16 (JUnit 14 · 정적 2) · 격리 0        │
│                                                                                       │
│ payment — 규칙 2 · 승인 2 · 🟢 1 🟡 1                                    b7c8d9 · 1분 전 │
│   🟢 환불 7일 이내 (pay.refund-window)   PBT   유효 ✔ (주입 i-0001 · 1분 전)               │
│   🟡 결제 기록 (pay.payment-record)     인수   유효성 미확인 (주입 기록 없음)                 │
│                                                                                       │
│ ━━ 검사 범위 밖 ━━                                                        b7c8d9 · 1분 전 │
│   규칙 0개 블록:          auth                                                          │
│   요구사항에 없는 코드:    src/domains/payment/report.ts                                   │
│   코드에 없는 요구사항:    없음                                                            │
│   테스트가 안 지나간 흐름: 3개 / 진입점 4 (정적 · 테스트 없는 진입점 기준)                     │
│   미분류 파일:            12개 ▲                                                         │
│   불안정으로 격리된 검사:  0                                                               │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 생성 출처 표시줄 | `ViewHeader.sources: [{ kind: 'execution', tool: 'plumb check', input: 'checks/c-0012.json' }, { kind: 'store', input: 'rules.yaml' }, { kind: 'git', commit: 'b7c8d9' }]` |
| 상단 요약 | `VerificationView.summary { unconfirmed: 5, longestPendingDays: 3, longestPendingRule: 'auth.cookie-transport', rules: 13, approved: 10, byStatus, checks: { junit: 14, static: 2 }, quarantined: 0 }`, `store.status: 'ok'`, `lastCheck: { runId: 'c-0012', commit: 'b7c8d9', finishedAt }` |
| payment 절 | `blocks[i]: VerificationBlock { id: 'payment', rules: 2, approved: 2, byStatus, items: RuleRow[] }` |
| 🟢 행 | `RuleRow { ruleId: 'pay.refund-window', kind: 'business', grade: 2, checks: [{ kind: 'pbt', ref }], detail: { status: 'pass-verified', reason: 'passed-and-injection-valid', validity }, validity: Validity(valid: true), approvedAt, approvedBy: 'ui', decision: undefined, lastResult: { commit: 'b7c8d9', finishedAt, durationSec: 1.2 }, history: ['unchecked', 'pass-unverified', 'pass-verified'] }` |
| 검사 범위 밖 | `outOfScope: OutOfScope { blocksWithoutRules: ['auth'], codeWithoutRules: [{ path: 'src/domains/payment/report.ts', files: 1, block: 'payment' }], rulesWithoutCode: [], untestedFlows: { mode: 'static', count: 3, total: 4, items: UncoveredFlow[] }, unclassifiedFiles: 12, quarantined: [] }` |

블록 필터 `payment`가 걸려 있어도 상단 요약과 검사 범위 밖은 전체 값이다. 행을 펼치면 `detail`·`validity`·`history`가 그대로 보인다 (view-verification 2절의 펼친 모양).

### 3.2 흐름도 (`?view=flow&scenario=POST /refunds`)

M8 spike 전이므로 `FlowView.mode = 'static'` (B안). `flow.mode: 'auto'`였고 트레이스 파일이 없어 `fallback: { reason: 'no-trace-files' }`.

```
│ 도메인별 흐름도                  정적 그래프 b7c8d9 · 1분 전   ⓘ 트레이스 없음 (정적 · 대체) │
│ 테스트가 참조하지 않는 진입점 3개 → 검증 상태 View "검사 범위 밖"                            │
│ POST /refunds                     src/app/api/refunds/route.ts:8                         │
│ 테스트 있음: refund-window.property.spec.ts:1 (규칙 pay.refund-window 🟢)                  │
│  ── auth.verifySession              src/domains/auth/index.ts:21   참조됨                 │
│  ── payment.refund                  src/domains/payment/index.ts:40 참조됨                 │
│      ── payment.refundWindow.check  src/domains/payment/refund.ts:17   (내부)              │
│      ── ⬡ pg (prisma client import)                                   (정적)              │
│      ── emit payment.refundRejected  ⚠ 핸들러 연결 불명                                     │
│ 정적 그래프에서 안 보이는 것 — 이벤트 핸들러 · 미들웨어 순서 · DI 구현                         │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 머리 | `FlowView { mode: 'static', fallback, lastCheck, traceCount: undefined, uncovered: { count: 3, total: 4, items } }` |
| 진입점 | `scenarios[i]: FlowScenario { id: 'POST /refunds', unit: 'entry', entry: { method: 'POST', path: '/refunds', anchor }, test: { file: 'test/acceptance/refund-window.property.spec.ts', line: 1 }, rules: [{ ruleId: 'pay.refund-window', status: 'pass-verified' }], result: 'pass', root: FlowNode, uncoveredCount: 0, block: 'payment' }` |
| 노드들 | `FlowNode { id: 'auth.verifySession', kind: 'public', testRef: 'referenced', anchor, children }` · `{ id: 'payment.refundWindow.check', kind: 'internal', testRef: 'internal' }` · `{ id: 'ext:pg', kind: 'external', external: { system: 'pg' }, testRef: 'static' }` · `{ id: 'event:payment.refundRejected', kind: 'emit', handlerUnknown: true }` |

"7일 초과 거절" 시나리오는 B안에 없다 — 함수 안의 `if`로만 갈리기 때문이다 (view-flow 4.0). 이 한계는 코드를 열고 싶게 만든다 (4절 4번).

### 3.3 변경 로그 (`?view=changelog`)

```
│ 기술 변경 로그                                        기준 b7c8d9 ← a1b2c3 (3 커밋) │
│ 사유 없는 설계 변경 이벤트  1 / 2  (50%)   ▂▅  최근 2회 검사                       │
│ 커밋 b7c8d9 · 세션 r-0001 · 2026-10-02 14:18                                      │
│  E-0001 ⊕ 새 의존성 도입   date-fns@4.1.0          payment   D-0029 ✔              │
│         pnpm-lock.yaml:120  ·  src/domains/payment/refund.ts:2                     │
│  E-0002 ⚖ 규칙 변경        pay.refund-window 추가   payment   사유 없음              │
│         proposals/pay.refund-window/p-0001.json                                   │
```

| 화면 항목 | 타입 · 필드 |
|---|---|
| 머리 | `ChangelogView { range: { base: 'a1b2c3', head: 'b7c8d9', commits: 3 }, metric: { noReason: 1, total: 2 }, trend: [0.43, 0.5] }` |
| 커밋 묶음 | `groups[0]: CommitGroup { commit: 'b7c8d9', at, session: 'r-0001', events }` — `RunState.commits`로 역매핑 |
| E-0001 | `ChangeEvent { id: 'E-0001', kind: 'dependency-added', title: 'date-fns@4.1.0', blocks: ['payment'], session: 'r-0001', evidence: [{ source: 'git', anchor: { file: 'pnpm-lock.yaml', line: 120 }, after: '+ date-fns@4.1.0' }, { source: 'parser', anchor: { file: 'src/domains/payment/refund.ts', line: 2 } }], decisionIds: ['D-0029'], noReason: null, evidenceHash, linkedRules: [{ ruleId: 'pay.refund-window', status: 'pass-verified', exists: true }] }` |
| E-0002 | `ChangeEvent { kind: 'rule-changed', decisionIds: [], noReason: 'no-record', queueItemId: undefined }` — 승인 행위 자체는 결정 기록이 아니다. 규칙 추가에 사유를 남기려면 `Rule.decision`을 가리켜야 한다 (1.3에서 "결정 기록 없음"이었다) |
| 펼침의 결정 기록 | `DecisionRecord D-0029 { decision, reason, rejected, accepted, links: { rules: ['pay.refund-window'], commits: ['b7c8d9'], events: ['E-0001'], packages: ['date-fns'] } }`. `links.events`는 도구가 채운 값 |

## 4. 코드를 열고 싶은 지점

종이 위에서 세 화면을 지나는 동안 `[IDE ↗]`를 누르고 싶어진 순간. 각각 이유 종류(View 오류 · 정보 부족 · 디버깅·환경), 한 줄 설명, 어떤 View 항목이 있었다면 안 열었을지를 적는다 (기획안 §15.3). 실제로 눌렀다면 `CodeOpenRecord`가 남는다.

| # | 장면 | 열고 싶은 파일 | 이유 종류 | 한 줄 | 어떤 View 항목이 있었다면 안 열었을까 |
|---|---|---|---|---|---|
| 1 | 1.3 상세에서 진술 "7일을 초과하면"을 읽을 때 | (아직 없음 — 2.3 이후) `test/acceptance/refund-window.property.spec.ts` | 정보 부족 | 7일 **정각**이 허용인지 거절인지 진술만으로 확신이 안 선다. 테스트가 경계를 어떻게 잡았는지 보고 싶다 | 검증 View 규칙 행에 **"테스트 입력 샘플"**(실행: PBT가 생성한 경계 입력 몇 개 · `fast-check` 샘플) 또는 규칙 상세에 EARS 진술의 경계 예시(저장소: 제안에 `examples[]`). 둘 다 와이어프레임에 없다 → 5절 |
| 2 | 2.4 implementer가 두 번 차단됐을 때 | `src/domains/payment/refund.ts` (worktree) | 정보 부족 | 출력 꼬리 20줄엔 테스트 실패만 있고 **지금까지 무엇을 바꿨는지**가 없다. 이의 제기가 뜨기 전까지 "헤매는 중인지 가까운지" 모른다 | 실행 상세에 **"이 실행이 바꾼 파일 (git: worktree `diff --stat`)"** 한 줄 (파일 · +/−). 기획안 §8.3의 "가로챈 것만" 원칙에 맞는 `git:` 출처다 → 5절 |
| 3 | 2.6 주입 설명 "7일 → 70일"을 읽을 때 | `src/domains/payment/refund.ts` | 정보 부족 | 주입이 **그 규칙의 코드**에 들어갔는지(다른 곳의 상수를 바꾼 게 아닌지) 설명 한 줄로는 모른다 | `Validity.anchor` (주입 위치 file:line). 이 문서를 쓰며 타입에 추가했다. 패치 본문은 여전히 보이지 않는다 (§7.4) |
| 4 | 3.2 흐름도에 "7일 초과 거절" 시나리오가 없을 때 | `src/domains/payment/refund.ts:17` | 정보 부족 | 거절 경로가 실제로 있는지 흐름도로는 알 수 없다. 테스트가 🟢이니 있긴 할 텐데 어디서 갈리는지 보고 싶다 | A안(trace)이면 `emit payment.refundRejected` 노드가 실선/점선으로 갈려 보인다 (M8 spike). 정적만으로는 없다 — view-flow 6절 10번 (iii) 분기 커버리지 보조 재료가 답일 수 있다 |
| 5 | 2.3 첫 폴링에서 출력이 `exit 1`인데 테스트 집계가 0/0일 때 (가정: `--reporter=junit`이 설정에 없어 JUnit XML이 안 나온 경우) | `vitest.config.ts` | 디버깅·환경 | 테스트가 실패한 게 아니라 리포터가 없어서 집계가 비었다. 환경 문제 | 어떤 View도 아니다 — 이 범주가 존재하는 이유. 다만 `StageResult`의 `tests`가 `{ total: 0 }`이면 화면이 "JUnit 결과 없음 — 리포터 설정 확인"을 쓰도록 (view-verification 5절과 같은 문구) |

5건 중 정보 부족 4 · 디버깅·환경 1 · View 오류 0. 정보 부족 4건 중 2건(#1, #2)은 와이어프레임에 없는 항목으로 막을 수 있고, 1건(#3)은 타입 필드 하나로 막았고, 1건(#4)은 M8 spike에 달렸다.

## 5. 와이어프레임에 없어서 추가해야 할 항목

| 항목 | 화면 | 출처 | 근거 | 제안 마일스톤 |
|---|---|---|---|---|
| 이 실행이 바꾼 파일 목록 (파일 · +/− 줄 수) | `work-run.md` 3.3 실행 상세 | git: worktree `diff --stat` (오케스트레이터가 단계 끝마다 실행) | 4절 #2. 에이전트 자기 보고가 아니라 git이 본 것 | M6. `RunState`에 `changedFiles?: Array<{ file, added, removed }>` 자리는 지금 두지 않는다 — M6 이슈에서 타입과 함께 |
| 테스트 입력 샘플 (PBT 경계 입력 몇 개) | `view-verification.md` 3.3 규칙 행 펼침 | 실행: fast-check 리포터 출력 (성공 시에도 샘플을 남기게 어댑터 설정) | 4절 #1. "7일 정각"을 코드 대신 입력으로 확인 | M7 (주입과 같은 러너). `RuleRow`에 `inputSamples?: string[]` 자리는 M7에서 |
| 주입 위치 `file:line` | `view-verification.md` 3.3 "유효성" 행 | 실행: 위반 주입 기록 | 4절 #3 | M7. `Validity.anchor`로 타입에 이미 추가 |
| ⬜ 사유 "검사 파일 없음"과 "검사 없음"의 구분 | `work-approve.md` 3.2, `view-verification.md` 3.3 상태 ⬜ | 저장소: `checks[]` + 파서: 파일 존재 | 1.3에서 승인 직후 상태. 와이어프레임은 둘 다 ⬜ "검사 없음"으로 적었다 | M3. `RuleStatusDetail.unchecked.reason: 'check-missing'`로 타입에 이미 추가 |
| `rule-changed` 이벤트의 "사유 없음" 기준 | `view-changelog.md` 3절 | 저장소 | 3.3 E-0002. 승인 자체는 결정이 아니므로 `Rule.decision`이 없으면 사유 없음이 맞다. 와이어프레임엔 이 경우가 없다 | M8 wave 1. 타입 변경 없음, 감지기 규칙에 적는다 |
| 집계가 `{ total: 0 }`일 때 "JUnit 결과 없음" 문구 | `work-run.md` 4절 오류 상태 | 실행 | 4절 #5 | M6. 타입 변경 없음 |
