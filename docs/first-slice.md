# 첫 슬라이스 통과 점검 (M9, 기획안 §15.1)

요구사항 하나(`pay.refund-window`: "환불은 결제 후 7일 이내만")로 규칙 → 테스트 작성 → 구현 → 위반 주입 + 차이 탐색 → View 갱신까지 한 번 끝까지 통과시킨다. 통과 기준 다섯 항목 중 네 개는 `pnpm first-slice-check`가 판정하고(§1), 하나(④)는 사람이 화면에서 확인한다(§2). 결과는 §3에 붙인다.

## 0. 전제 (로컬 · 구독 로그인)

```bash
pnpm install && pnpm -r build
cd examples/testbed && pnpm db:up && cp -n .env.example .env; pnpm prisma:migrate && pnpm prisma:generate && cd ../..
plumb() { node packages/core/dist/cli/index.js --target examples/testbed "$@"; }
plumb rule propose --file examples/testbed/plumb/proposals/pay.refund-window.json && plumb approve pay.refund-window   # 이미 승인돼 있으면 생략
```

## 1. 자동 판정 — `pnpm first-slice-check`

| # | 기준 (§15.1) | 무엇을 보나 |
|---|---|---|
| ① | 규칙 승인을 빼면 사람 개입 없이 끝까지 돈다 | 마지막 `runs/<id>.json`이 `completed`이고 단계 1~6 전부 `finishedAt` |
| ② | 격리가 실제로 동작한다 | `isolation-test` 전부 ✅ (test-writer `src/**` 읽기 거부 · implementer `test/acceptance/**` 쓰기 거부 포함) |
| ③ | 종료 조건이 실제로 막는다 | `isolation-test` 항목 8: 틀린 구현 → Stop block → 상한 |
| ⑤ | 에이전트는 승인할 수 없다 | `curl POST /api/rules/<id>/approve`를 implementer의 **Bash 가드 규칙에 직접 넣어 deny**(정본, 네트워크 도구) · 같은 명령을 implementer 세션에 시킨 결과의 거부 로그(참고 — 모델이 도구를 안 부르면 로그가 없다) · 쿠키 없는 `fetch`는 **401**(UI 서버가 떠 있을 때; 없으면 건너뜀) |
| M7 | (M7 종료 증거) 주입이 잡히고 유효성 기록 | 마지막 실행 stage 5 `caught ≥ 1` · `injections/<rule>/` 최신 `valid: true` |

순서: `plumb run --rules pay.refund-window --detach` → `plumb runs show r-000n`이 `완료 · 단계 6`이 될 때까지 → `pnpm first-slice-check`.

## 2. 수동 체크리스트 — ④ 화면만으로 승인 → 실행 → View

`plumb ui`로 브라우저를 연 뒤 **명령어를 한 번도 치지 않고**:

- [ ] `/rules` — 잠정 규칙 `pay.refund-window`가 보이고 `[승인]`으로 승인 상태가 `승인`이 된다
- [ ] `/runs` — `[▶ 새 실행]` → 규칙 체크 → `[시작]` → `/runs?id=r-000n`으로 이동, 단계 ①~⑥이 폴링으로 ✔ 된다 (역할별 턴·비용이 오른다)
- [ ] `/runs` 상세 — 이의 제기가 있었다면 `⚠ n건`과 요지, 마지막 실행 출력 꼬리가 보인다
- [ ] `/views` — 검증 상태에서 `pay.refund-window`가 🟢(또는 #105 전이면 🟡)이고 "검사 범위 밖" 절이 있다 · 흐름도 · 변경 로그가 그려진다
- [ ] 위 과정에서 코드를 열어야 했다면 그 이유를 `plumb open`/`/api/open` 기록으로 남겼다 (기획안 §15.3)

## 3. 결과

(채울 것 — `pnpm first-slice-check` 표 전체와 마지막 줄, §2 체크 결과, 실행 비용·시간)
