import { resolve } from 'node:path';
import { loadConfig, openStore, type Store } from '@plumb/core';

/**
 * UI 서버가 보는 보호 저장소 (이슈 #33). 서버 컴포넌트와 route handler가 공유하는 싱글턴이다 — 코어를 import하는 두 입구 중
 * 하나 (`docs/screens/README.md` 3.1). `#34`의 `/api/rules/**` 도 여기 {@link getStore}를 import한다.
 */

let cached: Promise<Store> | undefined;

/**
 * 대상 루트 (절대 경로). `plumb ui`가 넘긴 `PLUMB_TARGET`, 없으면(개발 중 `next dev`를 직접 띄운 경우) `process.cwd()`.
 * 상단 바의 프로젝트 이름과 저장소 위치가 여기서 결정된다.
 */
export function getTarget(): string {
  const target = process.env.PLUMB_TARGET;
  return resolve(target !== undefined && target.length > 0 ? target : process.cwd());
}

/**
 * `plumb.config.json`을 읽어 저장소를 연다. 처음 부를 때 한 번만 열고 모듈 스코프에 캐시한다 (실패는 캐시하지 않는다).
 *
 * 저장소가 아직 없으면 `init()`으로 빈 저장소(`rules.yaml: []`)를 만든다 — `initStore`는 멱등이라 있는 것은 건드리지 않는다.
 * 설정 오류는 `@plumb/core`의 `ConfigError` 계열로 그대로 던진다. 호출자(layout · route handler)가 메시지를 정한다.
 */
export function getStore(): Promise<Store> {
  if (cached === undefined) {
    const opening = loadConfig({ target: getTarget() }).then(async ({ config, root }) => {
      const store = openStore(config, root);
      await store.init();
      return store;
    });
    cached = opening;
    opening.catch(() => {
      if (cached === opening) cached = undefined;
    });
  }
  return cached;
}
