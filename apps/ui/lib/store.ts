/**
 * 보호 저장소 싱글턴 (이슈 #33의 파일 — #34 브랜치에는 없어서 같은 시그니처로 최소 구현. 오케스트레이터가 병합한다).
 *
 * `PLUMB_TARGET`(없으면 cwd) → `loadConfig` → `openStore`. 서버 컴포넌트와 route handler가 같은 Store를 공유한다
 * (screens/README 3.1: UI 서버는 코어를 import하는 입구, 데몬 없음). 파일은 만들지 않는다 — `init()`은 CLI(#32)의 몫.
 */

import { resolve } from 'node:path';
import { loadConfig, openStore, type Store } from '@plumb/core';

/** 대상 레포 루트 (절대 경로). `plumb ui`가 `PLUMB_TARGET`으로 넘긴다 */
export function getTarget(): string {
  return resolve(process.env.PLUMB_TARGET ?? process.cwd());
}

let cached: { target: string; store: Promise<Store> } | undefined;

export function getStore(): Promise<Store> {
  const target = getTarget();
  if (cached === undefined || cached.target !== target) {
    const store = loadConfig({ target }).then(({ config, root }) =>
      openStore({ ...config, store: process.env.PLUMB_STORE ?? config.store }, root),
    );
    cached = { target, store };
    store.catch(() => {
      if (cached?.store === store) cached = undefined;
    });
  }
  return cached.store;
}
