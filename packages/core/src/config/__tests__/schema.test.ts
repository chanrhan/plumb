import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PlumbConfig } from '../../types/index.js';
import { type ParsedPlumbConfig, type PlumbConfigInput, plumbConfigSchema } from '../index.js';

describe('plumbConfigSchema ↔ PlumbConfig', () => {
  it('파싱 결과는 정본 타입 PlumbConfig에 대입된다', () => {
    expectTypeOf<ParsedPlumbConfig>().toMatchTypeOf<PlumbConfig>();
  });

  it('정본 타입 PlumbConfig의 모든 값은 스키마 입력으로 받아들여진다', () => {
    expectTypeOf<PlumbConfig>().toMatchTypeOf<PlumbConfigInput>();
  });

  it('모든 선택 필드를 채운 설정이 통과하고 선언한 기본값이 채워진다', () => {
    const full: PlumbConfig = {
      service: './service',
      store: '~/.plumb/stores/service',
      work: './.work',
      adapter: 'nextjs',
      node: '22',
      roles: {
        'test-writer': { model: 'm', maxTurns: 60, maxBudgetUsd: 3 },
        implementer: { model: 'm', maxTurns: 80, maxBudgetUsd: 5 },
        injector: { model: 'm', maxTurns: 30, maxBudgetUsd: 2 },
        'rule-drafter': { model: 'm', maxTurns: 1, maxBudgetUsd: 0.5 },
      },
      stopBlockLimit: 5,
      run: { maxBudgetUsd: 10 },
      diffSearch: { numRuns: 1000 },
      ide: 'code -g {file}:{line}',
      blocks: {
        pay: { include: ['src/domains/pay/**'], dependsOn: ['billing'], risk: 'high' },
        billing: { include: ['src/domains/billing/**'], public: ['index.ts', 'api.ts'] },
      },
      ignore: ['node_modules/**', '**/*.test.ts'],
      services: { stripe: { kind: 'external-api', clientPackages: ['stripe'], envVars: ['STRIPE_KEY'] } },
      contracts: { openapi: 'openapi.yaml', prisma: 'prisma/schema.prisma', models: { Payment: 'pay' } },
      flow: { mode: 'auto' },
      checks: { junitReport: 'reports/junit.xml' },
      reviewQueue: { maxDays: 7 },
    };

    const parsed = plumbConfigSchema.parse(full);

    expect(parsed.run).toEqual({ maxBudgetUsd: 10, concurrent: 1 });
    expect(parsed.blocks?.pay.public).toEqual(['index.ts']);
    expect(parsed.blocks?.billing.public).toEqual(['index.ts', 'api.ts']);
    expect(parsed.flow).toEqual({ mode: 'auto', entryGlob: ['src/app/api/**/route.ts'], internalDepth: 1 });
    expect(parsed.checks).toEqual({ stability: 3, junitReport: 'reports/junit.xml' });
    expect(parsed.reviewQueue).toEqual({ maxUnconfirmed: 20, maxDays: 7 });
  });

  it('타입이 필수로 둔 역할 상한에는 기본값을 주지 않는다', () => {
    const result = plumbConfigSchema.safeParse({
      service: './service',
      adapter: 'nextjs',
      roles: {
        'test-writer': { model: 'm' },
        implementer: { model: 'm', maxTurns: 80, maxBudgetUsd: 5 },
        injector: { model: 'm', maxTurns: 30, maxBudgetUsd: 2 },
        'rule-drafter': { model: 'm', maxTurns: 1, maxBudgetUsd: 0.5 },
      },
      stopBlockLimit: 5,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
        'roles.test-writer.maxBudgetUsd',
        'roles.test-writer.maxTurns',
      ]);
    }
  });

  it('adapter는 nextjs만, flow.mode는 trace · static · auto만', () => {
    const base = {
      service: './service',
      adapter: 'nextjs',
      roles: {
        'test-writer': { model: 'm', maxTurns: 1, maxBudgetUsd: 1 },
        implementer: { model: 'm', maxTurns: 1, maxBudgetUsd: 1 },
        injector: { model: 'm', maxTurns: 1, maxBudgetUsd: 1 },
        'rule-drafter': { model: 'm', maxTurns: 1, maxBudgetUsd: 1 },
      },
      stopBlockLimit: 1,
    };

    expect(plumbConfigSchema.safeParse({ ...base, adapter: 'remix' }).success).toBe(false);
    expect(plumbConfigSchema.safeParse({ ...base, flow: { mode: 'dynamic' } }).success).toBe(false);
    expect(plumbConfigSchema.safeParse({ ...base, flow: { mode: 'static' } }).success).toBe(true);
  });
});
