# View — 외부 의존성 (`/views?view=dependencies`)

이슈 #3의 산출물. `docs/screens/README.md`의 공통 레이아웃, 출처 표기 규칙 2.1, 코드 열람 점프 2.2를 전제로 한다. 출처 접두어 사용 기준과 가정하는 testbed는 `view-architecture.md` 머리에 있다. 와이어프레임 안의 값은 파서가 그 입력에서 뽑는 모양의 예시다.

## 1. 답하는 질문

"무엇에 기대고 있나" (README 1 표). 구체적으로:

- **패키지**: 어떤 외부 패키지를, 어떤 버전으로, 직접인지 간접인지. 어느 블록이 import하나. 설치만 되고 아무도 import하지 않는 것은 무엇인가
- **서비스**: DB · 캐시 · 큐 · 외부 API 중 설정에 잡히는 것은 무엇이고 어느 블록이 쓰나
- **변화**: 언제 어떤 의존성이 들어오고 나갔나. 그 결정은 기록돼 있나 (없으면 "사유 없음")
- **제약과의 연결**: "세션 저장소는 redis" 같은 기술 제약 규칙이 실제 의존성과 맞물려 있나, 그 규칙의 검사 상태는 무엇인가

## 2. 와이어프레임

```
┌ View 보기 ─ 아키텍처 · 흐름도 · 변경 로그 · 검증 · [의존성] · 계약 ──────────────────────────────┐
│ 필터: 전체 ▾    생성: a1b2c3 · 2분 전 · pnpm-lock v9 · dependency-cruiser · 설정 파일 3개           │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 직접 11 (prod 7 · dev 4) · 간접 183 · import 없는 직접 1 ▲ · 서비스 3 · 큐 없음 · 최근 30일 이벤트 2 (사유 없음 1) │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ 외부 서비스 (파서: 설정 파일 · 환경변수 이름)                                                    │
│   종류     이름        근거                                             클라이언트       쓰는 블록      제약 규칙       │
│   DB      PostgreSQL  docker-compose.yml:3 · schema.prisma:2 · DATABASE_URL   @prisma/client   payment, auth   —            │
│   캐시    Redis       docker-compose.yml:9 · REDIS_URL                       ioredis          auth            auth.session-store 🔴 │
│   외부API (이름 없음)  .env.example:4 PG_GATEWAY_URL                           (fetch)          payment         —            │
│   큐      감지된 설정 없음                                                                                                   │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ 외부 패키지 (파서: lockfile + import 분석)   [직접만] [전체]   정렬: 블록 ▾                        │
│   패키지              버전     종류        import 블록            제약 규칙                        │
│   next               15.1.0   직접·prod   app                     —                              │
│   @prisma/client     5.22.0   직접·prod   payment, auth           —                              │
│   ioredis            5.4.1    직접·prod   auth                    auth.session-store 🔴           │
│   zod                3.23.8   직접·prod   payment, auth, app      —                              │
│   date-fns           4.1.0    직접·prod   payment                 —                              │
│   lodash             4.17.21  직접·prod   (import 없음) ▲          —                              │
│   vitest             2.1.0    직접·dev    test/                   —                              │
│   fast-check         3.23.0   직접·dev    test/                   —                              │
│   dependency-cruiser 16.5.0   직접·dev    (설정 파일만)            —                              │
│   … 간접 183 [펼치기]                                                                            │
│                                                                                              │
│   선택: ioredis 5.4.1                                                                         │
│     lockfile   pnpm-lock.yaml:88  importers['.'].dependencies.ioredis  specifier ^5.4.0 → 5.4.1  [IDE에서 열기] │
│     import     src/domains/auth/session-store.ts:1   import Redis from 'ioredis'                 [IDE에서 열기] │
│     간접 의존   7개 (denque, redis-parser, …)                                                    │
│     도입       git 3c4d5e (12일 전) "feat: redis session" · 결정 기록 D-0004 ✔                      │
│     제약 규칙   auth.session-store "세션 저장소는 redis여야 한다"  🔴 실패 → 검증 View                │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ 의존성 이벤트 (git: lockfile diff)   최근 30일                                                 │
│   커밋      시각      변화                               결정 기록                                 │
│   a1b2c3   2분 전    + date-fns 4.1.0 (직접)             사유 없음 ⚠  → 변경 로그 View              │
│   3c4d5e   12일 전   + ioredis 5.4.1 (직접) · + 간접 7     D-0004 "세션 저장소를 redis로"             │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

출처: `파서: lockfile` (패키지 · 버전 · 직접/간접) · `파서: import 분석` (import하는 블록 · import 없는 패키지) · `파서: 설정 파일·환경변수 이름` (외부 서비스) · `git: lockfile diff` (이벤트) · `저장소: 결정 기록` (사유 유무) · `저장소: 규칙` + `실행: plumb check` (제약 규칙과 상태). 항목별 상세는 3절.

이 View는 "무엇에 기대고 있나"에 답하는 **현재 상태** 화면이다. 이벤트 절은 변경 로그 View(#4)의 의존성 부분집합이고, 사유 본문은 거기서 읽는다.

## 3. 항목 표

| 항목 | 출처 | 생성 방식 (어느 파서의 어느 필드) | 도입 마일스톤 | 비고 |
|---|---|---|---|---|
| 직접 패키지 (이름 · 버전 · prod/dev) | 파서: lockfile (`pnpm-lock.yaml`) | `importers['.'].dependencies` · `devDependencies` 의 `specifier` · `version` | M8 wave 0 | pnpm v9 형식. npm·yarn은 M10 |
| 간접 패키지 (이름 · 버전 · 수) | 파서: lockfile | `packages` 키 중 직접이 아닌 것. `snapshots[].dependencies` 로 트리 복원 | M8 wave 0 | 기본 접힘. 수만 요약 띠에 |
| 패키지를 import하는 블록 | 파서: import 분석 (dependency-cruiser JSON) | `modules[].dependencies[]` 중 `dependencyTypes` 에 `npm*` 이 있는 것의 `module`(패키지 이름)과 출발 파일의 블록 | M8 wave 0 | 아키텍처 View와 같은 블록 그래프 JSON. 테스트 파일은 `test/` 로 묶는다 |
| import 없는 직접 패키지 ▲ | 파서: lockfile − 파서: import 분석 | 직접 패키지 집합에서 import 분석에 한 번도 안 나타난 이름 | M8 wave 0 | 설정 파일에서만 쓰는 도구(`dependency-cruiser` 등)는 "(설정 파일만)" — `.dependency-cruiser.cjs`·`vitest.config.ts`가 모듈 목록에 있으면 구분 가능. 없으면 ▲로 둔다 |
| 패키지 `file:line` (lockfile · import 문) | 파서: lockfile (YAML 위치 정보) + 파서: import 분석 | lockfile 엔트리의 줄 · `modules[].dependencies[]` 의 import 문 줄 | M8 wave 0 | dependency-cruiser는 import 문 줄을 주지 않는다 → 어댑터가 파일에서 `from '<이름>'` 을 찾아 줄을 붙인다 |
| 외부 서비스 (종류 · 이름 · 근거) | 파서: 설정 파일 · 환경변수 이름 (`docker-compose.yml`, `prisma/schema.prisma`, `.env.example`) | compose `services.<이름>.image` 의 알려진 이미지 → 종류(DB·캐시·큐); Prisma DMMF `datasources[].provider`; `.env.example` 의 `*_URL` · `*_HOST` · `*_API_KEY` 이름. **값은 읽지 않는다** | M8 wave 0 | 아키텍처 View L0 노드와 같은 파서. 큐가 없으면 "감지된 설정 없음" 행 |
| 서비스의 클라이언트 패키지 · 쓰는 블록 | 파서: import 분석 + 어댑터 내장 매핑표 | 매핑표 `{ "@prisma/client": "db", "ioredis": "cache", "amqplib": "queue", … }` 로 패키지 → 서비스 종류. 그 패키지를 import하는 블록 | M8 wave 0 | 매핑표는 어댑터 코드(파서 결과의 일부). 외부 API는 환경변수 이름 참조 스캔(아키텍처 View 6절 4번) |
| 의존성 이벤트 (커밋 · 시각 · 추가/제거/버전 변경) | git: lockfile diff | 커밋마다 `git show <c> -- pnpm-lock.yaml` 의 `importers` 변화 → 직접 추가·제거·버전 변경. 간접 수는 합계만 | M8 wave 1 | 변경 로그 View(#4)의 "diff 이벤트 감지"와 같은 코드 |
| 이벤트의 결정 기록 유무 (D-xxxx / 사유 없음 ⚠) | 저장소: 결정 기록 | 결정 기록 본문의 `refs.packages[]` 또는 본문에 패키지 이름이 있는 `D-xxxx`. 없으면 "사유 없음" | M3 (결정 기록 형식) · M8 wave 1 | 이름 문자열 일치는 약하다. `refs` 필드로 명시하는 안은 6절 |
| 제약 규칙과의 연결 (규칙 ID + 상태) | 저장소: 규칙 YAML `constraint.targets` + 실행: plumb check 상태 | 규칙의 `constraint.targets: [{ kind: "package", name: "ioredis" }, { kind: "service", type: "cache" }]` 와 이름 일치. 상태는 검증 View와 같은 계산 | M3 (규칙 스키마) · M5 (상태) · M8 wave 0 | 필드 이름은 #5 결정. 규칙이 없으면 "—" |
| 요약 띠 | 파서: lockfile + import 분석 + 설정 파일 · git: lockfile diff · 저장소: 결정 기록 | 위 항목의 합 | M8 wave 0 | "최근 30일"은 기본값. 기간은 4절 |
| 생성 커밋 · 시각 · 파서 버전 | 파서: View 생성 헤더 | `generatedAt`, `commit`, lockfile 버전, dependency-cruiser 버전 | M8 wave 0 | |
| 블록 필터 | 사용자 입력: 블록 트리 선택 | 4절 | M8 wave 2 | |
| [IDE에서 열기] | 사용자 입력: 이유 선택 → `plumb open` | README 2.2 | M8 wave 2 | |

이 View에 **넣지 않는** 것과 이유: 라이선스(lockfile에 없다. `node_modules/*/package.json`을 읽는 파서는 M10), 취약점(외부 DB 조회가 필요하다. `파서:`도 `실행:`도 아니다), "업그레이드 권장"(판정이다).

## 4. 동작

- **블록 필터**: `auth`를 누르면 패키지 표는 `auth`가 import하는 것만, 서비스 표는 쓰는 블록에 `auth`가 있는 것만 남는다. "import 없는 직접 패키지"와 요약 띠는 전체 값 유지 (어느 블록에도 안 속하므로 필터로 사라지면 안 된다). 이벤트 절은 필터와 무관
- **[직접만] / [전체]**: 기본 직접만. 전체는 간접 183개를 트리로 펼친다(`snapshots` 기준). 깊이 2까지 기본 펼침
- **정렬**: 블록 · 이름 · 도입 시각(이벤트 절의 최초 추가 커밋)
- **패키지 클릭**: lockfile 엔트리 · import 문 목록 · 간접 의존 · 도입 커밋 · 결정 기록 · 제약 규칙
- **서비스 클릭**: 근거 파일 목록(`docker-compose.yml:9` 등) · 클라이언트 패키지 · 쓰는 블록. 아키텍처 View L0 선택 패널과 같은 내용
- **`file:line` 점프 위치**: lockfile 행 · import 문 행 · 서비스 근거 행(compose · schema.prisma · .env.example). 결정 기록 D-xxxx는 변경 로그 View 링크, 제약 규칙은 검증 View 링크 — IDE를 열지 않는다
- **이벤트 기간**: 기본 30일. `&since=<commit|날짜>` 로 바꾼다. "사유 없음 ⚠"만 보기 토글
- **수준 전환**: 없다. 서비스 절이 L0, 패키지 절이 L1 블록 단위다

## 5. 비어 있을 때

| 상황 | 화면 |
|---|---|
| lockfile 없음 | 패키지 절: "lockfile 없음 (`pnpm-lock.yaml`)". `package.json`만으로 버전을 추정하지 않는다 (specifier는 범위이지 버전이 아니다) |
| lockfile 형식 미지원 (npm · yarn · pnpm v6) | "지원하지 않는 lockfile: <형식/버전>" + 파일 경로. 빈 표를 그리지 않는다 |
| import 분석 결과 없음 (`plumb views` 미실행 또는 dependency-cruiser 실패) | 패키지 표는 lockfile만으로 그리고 "import 블록" 열 전체가 "분석 없음". "import 없는 직접 패키지"는 계산 불가 → 요약 띠에 "▲ ?" |
| 설정 파일 없음 (compose · prisma · .env.example 모두) | 서비스 절: "감지된 설정 없음". 패키지(`@prisma/client` 등)에서 서비스를 역추정하지 않는다 |
| git 없음 | 이벤트 절 "git 이력 없음" |
| 결정 기록 없음 (M3 전 또는 빈 저장소) | 이벤트의 결정 기록 열이 모두 "사유 없음 ⚠". 숨기지 않는다 |
| 규칙 없음 | 제약 규칙 열 "—". `plumb check` 미실행이면 규칙은 있되 상태 ⬜ |

## 6. 열린 질문 (#5 타입 설계로 넘김)

1. **규칙 ↔ 의존성 연결 필드.** 규칙 YAML(§5.2)에 `constraint.targets[]`(package · service)를 두는 안. 없으면 이 View의 "제약 규칙" 열은 규칙 본문 문자열 검색이 되고, 그건 추정이라 넣을 수 없다
2. **결정 기록 ↔ 패키지 연결.** `D-xxxx`에 `refs.packages[]` · `refs.services[]` 를 두는 안. 본문 문자열 일치만으로 "사유 있음"을 판정하면 오탐이 난다
3. **패키지 → 서비스 매핑표의 위치.** 어댑터 내장(`adapter-nextjs`)인가 `plumb.config.json services[].clientPackages` 인가. 내장 + 재정의가 무난하지만 타입이 둘 다 필요
4. **`test/` 를 블록으로 볼지.** dev 의존성의 "import 블록"이 전부 `test/`이면 블록 그래프에 `test` 블록이 있어야 한다. 아키텍처 View 6절 6번(`app/`)과 같은 결정
5. **View 타입 초안.** `DependenciesView { generatedAt, commit, lockfile: { path, format, version }, packages: [{ name, version, specifier?, direct: boolean, scope: "prod"|"dev", importedBy: string[], importSites: [{ file, line }], lockfileLine, unused: boolean, rules: string[] }], services: [{ kind: "db"|"cache"|"queue"|"external-api", name?, evidence: [{ file, line, excerpt }], clientPackages: string[], usedBy: string[], rules: string[] }], events: [{ commit, at, changes: [{ name, kind: "added"|"removed"|"changed", from?, to?, direct }], decision?: string }] }`
