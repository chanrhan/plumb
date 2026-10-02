import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type StorePaths, storePaths } from '../../store/index.js';
import type { DecisionDocument } from '../format.js';

/** 레포의 `examples/testbed/plumb/decisions/D-0001.md` — 첫 슬라이스 예시 (이슈 #35) */
export const EXAMPLE_DECISION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../examples/testbed/plumb/decisions/D-0001.md',
);

/** 기획안 §6.2 예시 D-0031을 이 형식으로 옮긴 것. 세션 ID는 `RunId`(`r-…`) */
export const REDIS_DECISION: DecisionDocument = {
  id: 'D-0031',
  title: '세션 저장소로 redis 도입',
  block: 'auth',
  date: '2026-09-21T00:00:00Z',
  session: 'r-118',
  decision: 'refresh 토큰 화이트리스트를 redis에 둔다',
  reason:
    'refresh 토큰 회전 규칙을 지키려면 이미 쓴 토큰을 모든 인스턴스가 공유해야 함. 만료(TTL)를 저장소가 알아서 처리해 정리 작업이 필요 없음',
  rejected: '- in-memory — 인스턴스가 둘 이상이면 회전 검증이 깨짐\n- DB 테이블 — 요청마다 조회, 만료 정리 배치 필요',
  accepted: '인프라 의존 1개 추가. redis 장애 시 로그인 불가',
  links: {
    rules: ['auth.session-store', 'auth.refresh-rotation'],
    commits: ['a1b2c3d'],
    events: [],
    packages: ['ioredis'],
    services: ['cache:redis'],
  },
};

export interface TempPaths {
  dir: string;
  paths: StorePaths;
  cleanup(): Promise<void>;
}

/** 임시 저장소 경로. 폴더는 만들지 않는다 — `writeDecision`이 필요하면 만든다 */
export async function makeTempPaths(): Promise<TempPaths> {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-decisions-'));
  const paths = storePaths({ store: join(dir, 'store') }, join(dir, 'testbed'));
  return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
