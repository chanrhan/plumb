# plumb 작업공간

Plumb 프로토타입과 그 대상 서비스를 함께 키우는 작업공간. 세 폴더는 각각 별도 git 레포다.

| 폴더 | 내용 |
|---|---|
| `service/` | 대상 서비스(내뇌학습). Next.js + PostgreSQL + Prisma. 개발자는 이 코드를 직접 보지 않는 것이 목표 |
| `plumb/` | 도구. TypeScript 모노레포(`packages/core`, `packages/adapter-nextjs`), CLI `plumb` |
| `plumb-store/` | 보호 저장소. 규칙·승인·검사 결과·View. `plumb` CLI만 쓴다 |
| `.work/` | 역할 에이전트의 임시 작업 디렉토리 |

- 설정: `plumb.config.json`
- 코드 열람 기록: `code-open-log.md`
- View: `plumb-store/views/*.md` (`plumb views`로 생성)
