import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeRule,
  parseRulesDocument,
  RulesParseError,
  RulesValidationError,
  readRulesFile,
  serializeRulesDocument,
  toRuleYaml,
} from '../index.js';
import { makeTempStore, RECORD_RULE, REFUND_RULE, type TempStore } from './fixtures.js';

const PLAN_EXAMPLE = `version: 1
rules:
  - id: pay.refund-window
    block: payment
    kind: business
    statement: WHEN 환불 요청이 결제 후 7일을 초과하면 THE SYSTEM SHALL 요청을 거절한다
    source: plan:PAY-02
    risk: high
    depends_on: [pay.payment-record]
    checks: [test/acceptance/refund-window.property.spec.ts]
    decision: D-0001
`;

describe('rules.yaml 파싱 · 정규화', () => {
  it('기획안 §5.2 예시를 읽고 checks 문자열을 acceptance로 정규화한다', () => {
    const doc = parseRulesDocument(PLAN_EXAMPLE, 'rules.yaml');
    expect(doc.rules).toHaveLength(1);
    expect(
      normalizeRule(doc.rules[0] ?? { id: 'x.y', kind: 'business', statement: '', source: 'plan:X', risk: 'normal' }),
    ).toEqual(REFUND_RULE);
  });

  it('depends_on · checks 없음 → 빈 배열', () => {
    expect(normalizeRule({ id: 'a.b', kind: 'technical', statement: 's', source: 'code:x', risk: 'normal' })).toEqual({
      id: 'a.b',
      kind: 'technical',
      statement: 's',
      source: 'code:x',
      risk: 'normal',
      depends_on: [],
      checks: [],
    });
  });

  it('YAML 오류 → RulesParseError (줄 번호)', () => {
    const error = (() => {
      try {
        parseRulesDocument('version: 1\nrules:\n  - id: [unclosed\n', 'r.yaml');
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(RulesParseError);
    expect((error as RulesParseError).path).toBe('r.yaml');
    expect((error as RulesParseError).line).toBeTypeOf('number');
  });

  it('스키마 오류 → RulesValidationError (알 수 없는 kind · 잘못된 ID · 잘못된 출처)', () => {
    const bad = `version: 1
rules:
  - id: pay.a
    kind: fuzzy
    statement: s
    source: plan:X
    risk: normal
  - id: no-dot
    kind: business
    statement: s
    source: plan:X
    risk: normal
  - id: pay.b
    kind: business
    statement: s
    source: wiki:X
    risk: normal
`;
    const error = (() => {
      try {
        parseRulesDocument(bad, 'r.yaml');
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(RulesValidationError);
    const message = (error as RulesValidationError).message;
    expect(message).toContain('rules.0.kind');
    expect(message).toContain('rules.1.id');
    expect(message).toContain('rules.2.source');
  });

  it('규칙 ID 중복 → RulesValidationError', () => {
    const duplicated = `version: 1
rules:
  - id: pay.a
    kind: business
    statement: s
    source: plan:X
    risk: normal
  - id: pay.a
    kind: technical
    statement: t
    source: code:y
    risk: high
`;
    expect(() => parseRulesDocument(duplicated, 'r.yaml')).toThrow(/rules\.1\.id: 규칙 ID 중복: pay\.a/);
  });

  it('version이 1이 아니거나 rules가 없으면 오류', () => {
    expect(() => parseRulesDocument('version: 2\nrules: []\n', 'r.yaml')).toThrow(RulesValidationError);
    expect(() => parseRulesDocument('rules: []\n', 'r.yaml')).toThrow(RulesValidationError);
    expect(() => parseRulesDocument('version: 1\n', 'r.yaml')).toThrow(RulesValidationError);
  });
});

describe('rules.yaml 직렬화', () => {
  it('키 순서는 §5.2 예시 순서, acceptance 검사는 경로 문자열', () => {
    expect(Object.keys(toRuleYaml(REFUND_RULE))).toEqual([
      'id',
      'block',
      'kind',
      'statement',
      'source',
      'risk',
      'depends_on',
      'checks',
      'decision',
    ]);
    // yaml 패키지는 배열을 블록 형태로 쓴다. 흐름 형태(`[a]`)인 예시와 내용은 같다
    const blockStyle = PLAN_EXAMPLE.replace(
      'depends_on: [pay.payment-record]',
      'depends_on:\n      - pay.payment-record',
    ).replace(
      'checks: [test/acceptance/refund-window.property.spec.ts]',
      'checks:\n      - test/acceptance/refund-window.property.spec.ts',
    );
    expect(serializeRulesDocument([REFUND_RULE])).toBe(blockStyle);
  });

  it('빈 depends_on · checks는 생략, 다른 종류의 검사는 객체', () => {
    const yaml = toRuleYaml({ ...RECORD_RULE, checks: [{ kind: 'static', ref: 'no-cross-block-import' }] });
    expect(yaml).not.toHaveProperty('depends_on');
    expect(yaml.checks).toEqual([{ kind: 'static', ref: 'no-cross-block-import' }]);
    expect(toRuleYaml(RECORD_RULE)).not.toHaveProperty('checks');
  });

  it('왕복: serialize → parse → normalize가 같은 Rule', () => {
    const rules = [REFUND_RULE, { ...RECORD_RULE, summary: '결제 레코드', scope: ['src/domains/payment/**'] }];
    const text = serializeRulesDocument(rules);
    expect(parseRulesDocument(text, 'r.yaml').rules.map(normalizeRule)).toEqual(rules);
  });
});

describe('readRulesFile', () => {
  let t: TempStore;
  beforeEach(async () => {
    t = await makeTempStore();
  });
  afterEach(() => t.cleanup());

  it('텍스트 · 문서 · 정규화 규칙 · 해시를 함께 돌려준다', async () => {
    await writeFile(t.store.paths.rules, PLAN_EXAMPLE);
    const file = await readRulesFile(t.store.paths);
    expect(file.text).toBe(PLAN_EXAMPLE);
    expect(file.rules).toEqual([REFUND_RULE]);
    expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await t.store.rules.get('pay.refund-window')).toEqual(REFUND_RULE);
    expect(await t.store.rules.get('pay.none')).toBeUndefined();
  });
});
