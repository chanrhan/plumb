# 하네스 노트 — Agent SDK 스모크 (#10)

기획안 §8.7(하네스는 Claude Agent SDK TypeScript를 처음부터 쓴다)과 §8.6(격리는 부탁이 아니라 설정으로)의 전제를 1회 호출로 확인한 기록이다. **M4(역할 3개 · 격리 · Stop hook) 이슈 등록의 입력**이다. `(채울 것)`은 로컬 실행 뒤 채운다. 실행 원문은 PR의 "검증 증거"에 붙인다.

실행: `pnpm --filter @plumb/core smoke` (`packages/core/src/harness/smoke.ts`)

## 1. 실행 환경

| 항목 | 값 |
|---|---|
| OS · Node | (채울 것) 예: macOS 15 · v22.x |
| `@anthropic-ai/claude-agent-sdk` | 0.3.288 (`pnpm ls --filter @plumb/core @anthropic-ai/claude-agent-sdk`) |
| 번들 Claude Code 바이너리 | optional dependency `@anthropic-ai/claude-agent-sdk-<platform>` 0.3.288 — 별도 CLI 설치 불필요. 설치됐는지: `ls node_modules/.pnpm | grep claude-agent-sdk-` → (채울 것) |
| 인증 방식 | (채울 것) 구독(`claude login` OAuth) / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`. `claude auth status` 출력: (채울 것) |
| zod peer | SDK는 `zod@^4`를 peer로 요구하고 core는 3.25.x — `pnpm install`이 "unmet peer" 경고. 스모크는 zod를 쓰는 SDK 기능(MCP 도구 정의)을 안 쓰므로 동작에 영향 없음. M4에서 core의 zod를 4로 올릴지 결정 |

## 2. 스모크 결과

| 확인 항목 | 기대 | 실제 |
|---|---|---|
| SDK 호출 성공 | `[result] {"subtype":"success", …}` · exit 0 | 클라우드: 성공(2.1). 로컬·구독: (채울 것) |
| PreToolUse hook 가로채기 | stderr `[hook] PreToolUse Read …/packages/core/package.json` 1줄 | 클라우드: 확인(2.1). 로컬: (채울 것) |
| 경로 차단 hook | 모델이 cwd 밖을 읽으려 하지 않으면 `[hook] deny` 줄 없음(정상). 있었다면 그 줄과 `permission_denials` 수 | (채울 것) |
| 권한 프롬프트 | 뜨지 않음(`allowedTools: ['Read']`) | 클라우드: 뜨지 않음. 로컬: (채울 것) |
| 비용·턴·시간 | `total_cost_usd`(추정) · `num_turns` · `duration_ms` · `usage` | (채울 것) |
| 모델 답 | `[answer] …` 한 문장 | (채울 것) |

### 2.1 클라우드 세션(Claude Code 원격 환경)에서의 실행 — 2026-10-03

세션 환경에 Claude Code용 인증(프록시)이 있어 SDK가 그것을 집어 썼다. **구독 로그인(`claude login`)으로 도는지는 이 실행이 증명하지 않는다** — 그것만 로컬에서 확인한다. 나머지(hook 가로채기 · 도구 제한 · 권한 프롬프트 없음 · 결과 필드)는 아래로 확인됐다.

```
[assistant] <tool_use Read>
[hook] PreToolUse Read /home/user/plumb/packages/core/package.json
[assistant] package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` 하나뿐입니다.
[result] {"subtype":"success","num_turns":2,"duration_ms":3754,"total_cost_usd":0.0111,"is_error":false,
          "usage":{"input_tokens":4,"cache_creation_input_tokens":2342,"cache_read_input_tokens":2194,"output_tokens":129, …},
          "permission_denials":0}
[answer] package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` 하나뿐입니다.
[smoke] wall 5102ms
```

읽은 것: Read 1회 · 권한 프롬프트 없음(`allowedTools: ['Read']`, `permissionMode: 'default'`) · cwd 밖 접근 시도 없음(`deny` 줄 없음, `permission_denials: 0`) · 턴 2 · 추정 비용 $0.011 · 벽시계 5.1초(프로세스 기동 포함).

### 2.2 로컬(macOS · 구독) 첫 실행 — 예산 초과

```
[assistant] <tool_use Read>
[hook] PreToolUse Read /Users/chan/plumb/packages/core/package.json
[smoke] 실패: Claude Code returned an error result: Reached maximum budget ($0.2)
```

- **확인됨**: 구독 인증으로 SDK가 돈다(모델이 응답하고 도구를 호출) · PreToolUse hook이 가로챈다 · `maxBudgetUsd`가 실행을 끊는다
- **원인 가설**: 같은 호출이 클라우드(기본 모델 `claude-sonnet-5-5`)에서는 $0.007~0.011. 모델을 지정하지 않아 로컬 계정의 기본 모델(더 비싼 모델 또는 생각 토큰이 많은 설정)이 쓰였을 것 — 당시 스크립트는 모델을 출력하지 않아 확정 못 함
- **SDK 동작**: 오류 결과(`error_max_budget_usd`)를 result 메시지로 보낸 뒤 **예외로도 던진다**. 하네스는 예외 경로에서도 받아 둔 result를 회수해야 한다
- **조치(같은 PR)**: `[init] model= apiKeySource=` 출력, 메시지별 `[usage]`, 예외 시에도 `[result]` 요약, 모델·예산을 `PLUMB_SMOKE_MODEL` · `PLUMB_SMOKE_BUDGET`로 덮어쓰기(기본 예산 0.5)

### 2.3 수정 후 클라우드 재실행

```
[init] model=claude-sonnet-5-5 apiKeySource=none claude_code=2.1.288 permissionMode=default tools=["Read"] budget=$0.5
[usage] in 2 · cache+ 1221 · cache↺ 973 · out 16
[hook] PreToolUse Read /home/user/plumb/packages/core/package.json
[usage] in 2 · cache+ 146 · cache↺ 2194 · out 43
[result] {"subtype":"success","num_turns":2,"total_cost_usd":0.0074, …}

