/**
 * `ViewContext` 조립 (이슈 #60). `plumb views` · `plumb check --views` · UI 재생성이 같은 묶음을 만든다 —
 * `cli/commands/check.ts`가 어댑터를 로드하는 방식(`adapter/load.ts`의 `loadAdapter`, 테스트는 가짜 주입)과 같다.
 *
 * - `root`는 어댑터 컨텍스트와 같은 **서비스 루트** `resolve(대상 루트, config.service)` (`runCheck`와 같은 규칙)
 * - `commit`은 `git rev-parse HEAD`. git이 없거나 실패하면 `undefined` → 머리말에 `commit` 없음 ("생성 커밋 기록 없음")
 */

import { resolve } from 'node:path';
import { type AdapterLoader, loadAdapter as defaultLoadAdapter, type LoadedAdapter } from '../adapter/load.js';
import { gitHead } from '../checks/run-check.js';
import type { Store } from '../store/index.js';
import type { PlumbConfig } from '../types/index.js';
import type { ViewContext } from './types.js';

export interface BuildViewContextOptions {
  config: PlumbConfig;
  /** 대상 루트 (`plumb.config.json`이 있는 폴더, 절대 경로) */
  root: string;
  store: Store;
  /** 어댑터 로더. 기본 `loadAdapter`(동적 import). 테스트는 가짜를 넣는다 */
  loadAdapter?: AdapterLoader;
  /** 이미 로드한 어댑터 (`plumb check --views`가 검사에 쓴 것을 그대로 넘긴다). 있으면 `loadAdapter`를 부르지 않는다 */
  loaded?: LoadedAdapter;
  /** 생성 시각. 테스트가 바꾼다 */
  now?: () => Date;
  /** HEAD 해석. 기본 `gitHead` (`git rev-parse HEAD`, 실패하면 `'unknown'`) */
  resolveCommit?: (serviceRoot: string) => Promise<string>;
}

/** 서비스 루트 = 어댑터 컨텍스트의 `root` */
export function serviceRootOf(root: string, config: Pick<PlumbConfig, 'service'>): string {
  return resolve(root, config.service);
}

export async function buildViewContext(options: BuildViewContextOptions): Promise<ViewContext> {
  const loaded = options.loaded ?? (await (options.loadAdapter ?? defaultLoadAdapter)(options.config.adapter));
  const root = serviceRootOf(options.root, options.config);
  const head = await (options.resolveCommit ?? gitHead)(root);
  const commit = /^[0-9a-f]{7,40}$/.test(head) ? head : undefined;
  return {
    root,
    config: options.config,
    store: options.store,
    adapter: loaded.adapter,
    commit,
    now: options.now ?? (() => new Date()),
    ...(loaded.staticRunner === undefined ? {} : { staticRunner: loaded.staticRunner }),
  };
}
