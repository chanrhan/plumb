/**
 * `plumb.config.json` zod 스키마. 정본 타입은 `../types/config.ts`의 {@link PlumbConfig} — 스키마는 그 타입을 만족해야 하며
 * 어긋나면 타입이 아니라 스키마를 고친다 (`satisfies z.ZodType<PlumbConfig>`, `__tests__/schema.test.ts`).
 *
 * 기본값은 타입이 optional로 둔 필드에만 둔다. 값은 타입 주석에 적힌 것을 그대로 옮겼다:
 * `work` `./.work` (기획안 §8.6), `blocks.*.public` `index.ts`, `flow.entryGlob` `src/app/api/** /route.ts`,
 * `flow.internalDepth` 1 (view-flow 4.0), `checks.stability` 3 (기획안 §7.5), `reviewQueue` 20건 · 14일 (기획안 §9.2),
 * `run.concurrent` 1. `store`의 기본값(`~/.plumb/stores/<project>/`)은 프로젝트 이름에 따라 달라 로더가 아니라 저장소 쪽(M3)이 정한다.
 */

import { z } from 'zod';
import type { PlumbConfig } from '../types/index.js';

/** 역할 네 가지 (`types/run.ts` `Role`) */
export const roleSchema = z.enum(['test-writer', 'implementer', 'injector', 'rule-drafter']);

/** 역할별 상한 (기획안 §15.4). 세 필드 모두 필수 — 타입이 필수로 두었다 */
export const roleConfigSchema = z
  .object({
    model: z.string().min(1),
    maxTurns: z.number().int().positive(),
    maxBudgetUsd: z.number().nonnegative(),
  })
  .strict();

export const riskSchema = z.enum(['high', 'normal']);

export const blockConfigSchema = z
  .object({
    include: z.array(z.string().min(1)),
    public: z.array(z.string().min(1)).default(['index.ts']),
    dependsOn: z.array(z.string().min(1)).optional(),
    risk: riskSchema.optional(),
  })
  .strict();

export const infraKindSchema = z.enum(['db', 'cache', 'queue', 'external-api']);

export const serviceConfigSchema = z
  .object({
    kind: infraKindSchema,
    clientPackages: z.array(z.string().min(1)),
    envVars: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const contractsConfigSchema = z
  .object({
    openapi: z.string().min(1).optional(),
    prisma: z.string().min(1).optional(),
    asyncapi: z.string().min(1).optional(),
    models: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();

export const flowConfigSchema = z
  .object({
    mode: z.enum(['trace', 'static', 'auto']),
    entryGlob: z.array(z.string().min(1)).default(['src/app/api/**/route.ts']),
    internalDepth: z.number().int().nonnegative().default(1),
  })
  .strict();

export const plumbConfigSchema = z
  .object({
    /** JSON 편집기용. 설정 의미는 없다 */
    $schema: z.string().optional(),
    service: z.string().min(1),
    store: z.string().min(1).optional(),
    work: z.string().min(1).default('./.work'),
    adapter: z.literal('nextjs'),
    node: z.string().min(1).optional(),
    roles: z
      .object({
        'test-writer': roleConfigSchema,
        implementer: roleConfigSchema,
        injector: roleConfigSchema,
        'rule-drafter': roleConfigSchema,
      })
      .strict(),
    stopBlockLimit: z.number().int().positive(),
    run: z
      .object({
        maxBudgetUsd: z.number().nonnegative(),
        concurrent: z.literal(1).default(1),
      })
      .strict()
      .optional(),
    diffSearch: z
      .object({
        numRuns: z.number().int().positive(),
        seed: z.number().int().optional(),
      })
      .strict()
      .optional(),
    ide: z.string().min(1).optional(),
    blocks: z.record(z.string(), blockConfigSchema).optional(),
    ignore: z.array(z.string().min(1)).optional(),
    services: z.record(z.string(), serviceConfigSchema).optional(),
    contracts: contractsConfigSchema.optional(),
    flow: flowConfigSchema.optional(),
    checks: z
      .object({
        stability: z.number().int().positive().default(3),
        junitReport: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    reviewQueue: z
      .object({
        maxUnconfirmed: z.number().int().positive().default(20),
        maxDays: z.number().int().positive().default(14),
      })
      .strict()
      .default({}),
  })
  .strict() satisfies z.ZodType<PlumbConfig, z.ZodTypeDef, unknown>;

/** 파일에 적는 형태 (기본값 채우기 전). 정본 타입 {@link PlumbConfig}의 모든 값을 받는다 */
export type PlumbConfigInput = z.input<typeof plumbConfigSchema>;

/** 파싱 결과 (기본값 채운 뒤). {@link PlumbConfig}에 대입 가능하다 */
export type ParsedPlumbConfig = z.output<typeof plumbConfigSchema>;
