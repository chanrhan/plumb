# 하네스 노트 — Agent SDK 스모크 (#10)

기획안 §8.7(하네스는 Claude Agent SDK TypeScript를 처음부터 쓴다)과 §8.6(격리는 부탁이 아니라 설정으로)의 전제를 1회 호출로 확인한 기록이다. **M4(역할 3개 · 격리 · Stop hook) 이슈 등록의 입력**이다. 실행 원문은 PR #74의 "검증 증거"에 있다.

실행: `pnpm --filter @plumb/core smoke` (`packages/core/src/harness/smoke.ts`)

## 1. 실행 환경

| 항목 | 값 |
|---|---|
| OS · Node | 로컬: macOS(Apple Silicon MacBook Air, `/Users/chan/plumb`) · Node 22 — SDK 샌드박스 **켜짐**(7.2). 클라우드: Linux — `bwrap`·`socat` 없어 샌드박스 **꺼짐**(7.1) |
| `@anthropic-ai/claude-agent-sdk` | 0.3.288 (`pnpm ls --filter @plumb/core @anthropic-ai/claude-agent-sdk`) |
| 번들 Claude Code 바이너리 | optional dependency `@anthropic-ai/claude-agent-sdk-<platform>` 0.3.288 — 별도 CLI 설치 불필요. 로컬·클라우드 모두 `[init] claude_code=2.1.288`로 번들이 쓰였다 |
| 인증 방식 | 로컬: 구독(`claude login` OAuth) — `[init] apiKeySource=none`(API 키 아님) 상태로 모델이 응답했다(2.4). 클라우드: 세션 프록시 인증, 역시 `apiKeySource=none` |
| zod peer | SDK는 `zod@^4`를 peer로 요구하고 core는 3.25.x — `pnpm install`이 "unmet peer" 경고. 스모크는 zod를 쓰는 SDK 기능(MCP 도구 정의)을 안 쓰므로 동작에 영향 없음. M4에서 core의 zod를 4로 올릴지 결정 |

## 2. 스모크 결과

| 확인 항목 | 기대 | 실제 |
|---|---|---|
| SDK 호출 성공 | `[result] {"subtype":"success", …}` · exit 0 | 클라우드: 성공(2.1 · 2.3 · 2.5). 로컬·구독: MCP 누수로 예산 초과(2.4) → 수정 후 **성공 · exit 0**(2.6) |
| PreToolUse hook 가로채기 | stderr `[hook] PreToolUse Read …/packages/core/package.json` 1줄 | 클라우드: 확인(2.1). 로컬: 확인(2.2 · 2.4) |
| 경로 차단 hook | 모델이 cwd 밖을 읽으려 하지 않으면 `[hook] deny` 줄 없음(정상). 있었다면 그 줄과 `permission_denials` 수 | 모든 실행에서 `deny` 줄 없음 · `permission_denials: 0`. 거부 자체의 실측은 M4 격리 시험에서 |
| 권한 프롬프트 | 뜨지 않음(`allowedTools: ['Read']`) | 클라우드·로컬 모두 뜨지 않음 |
| 비용·턴·시간 | `total_cost_usd`(추정) · `num_turns` · `duration_ms` · `usage` | 클라우드 $0.007~0.011 · 2턴 · 4~5초. 로컬(MCP 누수) $0.515 · 2턴 · 6초(2.4). 수정 후 로컬(기본 모델 fable) $0.044 · 2턴 · 2.7초(2.6) |
| MCP · 컨텍스트 누수 | `[init] tools=1 (mcp 0)` · 첫 턴 `cache+` 수천 토큰 | 클라우드: `tools=1 (mcp 0)` · cache+ 1,221~2,194. 로컬 1차: **`tools=93 (mcp 92)` · cache+ 121,925**(2.4) → 수정 후 **`tools=1 (mcp 0)` · cache+ 1,690**(2.6) |
| 모델 답 | `[answer] …` 한 문장 | 모든 실행에서 "package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` …" — 로컬 2.4도 답은 맞았고 예산만 넘겼다 |

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
- **원인 가설**: 같은 호출이 클라우드(기본 모델 `claude-sonnet-5-5`)에서는 $0.007~0.011. 모델을 지정하지 않아 로컬 계정의 기본 모델(더 비싼 모델 또는 생각 토큰이 많은 설정)이 쓰였을 것 — 당시 스크립트는 모델을 출력하지 않아 확정 못 함. **사후 확정(2.4 · 2.6)**: 주원인은 계정 MCP 커넥터 92개(×50), 부원인은 기본 모델 fable(×4)
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

