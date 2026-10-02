/**
 * #59 — 정적 호출 그래프를 `examples/testbed`에 **실제로** 돌린다 (TS 컴파일러 API, 모킹 없음).
 * 기대값은 testbed 소스에서 사람이 읽어 적은 것이다 (스냅샷 아님):
 *   POST /refunds  → payment.refund        → payment.findPayment(internal) → ext:db:payment.findUnique
 *                                          → payment.insertRefund(internal) → ext:db:refund.create · ext:db:payment.update
 *   POST /payments → payment.createPayment → payment.insertPayment(internal) → ext:db:payment.create
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AdapterContext, loadConfigFile } from '@plumb/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { allNodeIds, buildCallGraph, chainsOf, prismaOperationOf, routePathOf } from '../call-graph.js';
import { nextjsAdapter } from '../index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const testbedRoot = join(here, '../../../../examples/testbed');

let ctx: AdapterContext;

beforeAll(async () => {
  const loaded = await loadConfigFile(join(testbedRoot, 'plumb.config.json'));
  ctx = { root: testbedRoot, config: loaded.config };
});

describe('routePathOf — Next.js 파일 규약 → 경로', () => {
  it.each([
    ['src/app/api/refunds/route.ts', '/refunds'],
    ['src/app/api/payments/route.ts', '/payments'],
    ['src/app/api/payments/[id]/route.ts', '/payments/{id}'],
    ['src/app/api/(internal)/health/route.ts', '/health'],
    ['src/app/api/files/[...path]/route.ts', '/files/{path*}'],
    ['app/api/route.ts', '/'],
  ])('%s → %s', (file, expected) => {
    expect(routePathOf(file)).toBe(expected);
  });
});

describe('prismaOperationOf — repo.ts 호출식', () => {
  it('prisma().refund.create · prisma.payment.update', () => {
    expect(prismaOperationOf('prisma().refund.create')).toEqual({ model: 'refund', op: 'create' });
    expect(prismaOperationOf('prisma.payment.update')).toEqual({ model: 'payment', op: 'update' });
    expect(prismaOperationOf('this.prisma.payment.findUnique')).toEqual({ model: 'payment', op: 'findUnique' });
  });

  it('$transaction 같은 $ 메서드와 무관한 호출은 아니다', () => {
    expect(prismaOperationOf('prisma().$transaction')).toBeUndefined();
    expect(prismaOperationOf('repo.insertRefund')).toBeUndefined();
    expect(prismaOperationOf('json')).toBeUndefined();
  });
});

describe('buildCallGraph(): testbed', () => {
  it('진입점 2개 — POST /payments · POST /refunds, 체인이 공개 진입점 → 내부 한 단계 → prisma 연산으로 이어진다', async () => {
    const graph = await buildCallGraph(ctx);

    expect(graph.tool.name).toBe('typescript');
    expect(graph.tool.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(graph.entries.map((e) => e.label)).toEqual(['POST /payments', 'POST /refunds']);

    const chains = graph.entries.flatMap((e) => chainsOf(e));
    expect(chains).toEqual([
      'POST /payments → payment.createPayment → payment.insertPayment → db: payment.create',
      'POST /refunds → payment.refund → payment.findPayment → db: payment.findUnique',
      'POST /refunds → payment.refund → payment.insertRefund → db: refund.create',
      'POST /refunds → payment.refund → payment.insertRefund → db: payment.update',
    ]);

    const refunds = graph.entries[1];
    expect(refunds).toMatchObject({
      id: 'entry:POST /refunds',
      kind: 'entry',
      anchor: { file: 'src/app/api/refunds/route.ts', line: 20, block: 'app' },
      evidence: 'static',
    });
    const refund = refunds?.children[0];
    expect(refund).toMatchObject({
      id: 'payment.refund',
      kind: 'public',
      anchor: { file: 'src/domains/payment/payment.ts', line: 31, block: 'payment' },
      evidence: 'static',
    });
    const insertRefund = refund?.children.find((c) => c.id === 'payment.insertRefund');
    expect(insertRefund).toMatchObject({
      kind: 'internal',
      anchor: { file: 'src/domains/payment/repo.ts', line: 26, block: 'payment' },
    });
    expect(insertRefund?.children.map((c) => c.id)).toEqual(['ext:db:refund.create', 'ext:db:payment.update']);
    expect(insertRefund?.children[0]).toMatchObject({
      kind: 'external',
      label: 'db: refund.create',
      external: { system: 'db', operation: 'refund.create' },
      anchor: { file: 'src/domains/payment/repo.ts', line: 28 },
      evidence: 'static',
    });

    // 모든 노드가 정적 근거다 (실선·점선은 코어가 스팬과 대조해 정한다)
    for (const entry of graph.entries) {
      const stack = [entry];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        expect(node.evidence).toBe('static');
        stack.push(...node.children);
      }
    }
  }, 60_000);

  it('심볼 표에 모든 노드의 file:line이 있고, 테스트 import 그래프는 단위 테스트가 공개 진입점 둘을 import한다고 말한다', async () => {
    const graph = await buildCallGraph(ctx);

    const ids = allNodeIds(graph);
    expect(ids).toEqual([
      'entry:POST /payments',
      'payment.createPayment',
      'payment.insertPayment',
      'ext:db:payment.create',
      'entry:POST /refunds',
      'payment.refund',
      'payment.findPayment',
      'ext:db:payment.findUnique',
      'payment.insertRefund',
      'ext:db:refund.create',
      'ext:db:payment.update',
    ]);
    for (const id of ids) {
      expect(graph.symbols[id], id).toMatchObject({ file: expect.stringMatching(/^src\//), line: expect.any(Number) });
    }

    // repo.ts·payment.ts·route.ts의 lib 헬퍼 호출(json · requireString · handleUnexpected)은 노드가 아니다 (4.0 해상도 밖)
    expect(ids.some((id) => /lib\.|json|requireString/.test(id))).toBe(false);

    expect(graph.testRefs).toEqual({
      'payment.createPayment': ['src/domains/payment/__tests__/payment.unit.test.ts'],
      'payment.refund': ['src/domains/payment/__tests__/payment.unit.test.ts'],
    });
    expect(graph.warnings.join('\n')).toContain('동적 import');
  }, 60_000);

  it('internalDepth 0이면 공개 진입점에서 멈추고 내부 함수와 그 아래 prisma 연산은 보이지 않는다', async () => {
    const graph = await buildCallGraph(ctx, { internalDepth: 0 });
    expect(graph.entries.flatMap((e) => chainsOf(e))).toEqual([
      'POST /payments → payment.createPayment',
      'POST /refunds → payment.refund',
    ]);
  }, 60_000);

  it('진입점 글롭이 안 맞으면 entries 0개 (예외 아님)', async () => {
    const graph = await buildCallGraph(ctx, { entryGlob: ['src/app/api/__none__/route.ts'] });
    expect(graph.entries).toEqual([]);
  }, 60_000);

  it('nextjsAdapter.buildCallGraph가 이 구현이다 (CallGraphProvider)', () => {
    expect(typeof nextjsAdapter.buildCallGraph).toBe('function');
  });
});
