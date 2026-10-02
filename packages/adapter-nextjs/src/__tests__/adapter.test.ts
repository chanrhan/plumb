import {
  ADAPTER_METHODS,
  type Adapter,
  type AdapterContext,
  clearAdapters,
  NotImplementedError,
  resolveAdapter,
} from '@plumb/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADAPTER_NAME, nextjsAdapter, register } from '../index.js';

const ctx: AdapterContext = {
  root: '/tmp/plumb-target',
  config: {
    service: 'testbed',
    adapter: 'nextjs',
    roles: {
      'test-writer': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
      implementer: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
      injector: { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
      'rule-drafter': { model: 'x', maxTurns: 1, maxBudgetUsd: 1 },
    },
    stopBlockLimit: 3,
  },
};

/** 다섯 메서드를 같은 방식으로 부른다 (인자 모양은 Adapter 인터페이스 그대로) */
const calls: Record<(typeof ADAPTER_METHODS)[number], (a: Adapter) => Promise<unknown>> = {
  extractDependencies: (a) => a.extractDependencies(ctx),
  generateStubs: (a) => a.generateStubs(ctx, '/tmp/plumb-target/.work/test-writer'),
  runTests: (a) => a.runTests(ctx, {}),
  readSchemas: (a) => a.readSchemas(ctx),
  collectTraces: (a) => a.collectTraces(ctx, {}),
};

const expectedMilestone: Record<(typeof ADAPTER_METHODS)[number], string> = {
  extractDependencies: 'done',
  generateStubs: 'M4',
  runTests: 'done',
  readSchemas: 'done',
  collectTraces: 'done',
};

/** 구현된 메서드. 실제 동작은 `run-tests.test.ts`(#44) · `extract-dependencies.test.ts`(#45) · `read-schemas.test.ts`(#55) · `flow-collect-traces.test.ts`(#59)가 testbed로 검증한다 */
const IMPLEMENTED: ReadonlyArray<(typeof ADAPTER_METHODS)[number]> = [
  'runTests',
  'extractDependencies',
  'readSchemas',
  'collectTraces',
];
const NOT_IMPLEMENTED = ADAPTER_METHODS.filter((method) => !IMPLEMENTED.includes(method));

describe('@plumb/adapter-nextjs — Adapter 인터페이스 준수', () => {
  it('이름이 "nextjs"다', () => {
    expect(ADAPTER_NAME).toBe('nextjs');
    expect(nextjsAdapter.name).toBe('nextjs');
  });

  it('다섯 메서드가 모두 함수로 존재한다', () => {
    expect(ADAPTER_METHODS).toHaveLength(5);
    for (const method of ADAPTER_METHODS) {
      expect(typeof nextjsAdapter[method], method).toBe('function');
    }
  });

  it.each(NOT_IMPLEMENTED)('%s 은(는) 예정 마일스톤을 적은 NotImplementedError를 던진다', async (method) => {
    const promise = calls[method](nextjsAdapter);

    await expect(promise).rejects.toBeInstanceOf(NotImplementedError);
    await expect(promise).rejects.toMatchObject({
      name: 'NotImplementedError',
      method,
      milestone: expectedMilestone[method],
    });
  });
});

describe('@plumb/adapter-nextjs — 등록', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('register() 뒤에 설정 문자열 "nextjs"로 코어가 찾는다', () => {
    expect(() => resolveAdapter('nextjs')).toThrowError(/등록되어 있지 않다/);

    register();

    expect(resolveAdapter(ctx.config.adapter)).toBe(nextjsAdapter);
  });

  it('register()를 두 번 불러도 같은 어댑터 하나다', () => {
    register();
    register();

    expect(resolveAdapter('nextjs')).toBe(nextjsAdapter);
  });
});