$ PLUMB_SMOKE_BUDGET=0.001 pnpm --filter @plumb/core smoke     # 예외 경로
[result] {"subtype":"error_max_budget_usd","num_turns":1,"total_cost_usd":0.0059,"is_error":true}
[smoke] 예산 상한($0.001)에 걸림 — maxBudgetUsd가 실행을 끊는 것은 확인됨
exit 1
```

### 2.4 로컬 재실행 (채울 것)

```
(git pull 후 pnpm --filter @plumb/core smoke 출력 — 특히 [init] model= 줄)
```

## 3. 격리 옵션 대응표 (기획안 §8.6 세 겹 × SDK 옵션)

| 겹 | 기획안 수단 | SDK 옵션 | 확인 상태 |
|---|---|---|---|
| 컨텍스트 | 역할별 세션 · 시스템 프롬프트 · test-writer는 CLAUDE.md 미로드 | `systemPrompt: { type: 'custom' }` · `settingSources: []`(user/project/local settings와 CLAUDE.md 전부 미로드) | 타입 확인 · 스모크 사용 → 실측 (채울 것: 스모크에서 CLAUDE.md 내용이 답에 섞이지 않았는가) |
| 도구 | 도구 목록 지정 · 경로 차단 hook | `tools: ['Read']` + `allowedTools` + `disallowedTools` · `hooks.PreToolUse` → `permissionDecision: 'deny'` | 타입 확인 · 스모크 사용 → 실측 (채울 것) |
| 하위 에이전트 금지 | 생성 깊이 1 | `disallowedTools: ['Agent', 'Task']` (+ `agents` 옵션을 주지 않는다) | 타입 확인. 실제 거부는 M4 격리 시험(#24 상당)에서 |
| 파일시스템 | 역할별 worktree · OS 샌드박스(셸 명령만) | `cwd` · `sandbox?: SandboxSettings` 옵션 존재 | 타입에 있음. 내용(`allowUnsandboxedCommands`, 읽기·쓰기 경로 등)은 M4에서 실측 — **OS 샌드박스는 셸에만 적용되므로 파일 도구는 hook으로 따로 막는다(§8.6)** |
| 예산·반복 | 역할별 상한, 넘으면 실패로 끝내 검토 대기열 | `maxBudgetUsd` · `maxTurns` → 결과 `subtype: 'error_max_budget_usd' \| 'error_max_turns'` | **실측**: 로컬·클라우드 모두 `error_max_budget_usd`로 끊긴다. SDK는 이를 예외로도 던진다 → 하네스는 예외에서도 result를 회수 |

## 4. 종료 조건의 수단 (M4 #23 상당)

- `hooks.Stop`이 있다(`HookEvent`에 `'Stop'`). `SyncHookJSONOutput`에 `decision?: 'approve' | 'block'`과 `stopReason`이 있어 **종료 차단**이 가능해 보인다 — 기획안 §8.3 "종료 시점에 도는 검사 스크립트(Stop hook)가 정한다"의 수단.
- 실측은 M4에서: test-writer는 "담당 규칙마다 인수 테스트가 있고 전부 실패"일 때만 `approve`, implementer는 "전부 통과 또는 이의 제기"일 때만 `approve`. 연속 `block` 상한(`stopBlockLimit`) → 이의 제기 경로.
- (채울 것) 스모크에서 `Stop` hook을 추가로 걸어 봤다면 그 결과.

## 5. 비용 필드

- `SDKResultMessage.total_cost_usd`는 **클라이언트 측 추정**이며 청구액이 아니다(타입 주석: "An estimate, not a billing statement"). 구독에서는 기획안 §8.7대로 사용량 안전장치로만 쓴다.
- `usage`는 메인 루프만 센다(하위 에이전트 제외) — 역할당 하나의 `query()`를 띄우는 Plumb 구조에서는 문제없다.
- 스모크 1회 실제 값(클라우드): `total_cost_usd 0.0111` · 입력 4 + 캐시 생성 2342 + 캐시 읽기 2194 · 출력 129 토큰 · 2턴. 로컬·구독: (채울 것)

## 6. M4 이슈 등록에 넘길 결정·질문

1. 역할별 `cwd`를 worktree로 두고 `settingSources: []`를 켜면 컨텍스트·도구 격리는 SDK 옵션만으로 충분한가 → 스모크 결과로 판단: (채울 것)
2. 경로 차단은 두 겹: 파일 도구(Read/Write/Edit/Glob/Grep)는 PreToolUse deny, 셸(Bash)은 `sandbox` 옵션 — Bash를 아예 `disallowedTools`에 넣는 역할(test-writer)과 허용하는 역할(implementer: 테스트 실행 필요)을 나눈다
3. `permissionMode`: 역할 에이전트는 사람이 없으므로 `'default'` + `allowedTools`로 자동 허용되는지 → 클라우드 스모크에서는 프롬프트 없이 Read가 허용됐다. 목록 밖 도구를 모델이 요청할 때의 동작(거부 메시지로 돌아오는지, 멈추는지)은 M4 격리 시험에서 실측
4. 인증: 본인 머신은 구독, 배포 시 API 키(§8.7). SDK 문서는 "제3자 제품에 claude.ai 로그인 제공은 승인 없이 불가"를 명시 — 기획안과 일치. `plumb.config.json`에 인증 방식을 적지 않고 환경(`claude login` / 환경변수)에 맡긴다
5. zod 4 승격 여부(1절)
6. **역할별 `model`을 `plumb.config.json roles.*.model`로 반드시 명시**한다. 계정 기본 모델에 맡기면 같은 작업의 비용이 기기마다 수십 배 달라진다(2.2) — 현재 testbed 설정의 `"model": "default"`는 M4에서 실제 모델 ID로 바꾼다
