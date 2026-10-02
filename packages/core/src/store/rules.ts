/**
 * `rules.yaml` 읽기 · 쓰기 (기획안 §5.2). 문서 형태는 `{ version: 1, rules: RuleYaml[] }`.
 *
 * 정본 타입은 `../types/rules.ts`의 {@link Rule} · {@link RuleYaml} — 스키마는 그 타입을 만족해야 하며 어긋나면 스키마를 고친다
 * (`satisfies z.ZodType<…>`). YAML 원문의 `checks` 문자열은 `{ kind: 'acceptance', ref }`로 정규화한다 (docs/types/README 2절).
 *
 * **쓰기는 승인 행위뿐이다.** {@link writeRules}는 이 모듈과 `approvals.ts`의 `approve()`만 부르고 `store/index.ts`가 재export하지 않는다.
 */

import { readFile } from 'node:fs/promises';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { riskSchema } from '../config/schema.js';
import type { CheckRef, DecisionId, Rule, RuleId, RuleSource, RuleYaml } from '../types/index.js';
import { RulesParseError, RulesValidationError, StoreNotInitializedError } from './errors.js';
import { isEnoent, sha256, writeFileAtomic } from './fs.js';
import { RULE_ID_PATTERN, type StorePaths } from './paths.js';

// ---------------------------------------------------------------------------
// 스키마
// ---------------------------------------------------------------------------

export const ruleIdSchema = z.custom<RuleId>((value) => typeof value === 'string' && RULE_ID_PATTERN.test(value), {
  message: '규칙 ID는 <블록>.<이름> 형식 (예: pay.refund-window)',
});

export const ruleKindSchema = z.enum(['architecture', 'technical', 'business']);

export const ruleSourceSchema = z.custom<RuleSource>(
  (value) => typeof value === 'string' && /^(plan|code|reference):.+$/.test(value),
  { message: '출처는 plan: · code: · reference: 접두어 + ID (예: plan:PAY-02)' },
);

export const decisionIdSchema = z.custom<DecisionId>((value) => typeof value === 'string' && /^D-.+$/.test(value), {
  message: '결정 ID는 D-nnnn 형식',
});

export const checkKindSchema = z.enum(['acceptance', 'contract', 'pbt', 'static', 'trace']);

export const checkRefSchema = z.object({ kind: checkKindSchema, ref: z.string().min(1) }).strict() satisfies z.ZodType<
  CheckRef,
  z.ZodTypeDef,
  unknown
>;

export const constraintTargetSchema = z.union([
  z.object({ kind: z.literal('package'), name: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('service'),
      type: z.enum(['db', 'cache', 'queue', 'external-api']),
      name: z.string().min(1).optional(),
    })
    .strict(),
]);

const ruleFields = {
  id: ruleIdSchema,
  block: z.string().min(1).optional(),
  kind: ruleKindSchema,
  statement: z.string().min(1),
  summary: z.string().min(1).optional(),
  source: ruleSourceSchema,
  risk: riskSchema,
  decision: decisionIdSchema.optional(),
  scope: z.array(z.string().min(1)).optional(),
  constraint: z
    .object({ targets: z.array(constraintTargetSchema) })
    .strict()
    .optional(),
};

/** `rules.yaml` 항목 (축약 허용) */
export const ruleYamlSchema = z
  .object({
    ...ruleFields,
    depends_on: z.array(ruleIdSchema).optional(),
    checks: z.array(z.union([z.string().min(1), checkRefSchema])).optional(),
  })
  .strict() satisfies z.ZodType<RuleYaml, z.ZodTypeDef, unknown>;

/** 정규화된 규칙 (제안 JSON의 `before` · `after`) */
export const ruleSchema = z
  .object({
    ...ruleFields,
    depends_on: z.array(ruleIdSchema),
    checks: z.array(checkRefSchema),
  })
  .strict() satisfies z.ZodType<Rule, z.ZodTypeDef, unknown>;

/** `rules.yaml` 문서 전체. ID 중복은 오류 */
export const rulesDocumentSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(ruleYamlSchema),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'id'],
          message: `규칙 ID 중복: ${rule.id}`,
        });
      }
      seen.add(rule.id);
    });
  });

export type RulesDocument = z.output<typeof rulesDocumentSchema>;

// ---------------------------------------------------------------------------
// 정규화 · 직렬화
// ---------------------------------------------------------------------------