### 2.4 로컬 재실행 — 모델을 맞춰도 예산 초과: 원인은 계정 MCP 커넥터

`PLUMB_SMOKE_MODEL=claude-sonnet-5-5`로 클라우드와 같은 모델을 지정했는데도 $0.5를 넘겼다. 도구 목록을 축약해 옮긴다(원문은 PR #74 "검증 증거").

```
[init] model=claude-sonnet-5-5 apiKeySource=none claude_code=2.1.288 permissionMode=default
       tools=["Read",
              "mcp__claude_ai_Claude_Docs__batch", … (Claude Docs 8개),
              "mcp__claude_ai_Figma__add_code_connect_map", … (Figma 40개),
              "mcp__claude_ai_Notion__notion-ai-search", … (Notion 44개)]   ← 도구 93개, 그중 MCP 92개
       budget=$0.5
[assistant] <tool_use Read>
[usage] in 2 · cache+ 121925 · cache↺ 0 · out 16                            ← 클라우드(2.3)는 cache+ 1221
[hook] PreToolUse Read /Users/chan/plumb/packages/core/package.json
[assistant] package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` 한 글자뿐입니다.
[usage] in 2 · cache+ 154 · cache↺ 121925 · out 45
[result] {"subtype":"error_max_budget_usd","num_turns":2,"duration_ms":6131,"total_cost_usd":0.515109,"is_error":true}
[smoke] 예산 상한($0.5)에 걸림 — maxBudgetUsd가 실행을 끊는 것은 확인됨
[smoke] 실패: Claude Code returned an error result: Reached maximum budget ($0.5)
exit 1
```

**해석.** 모델·프롬프트·턴 수가 클라우드와 같고 답도 맞았다. 다른 것은 하나 — 첫 턴 캐시 생성 토큰이 **121,925 vs 1,221**(100배). 그 차이가 `[init] tools`에 그대로 보인다: 사용자 claude.ai 계정에 연결된 **MCP 커넥터(Claude Docs · Figma · Notion) 도구 92개**가 세션에 올라왔고, 그 도구 정의만으로 컨텍스트가 12만 토큰이 됐다. 2.2의 "기본 모델이 비쌌을 것"이라는 가설은 틀렸다 — 2.2도 같은 원인이었을 가능성이 높다.

**격리 누수.** 스모크는 `settingSources: []` · `tools: ['Read']` · `allowedTools: ['Read']` · `disallowedTools: [...]`를 다 주고 있었다. 그런데도 MCP 도구가 올라왔다. 계정 수준 MCP 서버(`claude_ai_*`)는 settings 파일이 아니라 **로그인한 계정에서 오므로** `settingSources: []`의 범위 밖이고, `tools: ['Read']`는 내장 도구 목록만 제한한다. 기획안 §8.6 "격리는 부탁이 아니라 설정으로"가 **MCP에는 아직 설정되지 않은 상태**였다. 역할 에이전트(특히 test-writer)에 Notion·Figma 쓰기 도구가 들어가면 격리가 깨지고, 비용은 매 호출 수십 배가 된다.

**조치(같은 PR).** `strictMcpConfig: true`(옵션에 준 MCP 서버만 쓰고 `.mcp.json` · user settings · 플러그인의 MCP는 무시 — SDK 타입 주석) + `mcpServers: {}` + `disallowedTools`에 `'mcp__*'`(SDK 주석: "`mcp__*`는 모든 MCP 도구를 제거"). 그리고 스모크가 누수를 **스스로 감지**하도록 `[init] tools=N (mcp N)`과 첫 턴 `cache+ > 10,000` 경고를 넣었다.

### 2.5 MCP 격리 수정 후 클라우드 재실행

```
[init] model=claude-sonnet-5-5 apiKeySource=none claude_code=2.1.288 permissionMode=default tools=1 (mcp 0) ["Read"] budget=$0.5
[assistant] <tool_use Read>
[usage] in 2 · cache+ 2194 · cache↺ 0 · out 16
[hook] PreToolUse Read /home/user/plumb/packages/core/package.json
[assistant] package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` 하나뿐입니다.
[usage] in 2 · cache+ 148 · cache↺ 2194 · out 43
[result] {"subtype":"success","num_turns":2,"duration_ms":4571,"total_cost_usd":0.0111, …}
exit 0
```

클라우드에는 계정 MCP가 없으므로 이 실행은 **수정이 기존 동작을 깨지 않음**만 보인다(`tools=1 (mcp 0)` 유지, 경고 없음). 누수가 막혔는지는 2.6에서만 증명된다.

### 2.6 MCP 격리 수정 후 로컬 재실행 — 성공 (#10 완료 증거)

`PLUMB_SMOKE_MODEL` 없이(계정 기본 모델) 실행.

```
[init] model=claude-fable-5-1 apiKeySource=none claude_code=2.1.288 permissionMode=default tools=1 (mcp 0) ["Read"] budget=$0.5
[assistant] <tool_use Read>
[usage] in 2 · cache+ 1690 · cache↺ 0 · out 16                              ← 2.4의 121,925 → 1,690
[hook] PreToolUse Read /Users/chan/plumb/packages/core/package.json
[assistant] package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` 하나입니다.
[usage] in 2 · cache+ 127 · cache↺ 1690 · out 40
[result] {"subtype":"success","num_turns":2,"duration_ms":2665,"total_cost_usd":0.0443,"is_error":false,
          "usage":{"input_tokens":4,"cache_creation_input_tokens":1817,"cache_read_input_tokens":1690,"output_tokens":128,
                   "cache_creation":{"ephemeral_1h_input_tokens":1817,"ephemeral_5m_input_tokens":0}, …},
          "permission_denials":0}
[answer] package.json의 첫 줄은 JSON 객체를 여는 중괄호 `{` 하나입니다.
[smoke] wall 5238ms
exit 0
```

- **MCP 격리 확인**: 같은 머신·같은 계정에서 `tools=93 (mcp 92)` → `tools=1 (mcp 0)`. `strictMcpConfig: true` + `mcpServers: {}`(+ `disallowedTools: ['mcp__*']`)가 계정 커넥터를 **도구 목록에서 제거**한다(호출만 막는 것이 아니라 컨텍스트에서 빠진다 — 캐시 생성 토큰이 1/72). OS 수준 격리까지 갈 필요 없음.
- **기본 모델**: 로컬 계정 기본은 `claude-fable-5-1`. 토큰은 클라우드(`claude-sonnet-5-5`, 2.5)와 비슷한데(캐시 생성 1,817 vs 2,342) 비용은 $0.044 vs $0.011 — **약 4배**. 2.2의 "기본 모델이 비싸다" 가설은 부분적으로 맞았다: 2.2·2.4의 초과는 MCP 누수(×50) **와** 비싼 기본 모델(×4)이 겹친 것. 결정 6의 근거
- 모든 확인 항목(2절 표) 로컬에서 충족: 구독 인증 · hook 가로채기 · 권한 프롬프트 없음 · `permission_denials: 0` · exit 0

## 3. 격리 옵션 대응표 (기획안 §8.6 세 겹 × SDK 옵션)

| 겹 | 기획안 수단 | SDK 옵션 | 확인 상태 |
|---|---|---|---|
| 컨텍스트 | 역할별 세션 · 시스템 프롬프트 · test-writer는 CLAUDE.md 미로드 | `systemPrompt: { type: 'custom' }` · `settingSources: []`(user/project/local settings와 CLAUDE.md 전부 미로드) | **실측**: 답에 CLAUDE.md 내용이 섞이지 않았고 캐시 생성 1,221~2,194 토큰(시스템 프롬프트 + Read 정의 크기) → settings·CLAUDE.md 미로드는 동작. 단 **계정 MCP는 이 옵션 밖**(아래 MCP 행) |
| 도구 | 도구 목록 지정 · 경로 차단 hook | `tools: ['Read']` + `allowedTools` + `disallowedTools` · `hooks.PreToolUse` → `permissionDecision: 'deny'` | **실측**: 내장 도구는 Read 하나만 올라왔다(클라우드 `tools=1`). `tools:`는 **내장 도구만** 제한한다 — MCP 도구는 통과(2.4) |
| MCP 커넥터 | (기획안에 명시 없음 — §8.6 "도구 목록 지정"에 포함돼야 함) | `strictMcpConfig: true` + `mcpServers: {}` + `disallowedTools: ['mcp__*']` | **실측(2.4)**: `settingSources: []`·`tools:`만으로는 계정 커넥터 92개가 올라옴. **수정 후 로컬 `mcp 0`**(2.6) — 도구 목록에서 제거되므로 SDK 옵션으로 충분 |
| 하위 에이전트 금지 | 생성 깊이 1 | `disallowedTools: ['Agent', 'Task']` (+ `agents` 옵션을 주지 않는다) | 타입 확인. 실제 거부는 M4 격리 시험(#24 상당)에서 |
| 파일시스템 | 역할별 worktree · OS 샌드박스(셸 명령만) | `cwd` · `hooks.PreToolUse` 경로 가드(`path-guard.ts`) · 셸은 `bash-guard.ts` + `sandbox: { network.allowedDomains: [], filesystem.denyWrite }` | **실측(#77 · #79)**: Linux에서 `bwrap`·`socat`이 없으면 SDK 샌드박스가 **경고만 내고 꺼진다**(`failIfUnavailable: false`). 그 상태에서도 Write·curl 거부는 hook이 전부 잡았다 → **hook이 정본, 샌드박스는 보조**(결정 9). macOS 백엔드는 로컬 7절에서 확인 |
| 예산·반복 | 역할별 상한, 넘으면 실패로 끝내 검토 대기열 | `maxBudgetUsd` · `maxTurns` → 결과 `subtype: 'error_max_budget_usd' \| 'error_max_turns'` | **실측**: 로컬·클라우드 모두 `error_max_budget_usd`로 끊긴다. SDK는 이를 예외로도 던진다 → 하네스는 예외에서도 result를 회수 |

## 4. 종료 조건의 수단 (M4 #23 상당)

- `hooks.Stop`이 있다(`HookEvent`에 `'Stop'`). `SyncHookJSONOutput`에 `decision?: 'approve' | 'block'`과 `stopReason`이 있어 **종료 차단**이 가능해 보인다 — 기획안 §8.3 "종료 시점에 도는 검사 스크립트(Stop hook)가 정한다"의 수단.
- **실측(#78, 클라우드)**: `hooks.Stop` 콜백이 `{ decision: 'block', reason }`을 돌려주면 모델이 **멈추지 않고 계속한다**(reason을 받아 "끝낼 수 없다고 막혔다"고 보고). 두 번째 호출부터 `stop_hook_active: true`. 상한에서 `{}`를 돌려주면 그대로 끝난다. 구현: `stop.ts` — `decideStop`(순수) · `makeStopHook`(상태: `blocks` · `consecutiveBlocks` · `disputeRequired`)
- 조건: test-writer `all-fail`(담당 파일이 보고서에 있고 실행된 테스트가 전부 실패; 하나라도 통과하면 block), implementer `all-pass-or-dispute`(전부 통과 또는 **유효한** 이의 제기 파일 — 요약 ≥10자 + 근거 ≥20자, `dispute.ts`). 러너 실패는 둘 다 block. 증거는 M5 `parseJunit`에서(skipped는 분모 제외)
- 연속 `block`이 `stopBlockLimit`에 닿으면 끝내되 `state.disputeRequired`를 켠다 → 오케스트레이터(M6)가 이의 제기 · 검토 대기열로

## 5. 비용 필드

- `SDKResultMessage.total_cost_usd`는 **클라이언트 측 추정**이며 청구액이 아니다(타입 주석: "An estimate, not a billing statement"). 구독에서는 기획안 §8.7대로 사용량 안전장치로만 쓴다.
- `usage`는 메인 루프만 센다(하위 에이전트 제외) — 역할당 하나의 `query()`를 띄우는 Plumb 구조에서는 문제없다.
- 스모크 1회 실제 값(클라우드): `total_cost_usd 0.0111` · 입력 4 + 캐시 생성 2342 + 캐시 읽기 2194 · 출력 129 토큰 · 2턴. 로컬·구독(MCP 누수 상태): `0.515` · 캐시 생성 122,079 + 캐시 읽기 121,925 · 출력 61 · 2턴 — **비용은 출력이 아니라 컨텍스트 크기가 결정했다**. 하네스는 `total_cost_usd`보다 첫 턴 `cache_creation_input_tokens`를 먼저 본다

## 6. M4 이슈 등록에 넘길 결정·질문

1. 역할별 `cwd`를 worktree로 두고 `settingSources: []`를 켜면 컨텍스트·도구 격리는 SDK 옵션만으로 충분한가 → **불충분**. settings·CLAUDE.md는 막히지만 계정 MCP는 안 막힌다(2.4). 7번을 더하면 충분하다(2.6: 로컬 `mcp 0`). OS 수준 격리는 불필요
2. 경로 차단은 두 겹: 파일 도구(Read/Write/Edit/Glob/Grep)는 PreToolUse deny, 셸(Bash)은 `sandbox` 옵션 — Bash를 아예 `disallowedTools`에 넣는 역할(test-writer)과 허용하는 역할(implementer: 테스트 실행 필요)을 나눈다
3. `permissionMode`: 역할 에이전트는 사람이 없으므로 `'default'` + `allowedTools`로 자동 허용되는지 → 클라우드 스모크에서는 프롬프트 없이 Read가 허용됐다. **실측(#76 · #77)**: hook이 `deny`하면 모델에게 거부 사유가 돌아오고 모델은 멈추지 않고 보고한다. `SDKResultSuccess.permission_denials`에 집계된다(test-writer 1, implementer 2) — 오케스트레이터가 격리 위반 시도 횟수로 쓸 수 있다
4. 인증: 본인 머신은 구독, 배포 시 API 키(§8.7). SDK 문서는 "제3자 제품에 claude.ai 로그인 제공은 승인 없이 불가"를 명시 — 기획안과 일치. `plumb.config.json`에 인증 방식을 적지 않고 환경(`claude login` / 환경변수)에 맡긴다
5. zod 4 승격 여부(1절)
6. **역할별 `model`을 `plumb.config.json roles.*.model`로 반드시 명시**한다. 계정 기본 모델에 맡기면 같은 작업의 비용이 기기마다 달라진다 — 실측: 로컬 기본 `claude-fable-5-1` $0.044 vs `claude-sonnet-5-5` $0.011, 같은 토큰에 **4배**(2.6). 현재 testbed 설정의 `"model": "default"`는 M4에서 실제 모델 ID로 바꾼다
7. **모든 역할의 `query()`에 `strictMcpConfig: true` + `mcpServers: {}` + `disallowedTools: ['mcp__*']`를 고정**한다. MCP는 Plumb가 명시적으로 주는 것(있다면)만. 역할 공통부(M4 첫 이슈)에 넣고 역할별로 풀 수 없게 한다
8. 하네스는 매 실행 `[init].tools`(개수 · MCP 개수)와 첫 턴 `cache_creation_input_tokens`를 로그에 남기고, MCP > 0 또는 캐시 생성 > 기준(20,000 — 7.2)이면 **실행을 실패로 끝낸다**(경고가 아니라). §8.6 "격리가 실제로 동작하는지 첫 슬라이스에서 직접 시험"을 1회 시험이 아니라 상시 검사로 — 격리 누수는 비용으로 즉시 드러나므로 싸게 잡을 수 있다
9. **파일·셸 격리의 정본은 PreToolUse hook**(`path-guard.ts` · `bash-guard.ts`)이고 OS `sandbox`는 보조다. Linux에서 `bwrap`·`socat` 없이는 조용히 꺼지고(7.1), macOS에서는 켜지지만(7.2) 그래도 셸에만 적용되므로 샌드박스에 기대는 설계를 하지 않는다. 역할 옵션은 `failIfUnavailable: false`로 두고, 프로브·격리 시험이 `⚠ Sandbox disabled` 줄을 출력에 남긴다
10. 격리 시험(`pnpm isolation-test`)은 M4 종료 증거이자 **회귀 시험**이다 — 역할 옵션 · 가드 · Stop hook을 바꾸는 PR은 이 명령의 표를 검증 증거에 붙인다(비용 ≈ $0.03/회)
11. **(#122, 2026-10-06 승인) 실행 결과는 자동 머지하지 않는다.** ⑥ 뒤 원본 레포에 브랜치 `plumb/<run-id>`를 worktree 커밋에 만들고, 머지는 사람이 한다(git 또는 `/runs` 상세 안내). View 머리말 `commit`은 실행 커밋이고 UI는 "실행 r-nnnn 커밋(브랜치 plumb/r-nnnn) · HEAD와 다름"으로 구분해 표시한다. 기각: 자동 fast-forward(⑤ "에이전트는 승인 불가" 위배) · diff 내보내기(이력 끊김) · worktree 보존만 · GitHub PR 자동 생성(로컬 도구 원칙). 감수: 실행마다 브랜치 1개 → `plumb runs prune` 필요, 충돌은 사람 몫, 주입 커밋은 브랜치에 넣지 않는다
12. **(#123, 2026-10-06 승인) 승인 기록은 해시 체인이다.** `approvals/<ruleId>.jsonl` 각 줄에 `prev: sha256(바로 앞 줄 원문)`(첫 줄 `null`). `store.status()`는 `rulesHash` 비교에 더해 규칙마다 체인을 다시 계산해 한 줄이라도 어긋나면 `tampered`(사유 `approval-chain-broken`, 규칙 · 줄 번호). `prev` 없는 기존 줄은 체인 시작 전으로 보고 검증하지 않는다(마이그레이션 없음). 기각: 서명(키 관리) · git 커밋 해시(저장소가 git 밖) · 외부 저장 · 파일 전체 해시 하나. 감수: 한 줄 손대면 그 뒤 전부 변조 표시 → 사람이 확인한 뒤 체인을 다시 시작하는 복구 명령이 함께 필요

## 7. 격리 시험 결과 (#79, `pnpm isolation-test`)

역할 세션 3개(test-writer · implementer · stop-block)를 testbed에 실제로 띄워 8항목(+ testbed 깨끗함)을 본다. 구현: `packages/core/src/harness/isolation-test.ts`.

### 7.1 클라우드(Linux) — 2026-10-03

```
[stubs] 18 .d.ts (tsc exit 0)
[sandbox] ⚠ Sandbox disabled: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | test-writer src/** Read → deny | ✅ | [hook] deny Read src/domains/payment/refund.ts (src/** 읽기 금지) |
| 2 | test-writer Bash 없음 | ✅ | ["Edit","Glob","Grep","Read","Write"] |
| 3 | implementer test/acceptance/** Write → deny | ✅ | [hook] deny Write test/acceptance/probe.spec.ts (… 쓰기 금지) |
| 4 | implementer .git/** Write → deny | ✅ | [hook] deny Write .git/probe.txt (… 쓰기 금지) |
| 5 | implementer 네트워크(curl) → deny | ✅ | [hook] deny Bash "curl -sI https://example.com · head -1" (네트워크 도구) |
| 6 | test-writer MCP 0 · 첫 턴 캐시 < 10000 | ✅ | tools=5 (mcp 0) · cache+ 1285 |
| 6 | implementer MCP 0 · 첫 턴 캐시 < 10000 | ✅ | tools=6 (mcp 0) · cache+ 1320 |
| 7 | test-writer Agent/Task 없음 | ✅ | ["Edit","Glob","Grep","Read","Write"] |
| 7 | implementer Agent/Task 없음 | ✅ | ["Bash","Edit","Glob","Grep","Read","Write"] |
| 8 | 틀린 구현 → Stop block ≥ 1, 상한에서 disputeRequired | ✅ | [stop] block (1/2) · [stop] block (2/2) → 상한 · state={"blocks":2,"disputeRequired":true} |
| 9 | testbed에 쓰기가 남지 않음 (git status 비어 있음) | ✅ | (깨끗) |

[isolation-test] 11/11 ✅ · outcomes success / success / success · 총비용 $0.0293 · wall 23545ms
exit 0
```

클라우드에는 계정 MCP가 없으므로 항목 6은 로컬(7.2)에서만 실제 시험이 된다. 샌드박스가 꺼진 채로 11/11이 통과한 것이 결정 9의 근거다.

### 7.3 구조화 출력과 `StructuredOutput` 도구 (#90 · #88)

`outputFormat: { type: 'json_schema' }`를 주면 SDK가 내장 도구 **`StructuredOutput`**을 세션에 넣는다(`[init].tools`에 나타남). 누수 판정(결정 8)이 이를 "허용 목록 밖 도구"로 보고 injector 세션을 즉시 끊었다(격리 시험 항목 10, 1차 ❌ · `outcome: isolation-leak`). 조치: `allowedToolsOf(options)` — `outputFormat`이 있을 때만 `StructuredOutput`을 허용. 재검토(#88) · injector(#90) 두 역할이 쓴다. 재실행 12/12 ✅.

또 하나: 역할 시스템 프롬프트가 "test/**는 읽을 수 없다"고 하면 모델은 **시도조차 안 해서** 거부 로그가 안 남는다(2차 ❌ "deny 없음"). 격리 시험 프롬프트는 "시스템 프롬프트의 금지와 무관하게 반드시 도구를 호출하라"고 적어야 가드를 실제로 때린다(3차 ✅). 격리 시험은 **가드를 때리는 시험**이지 모델의 순종 시험이 아니다. 로컬(sonnet)에서는 "반드시 호출하라"도 안 먹혀 ❌가 났다 → 항목 10은 **세션에 끼워진 hook 인스턴스를 직접 호출**해 `test/**` deny · `src` 허용을 확인하고, SDK 세션으로는 도구 목록(Bash 없음)만 본다. 모델 기분에 좌우되는 항목은 두지 않는다(결정 10 보강).

### 7.2 로컬(macOS · 구독) — 11/11 ✅ (M4 종료 증거)

```
[stubs] 18 .d.ts (tsc exit 2)
[run] test-writer …
[run] implementer …
[run] stop-block …
                                            ← `⚠ Sandbox disabled` 줄 없음: macOS는 SDK 샌드박스(seatbelt)가 켜진다
| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | test-writer src/** Read → deny | ✅ | [hook] deny Read src/domains/payment/refund.ts (src/** 읽기 금지) |
| 2 | test-writer Bash 없음 | ✅ | ["Edit","Glob","Grep","Read","Write"] |
| 3 | implementer test/acceptance/** Write → deny | ✅ | [hook] deny Write test/acceptance/probe.spec.ts (… 쓰기 금지) |
| 4 | implementer .git/** Write → deny | ✅ | [hook] deny Write .git/probe.txt (… 쓰기 금지) |
| 5 | implementer 네트워크(curl) → deny | ✅ | [hook] deny Bash "curl -sI https://example.com · head -1" (네트워크 도구) |
| 6 | test-writer MCP 0 · 첫 턴 캐시 < 10000 | ✅ | tools=5 (mcp 0) · cache+ 1394 |
| 6 | implementer MCP 0 · 첫 턴 캐시 < 10000 | ✅ | tools=6 (mcp 0) · cache+ 8463 |
| 7 | test-writer Agent/Task 없음 | ✅ | ["Edit","Glob","Grep","Read","Write"] |
| 7 | implementer Agent/Task 없음 | ✅ | ["Bash","Edit","Glob","Grep","Read","Write"] |
| 8 | 틀린 구현 → Stop block ≥ 1, 상한에서 disputeRequired | ✅ | [stop] block (1/2) · [stop] block (2/2) → 상한 · state={"blocks":2,"disputeRequired":true} |
| 9 | testbed에 쓰기가 남지 않음 (git status 비어 있음) | ✅ | (깨끗) |

[isolation-test] 11/11 ✅ · outcomes success / success / success · 총비용 $0.0752 · wall 27386ms
exit 0
```

해석:
- **항목 6이 로컬에서 진짜 시험이 됐다**: 계정 커넥터 92개가 있는 머신에서 두 역할 모두 `mcp 0`. #10의 누수 수정(`strictMcpConfig`)이 역할 공통부에서도 유지된다.
- **macOS는 샌드박스가 켜진다**(`⚠` 줄 없음). 그 영향으로 implementer 첫 턴 캐시 생성이 1,320(클라우드, 꺼짐) → **8,463** — 샌드박스 안내가 시스템 프롬프트에 붙는 것으로 보인다. 누수 기준 10,000에 1.5k 차이라 거짓 양성 위험 → `CACHE_LEAK_THRESHOLD`를 **20,000**으로(정상 최대의 2.4배, 누수 121,925의 1/6). 비용도 $0.029 → $0.075로 올랐다 — 역할당 ~7k 토큰의 고정비. M6에서 샌드박스를 켤지(macOS에서만 효과) 비용과 함께 판단한다.
- `[stubs] tsc exit 2`: testbed 타입 오류(로컬에서 `prisma generate` 전이면 `PrismaClient` 타입 없음)지만 `.d.ts` 18개는 그대로 나왔다 — 선언 생성은 타입 오류에 관대하다. test-writer에는 영향 없음. 스텁 생성 전 `prisma generate`를 돌릴지는 M6 오케스트레이터에서.
- 결론: **M4 종료 증거 충족**. M4를 닫고 M6 · M7 이슈를 등록한다.

## 8. 첫 슬라이스 통과 (M9 #103)

판정 스크립트 `pnpm first-slice-check`(§15.1 ①②③⑤ + M7 종료 증거)와 수동 체크리스트 ④는 `docs/first-slice.md`. 결과 표는 그 문서 §3에, 발견은 여기에 적는다.

발견(로컬 1·2회차, 2026-10-04):
- **⑤의 세션 시도는 모델 순종에 좌우된다.** 1회차는 implementer가 `curl`을 불러 Bash 가드가 거부했고(`[hook] deny Bash "curl -s -X POST …/approve …" (네트워크 도구)`), 2회차는 같은 프롬프트에 도구를 아예 부르지 않아 거부 로그가 없었다 → ❌. 격리 시험 항목 10과 같은 문제라 같은 해법: **가드 규칙에 명령을 직접 넣은 판정을 정본**으로 하고 세션 시도는 참고 열로 남긴다. 쿠키 없는 `fetch` 401은 두 번 다 ✅.
- **`--detach` 유령 running(#115)**: 부모가 선기록한 `running`을 자식이 다른 실행으로 보고 즉시 죽어 ①·M7이 판정 불가였다. 수정은 PR #116.
- 격리 시험 로컬 12/12 두 번(비용 $0.1145 · implementer 첫 턴 캐시 8,517, 기준 20k 안). `[stubs] tsc exit 0` — `prisma generate` 뒤라 7.2의 exit 2는 사라졌다.

결과(3회차, #116 반영 뒤 — 표 전문은 `docs/first-slice.md` 3.1): **`r-0003` 완주 100초 · $0.3163**, 단계 ②(3 전부 실패) → ③(3/3 통과, Stop 차단 0) → ④ `pass-unverified` → ⑤ 주입 1 · 잡힘 1(`i-0001` valid=true, 7일 검사 제거) → ⑥ View 6개. `pnpm first-slice-check` **5/5 ✅**(①②③⑤ + M7). 역할별 비용 test-writer $0.116 · implementer $0.156 · injector $0.044.

- **M7 종료 증거 충족**: 주입이 인수 테스트 실패로 잡히고 `injections/pay.refund-window/i-0001.json`에 유효성이 기록됐다.
- 첫 슬라이스 1회 비용 ≈ $0.32 · 100초 — 예산 상한 $3의 1/10. 모델은 역할 셋 다 `claude-sonnet-5-5`.
- ④(수동, 10-06): 사용자가 화면만으로 승인 확인 → `/runs` 새 실행(`r-0004`, 01:44) → `/views` 🟢 + 주입 설명 줄 확인. **§15.1 다섯 항목 전부 ✔.** 관찰 셋(View 생성 커밋이 worktree 커밋 · 미확인 1건의 출처 · 테스트 수 편차)은 `docs/first-slice.md` 3.2 → M10 후보.
