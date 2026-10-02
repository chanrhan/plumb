# @plumb/testbed

Plumb의 시험용 Next.js 프로젝트다. Plumb이 실제 서비스 코드 위에서 동작하는지 확인하는 용도이며, **개발자는 이 코드를 직접 읽지 않는 것이 목표**다(기획안 §15). 사람은 Plumb의 화면(규칙·계약·검증 상태)만 보고, 코드는 에이전트가 만든다.

스택: Next.js 15 + PostgreSQL 16 + Prisma 6. Vitest · fast-check · dependency-cruiser(#21), OpenAPI 계약과 Route Handler(#20), payment 도메인 로직과 Prisma 모델(#19)은 이어지는 이슈에서 채운다.

## 구조 지침 (기획안 §4.4)

| 항목 | 지침 | 이유 |
|---|---|---|
| 스택 | Next.js + PostgreSQL + Prisma + Vitest + fast-check + Playwright + dependency-cruiser + OpenTelemetry | 첫 어댑터 대상. 흔한 조합 하나를 끝까지 지원한다 |
| 블록 | 비즈니스 로직은 `src/domains/<도메인>/`에 둔다. `app/`은 얇게 유지한다 | `app/`은 URL 경로 기준이라 도메인 경계와 맞지 않는다 |
| 공개 진입점 | `app/`과 다른 도메인은 `src/domains/<도메인>/index.ts`만 import한다. 의존 규칙(dependency-cruiser, #21)으로 강제한다 | 경계는 부탁이 아니라 설정으로 |
| 계약 | 외부에 노출하는 것은 Route Handler + OpenAPI(`openapi.yaml`)로 통일한다. Server Actions는 쓰지 않거나 내부용으로만 | 계약이 표준 포맷으로 레포 안에 있어야 검사할 수 있다 |
| 트레이스 | `instrumentation.ts`로 OpenTelemetry 설정 (M8 spike. 아직 없음) | 실행 결과를 흐름 View로 보여 주기 위해 |

```
examples/testbed/
├── src/
│   ├── app/                 # 얇게. 도메인 공개 진입점만 import
│   │   ├── layout.tsx
│   │   └── page.tsx
│   └── domains/
│       ├── payment/index.ts # 공개 진입점 (#19에서 createPayment, refund export)
│       └── auth/index.ts    # 공개 진입점
├── prisma/schema.prisma     # datasource·generator. 모델은 #19
├── prisma.config.ts         # .env 로드 + DATABASE_URL 기본값 (DB 없이 prisma validate가 돌게)
├── scripts/db-local.sh      # Docker 없는 환경용 로컬 Postgres
├── docker-compose.yml       # Docker 있는 환경용 Postgres
└── .env.example             # DATABASE_URL
```

## DB 띄우기

둘 중 하나. 둘 다 `postgresql://postgres:postgres@localhost:5432/testbed`로 붙는다(`.env.example` 참고. `cp .env.example .env`).

### 1. Docker가 있을 때 — docker compose

```
pnpm --filter @plumb/testbed db:up     # postgres:16 컨테이너, 포트 5432, 볼륨 pgdata
pnpm --filter @plumb/testbed db:down
```

### 2. Docker가 없을 때 — scripts/db-local.sh

PostgreSQL 바이너리(`/usr/lib/postgresql/16/bin`, 없으면 `/usr/lib/postgresql/*/bin` 중 마지막, 없으면 PATH의 `pg_ctl`)로 `examples/testbed/.pgdata/`에 클러스터를 만든다. 소켓 디렉토리는 `.pgdata/run`(기본 `/var/run/postgresql`의 권한 문제 회피).

```
pnpm --filter @plumb/testbed db:local init     # initdb + 사용자 postgres/postgres + DB testbed
pnpm --filter @plumb/testbed db:local start    # 초기화 안 됐으면 init부터
pnpm --filter @plumb/testbed db:local status
pnpm --filter @plumb/testbed db:local stop
```

root로 실행하면 PostgreSQL의 `initdb`·`postgres`가 거부하므로, 스크립트가 시스템 `postgres` 사용자(또는 `$SUDO_USER`)로 전환해 다시 실행한다. 전환할 사용자가 없으면 안내 메시지와 함께 실패한다. `.pgdata/`는 git에 올라가지 않는다.

## 확인 명령

```
pnpm --filter @plumb/testbed typecheck
pnpm --filter @plumb/testbed exec prisma validate
pnpm --filter @plumb/testbed build
```
