import type { AdapterMethod } from './types.js';

/**
 * 어댑터 메서드가 아직 구현되지 않았다. 뼈대 단계(#8)의 모든 메서드가 이것을 던진다.
 * `milestone`은 구현이 예정된 마일스톤 (`docs/ROADMAP.md`: M4 generateStubs · M5 runTests · M8 나머지).
 */
export class NotImplementedError extends Error {
  readonly method: AdapterMethod;
  readonly milestone: string;

  constructor(method: AdapterMethod, milestone: string) {
    super(`Adapter.${method}()는 아직 구현되지 않았다 (구현 예정: ${milestone})`);
    this.name = 'NotImplementedError';
    this.method = method;
    this.milestone = milestone;
  }
}

/** 설정 `adapter` 이름으로 등록된 어댑터가 없다 */
export class UnknownAdapterError extends Error {
  readonly adapterName: string;
  readonly registered: string[];

  constructor(adapterName: string, registered: string[]) {
    const known = registered.length > 0 ? registered.map((n) => `"${n}"`).join(', ') : '(없음)';
    super(
      `어댑터 "${adapterName}"이(가) 등록되어 있지 않다. 등록된 어댑터: ${known}. ` +
        '어댑터 패키지의 register()를 먼저 호출했는지, plumb.config.json의 adapter 값이 맞는지 확인한다',
    );
    this.name = 'UnknownAdapterError';
    this.adapterName = adapterName;
    this.registered = registered;
  }
}
