/**
 * 어댑터 등록소. 어댑터 패키지가 `registerAdapter("nextjs", factory)`로 등록하고,
 * 코어는 설정 `adapter: "nextjs"` 문자열로 {@link resolveAdapter}한다 ("어댑터는 갈아 끼운다", 기획안 §4.2).
 *
 * 프로세스 전역 Map 하나. 같은 이름을 다시 등록하면 덮어쓴다 (어댑터 패키지의 `register()`가 두 번 불려도 안전).
 */

import { UnknownAdapterError } from './errors.js';
import type { Adapter, AdapterFactory } from './types.js';

const registry = new Map<string, AdapterFactory>();

/** 어댑터를 이름으로 등록한다. 팩토리는 {@link resolveAdapter} 때마다 호출된다 */
export function registerAdapter(name: string, factory: AdapterFactory): void {
  if (name.trim() === '') {
    throw new Error('어댑터 이름은 비어 있을 수 없다');
  }
  registry.set(name, factory);
}

/** 설정의 `adapter` 문자열로 어댑터 인스턴스를 만든다. 미등록이면 {@link UnknownAdapterError} */
export function resolveAdapter(name: string): Adapter {
  const factory = registry.get(name);
  if (!factory) {
    throw new UnknownAdapterError(name, listAdapters());
  }
  return factory();
}

/** 등록된 어댑터 이름 (등록 순서) */
export function listAdapters(): string[] {
  return [...registry.keys()];
}

/** 등록을 모두 지운다. 테스트 격리용 */
export function clearAdapters(): void {
  registry.clear();
}
