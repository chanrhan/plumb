/**
 * 어댑터 패키지 로딩 (이슈 #47). 설정 `adapter: "nextjs"` → `@plumb/adapter-nextjs`를 **동적 import**해 `register()`를 부른 뒤
 * {@link resolveAdapter}로 인스턴스를 얻는다. 정적 검사 `runStaticChecks`는 `Adapter` 인터페이스 밖이라 같은 모듈에서 함께 꺼낸다.
 *
 * 코어는 어댑터 패키지를 `package.json`에 **적지 않는다**. adapter-nextjs가 core를 `dependencies`로 가지므로 core 쪽에 어떤 종류의
 * 의존(dependencies · devDependencies · optional peerDependencies)을 더해도 pnpm이 순환으로 보고 `pnpm -r build`에서 adapter-nextjs를
 * core보다 먼저 빌드한다 (core의 `dist`가 없어 adapter-nextjs의 `tsc`가 실패한다 — PR 본문). 그래서 해석은 런타임에 두 단계로 한다:
 *   1. bare 지정자 `@plumb/adapter-nextjs` (소비자 또는 전역 설치가 제공할 때)
 *   2. 모노레포 상대 경로 `packages/adapter-nextjs/dist/index.js` — 이 파일이 `packages/core/{src,dist}/adapter/`에 있다는 전제
 *      (`cli/commands/ui.ts`의 `resolveUiDir`와 같은 전제. 전역 설치는 M10)
 * 둘 다 없으면 {@link AdapterLoadError} — "빌드 먼저" 안내를 담는다.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAdapter } from './registry.js';
import type { Adapter, AdapterName, StaticRunner } from './types.js';

/** 어댑터 이름 → 패키지 이름 */
export const ADAPTER_PACKAGES: Record<AdapterName, string> = { nextjs: '@plumb/adapter-nextjs' };

export interface LoadedAdapter {
  adapter: Adapter;
  /** 어댑터 패키지의 `runStaticChecks`. 패키지가 export하지 않으면 없음 */
  staticRunner?: StaticRunner;
}

export type AdapterLoader = (name: AdapterName) => Promise<LoadedAdapter>;

/** 어댑터 패키지를 찾을 수 없거나 모양이 다르다 */
export class AdapterLoadError extends Error {
  override readonly name = 'AdapterLoadError';
  constructor(
    readonly adapterName: string,
    readonly packageName: string,
    detail: string,
  ) {
    super(`어댑터 "${adapterName}"(${packageName})을(를) 로드할 수 없다 — ${detail}`);
  }
}

/** 어댑터 패키지 모듈에서 쓰는 부분 */
interface AdapterModule {
  register?: unknown;
  runStaticChecks?: unknown;
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/** `packages/core/{src,dist}/adapter/load.*` → `packages/<이름>/dist/index.js` */
export function monorepoAdapterEntry(packageName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = packageName.replace(/^@plumb\//, '');
  return resolve(here, '..', '..', '..', dir, 'dist', 'index.js');
}

async function importAdapterModule(adapterName: string, packageName: string): Promise<AdapterModule> {
  try {
    return (await import(packageName)) as AdapterModule;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
  }
  const entry = monorepoAdapterEntry(packageName);
  if (!existsSync(entry)) {
    throw new AdapterLoadError(
      adapterName,
      packageName,
      `패키지가 설치되어 있지 않고 ${entry}도 없다. 먼저 \`pnpm --filter ${packageName} build\`를 돌린다`,
    );
  }
  return (await import(pathToFileURL(entry).href)) as AdapterModule;
}

/**
 * 설정의 `adapter` 이름으로 어댑터 패키지를 로드하고 등록한 뒤 인스턴스와 정적 검사 러너를 돌려준다.
 * 두 번 불러도 안전하다 (`register()`가 덮어쓴다).
 */
export async function loadAdapter(name: AdapterName): Promise<LoadedAdapter> {
  const packageName = ADAPTER_PACKAGES[name];
  if (packageName === undefined) {
    throw new AdapterLoadError(name, '(없음)', '알려진 어댑터가 아니다');
  }
  const mod = await importAdapterModule(name, packageName);
  if (typeof mod.register !== 'function') {
    throw new AdapterLoadError(name, packageName, '모듈이 register()를 export하지 않는다');
  }
  (mod.register as () => void)();
  const adapter = resolveAdapter(name);
  return {
    adapter,
    ...(typeof mod.runStaticChecks === 'function' ? { staticRunner: mod.runStaticChecks as StaticRunner } : {}),
  };
}
