import { beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../index.js';
import {
  clearAdapters,
  listAdapters,
  NotImplementedError,
  registerAdapter,
  resolveAdapter,
  UnknownAdapterError,
} from '../index.js';

function fakeAdapter(name: Adapter['name']): Adapter {
  return {
    name,
    extractDependencies: async () => {
      throw new NotImplementedError('extractDependencies', 'test');
    },
    generateStubs: async () => {
      throw new NotImplementedError('generateStubs', 'test');
    },
    runTests: async () => {
      throw new NotImplementedError('runTests', 'test');
    },
    readSchemas: async () => {
      throw new NotImplementedError('readSchemas', 'test');
    },
    collectTraces: async () => {
      throw new NotImplementedError('collectTraces', 'test');
    },
  };
}

describe('adapter registry', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('등록한 이름으로 조회하면 팩토리가 만든 어댑터가 나온다', () => {
    let calls = 0;
    registerAdapter('nextjs', () => {
      calls += 1;
      return fakeAdapter('nextjs');
    });

    const adapter = resolveAdapter('nextjs');

    expect(adapter.name).toBe('nextjs');
    expect(calls).toBe(1);
    expect(listAdapters()).toEqual(['nextjs']);
  });

  it('조회할 때마다 팩토리를 다시 부른다 (의존성 로드를 조회 시점으로 미룬다)', () => {
    let calls = 0;
    registerAdapter('nextjs', () => {
      calls += 1;
      return fakeAdapter('nextjs');
    });

    resolveAdapter('nextjs');
    resolveAdapter('nextjs');

    expect(calls).toBe(2);
  });

  it('같은 이름을 다시 등록하면 덮어쓴다', () => {
    registerAdapter('nextjs', () => fakeAdapter('nextjs'));
    const second = fakeAdapter('nextjs');
    registerAdapter('nextjs', () => second);

    expect(resolveAdapter('nextjs')).toBe(second);
    expect(listAdapters()).toEqual(['nextjs']);
  });

  it('미등록 이름은 UnknownAdapterError — 이름과 등록 목록을 메시지에 적는다', () => {
    registerAdapter('nextjs', () => fakeAdapter('nextjs'));

    expect(() => resolveAdapter('django')).toThrowError(UnknownAdapterError);
    try {
      resolveAdapter('django');
    } catch (err) {
      const e = err as UnknownAdapterError;
      expect(e.name).toBe('UnknownAdapterError');
      expect(e.adapterName).toBe('django');
      expect(e.registered).toEqual(['nextjs']);
      expect(e.message).toContain('"django"');
      expect(e.message).toContain('"nextjs"');
    }
  });

  it('아무것도 등록되지 않았으면 "(없음)"이라고 알린다', () => {
    expect(() => resolveAdapter('nextjs')).toThrowError(/\(없음\)/);
  });

  it('빈 이름은 등록할 수 없다', () => {
    expect(() => registerAdapter('  ', () => fakeAdapter('nextjs'))).toThrowError(/비어 있을 수 없다/);
  });
});

describe('NotImplementedError', () => {
  it('메서드와 마일스톤을 보존하고 메시지에 적는다', () => {
    const err = new NotImplementedError('runTests', 'M5');

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NotImplementedError');
    expect(err.method).toBe('runTests');
    expect(err.milestone).toBe('M5');
    expect(err.message).toContain('runTests');
    expect(err.message).toContain('M5');
  });
});