/** YAML 항목 → 정규화 규칙. `checks` 문자열은 acceptance, `depends_on` 없으면 `[]` */
export function normalizeRule(yaml: RuleYaml): Rule {
  const { depends_on, checks, ...rest } = yaml;
  return {
    ...rest,
    depends_on: depends_on ?? [],
    checks: (checks ?? []).map((check) => (typeof check === 'string' ? { kind: 'acceptance', ref: check } : check)),
  };
}

/**
 * 정규화 규칙 → YAML 항목. 키 순서는 기획안 §5.2 예시 순서(id, block, kind, statement, source, risk, depends_on, checks, decision),
 * 그 뒤에 summary · scope · constraint. acceptance 검사는 예시처럼 경로 문자열로 적고, 빈 배열은 생략한다.
 */
export function toRuleYaml(rule: Rule): RuleYaml {
  const ordered: Array<[keyof RuleYaml, unknown]> = [
    ['id', rule.id],
    ['block', rule.block],
    ['kind', rule.kind],
    ['statement', rule.statement],
    ['source', rule.source],
    ['risk', rule.risk],
    ['depends_on', rule.depends_on.length > 0 ? rule.depends_on : undefined],
    [
      'checks',
      rule.checks.length > 0
        ? rule.checks.map((check) => (check.kind === 'acceptance' ? check.ref : { kind: check.kind, ref: check.ref }))
        : undefined,
    ],
    ['decision', rule.decision],
    ['summary', rule.summary],
    ['scope', rule.scope],
    ['constraint', rule.constraint],
  ];
  return Object.fromEntries(ordered.filter(([, value]) => value !== undefined)) as unknown as RuleYaml;
}

/** 문서 텍스트. 긴 진술이 접히지 않도록 `lineWidth: 0` */
export function serializeRulesDocument(rules: Rule[]): string {
  return stringify({ version: 1, rules: rules.map(toRuleYaml) }, { lineWidth: 0 });
}

/** 텍스트 → 검증된 문서. YAML 오류는 {@link RulesParseError}(줄 번호), 스키마 오류는 {@link RulesValidationError} */
export function parseRulesDocument(text: string, path: string): RulesDocument {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new RulesParseError(path, first?.linePos?.[0]?.line, first);
  }
  const result = rulesDocumentSchema.safeParse(doc.toJS() as unknown);
  if (!result.success) {
    throw new RulesValidationError(path, result.error.issues);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// 파일
// ---------------------------------------------------------------------------

export interface RulesFile {
  text: string;
  document: RulesDocument;
  rules: Rule[];
  /** 파일 내용의 sha256 (승인 기록의 `rulesHash`와 비교하는 값) */
  hash: string;
}

/** `rules.yaml` 읽기. 파일이 없으면 {@link StoreNotInitializedError} */
export async function readRulesFile(paths: StorePaths): Promise<RulesFile> {
  let text: string;
  try {
    text = await readFile(paths.rules, 'utf8');
  } catch (error) {
    if (isEnoent(error)) throw new StoreNotInitializedError(paths.rules);
    throw error;
  }
  const document = parseRulesDocument(text, paths.rules);
  return { text, document, rules: document.rules.map(normalizeRule), hash: sha256(text) };
}

export async function listRules(paths: StorePaths): Promise<Rule[]> {
  return (await readRulesFile(paths)).rules;
}

export async function getRule(paths: StorePaths, id: RuleId): Promise<Rule | undefined> {
  return (await listRules(paths)).find((rule) => rule.id === id);
}

/** 현재 `rules.yaml`의 sha256. 파싱하지 않고 바이트만 본다 */
export async function hashRulesFile(paths: StorePaths): Promise<string> {
  try {
    return sha256(await readFile(paths.rules));
  } catch (error) {
    if (isEnoent(error)) throw new StoreNotInitializedError(paths.rules);
    throw error;
  }
}

/**
 * `rules.yaml`을 통째로 바꿔 쓴다 (원자적). 돌려주는 값은 쓴 뒤 파일의 sha256.
 * **모듈 내부용** — `approvals.ts`의 `approve()`가 부른다. `store/index.ts`는 재export하지 않는다.
 */
export async function writeRules(paths: StorePaths, rules: Rule[]): Promise<string> {
  await writeFileAtomic(paths.rules, serializeRulesDocument(rules));
  return hashRulesFile(paths);
}
