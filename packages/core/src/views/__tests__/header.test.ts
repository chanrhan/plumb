import { describe, expect, it } from 'vitest';
import type { SourceRef } from '../../types/index.js';
import { makeHeader, source } from '../index.js';

const NOW = new Date('2026-10-02T09:00:00.000Z');

describe('makeHeader', () => {
  it('view · generatedAt(ISO) · commit · sources', () => {
    const sources = [source.parser('dependency-cruiser', '18.5', 'src'), source.git('a1b2c3d4e5f6a7b8')];
    const header = makeHeader('architecture', { commit: 'a1b2c3d4e5f6a7b8', now: NOW, sources });

    expect(header).toEqual({
      view: 'architecture',
      generatedAt: '2026-10-02T09:00:00.000Z',
      commit: 'a1b2c3d4e5f6a7b8',
      sources: [
        { kind: 'parser', tool: 'dependency-cruiser', version: '18.5', input: 'src' },
        { kind: 'git', commit: 'a1b2c3d4e5f6a7b8' },
      ],
    });
    // 타입 수준: view 리터럴이 유지된다
    const name: 'architecture' = header.view;
    expect(name).toBe('architecture');
  });

  it('commit이 없으면 키 자체가 없다 (JSON에 undefined가 남지 않는다)', () => {
    const header = makeHeader('flow', { now: NOW, sources: [] });
    expect(header).toEqual({ view: 'flow', generatedAt: '2026-10-02T09:00:00.000Z', sources: [] });
    expect(Object.keys(header)).toEqual(['view', 'generatedAt', 'sources']);
    expect(JSON.parse(JSON.stringify(header))).toEqual(header);

    expect(makeHeader('flow', { commit: '', now: NOW, sources: [] })).not.toHaveProperty('commit');
  });

  it('sources는 복사된다 — 호출자가 배열을 바꿔도 머리말은 그대로', () => {
    const sources: SourceRef[] = [source.store('rules.yaml')];
    const header = makeHeader('verification', { now: NOW, sources });
    sources.push(source.userInput());
    const first = sources[0];
    if (first) first.input = 'bogus';
    expect(header.sources).toEqual([{ kind: 'store', input: 'rules.yaml' }]);
  });
});

describe('source — README 2.1 다섯 접두어와 1:1', () => {
  it('parser · execution · store · git · user-input, undefined 필드는 키가 없다', () => {
    expect(source.parser('prisma', '6.1', 'prisma/schema.prisma')).toEqual({
      kind: 'parser',
      tool: 'prisma',
      version: '6.1',
      input: 'prisma/schema.prisma',
    });
    expect(source.parser('openapi')).toEqual({ kind: 'parser', tool: 'openapi' });
    expect(source.execution('vitest-junit', undefined, 'reports/junit.xml')).toEqual({
      kind: 'execution',
      tool: 'vitest-junit',
      input: 'reports/junit.xml',
    });
    expect(source.store('checks/c-0001.json', 'a1b2c3d')).toEqual({
      kind: 'store',
      input: 'checks/c-0001.json',
      commit: 'a1b2c3d',
    });
    expect(source.store()).toEqual({ kind: 'store' });
    expect(source.git('a1b2c3d', 'HEAD~1..HEAD')).toEqual({ kind: 'git', commit: 'a1b2c3d', input: 'HEAD~1..HEAD' });
    expect(source.userInput('?block=payment')).toEqual({ kind: 'user-input', input: '?block=payment' });
    expect(source.userInput()).toEqual({ kind: 'user-input' });

    const kinds = [source.parser('x'), source.execution('x'), source.store(), source.git('c'), source.userInput()].map(
      (ref) => ref.kind,
    );
    expect(kinds).toEqual(['parser', 'execution', 'store', 'git', 'user-input']);
  });
});
