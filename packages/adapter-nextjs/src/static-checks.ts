/**
 * 정적 검사 — dependency-cruiser 위반을 1등급 `CheckResult`로 (이슈 #44, 기획안 §7.5 · §12 블록 필수 검사).
 *
 * `depcruise src --config .dependency-cruiser.cjs --output-type json --output-to <root>/reports/depcruise.json`을 실행하고
 * JSON의 `summary.violations[]`를 **규칙 이름별로** 묶는다. 규칙 하나 = `CheckResult` 하나:
 * `{ check: { kind: 'static', ref: 'depcruise:<rule.name>' }, ruleIds: [], outcome }`.
 * 위반이 0이어도 규칙마다 `pass`를 낸다 (검사 수 집계 "n/n"의 원자료). `ruleIds`는 비워 둔다 — #46이 설정·규칙 YAML에서 매핑한다.
 *
 * 결과는 exit code가 아니라 JSON에서만 만든다 (depcruise는 `--output-to`를 쓰면 위반이 있어도 0으로 끝난다).
 * JSON이 안 생기면 결과 없음(`results: []`, `graphJsonPath: null`) — 추정으로 pass·fail을 만들지 않는다.
 * 같은 JSON의 `modules[]`는 #45 `extractDependencies()`가 블록 그래프의 원료로 재사용한다.
 */

import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AdapterContext, CheckResult, StaticCheckRun } from '@plumb/core';
import { capture, readToolInfo } from './capture.js';

/** 결과 타입은 코어 `adapter/types.ts`의 것 (#63) */
export type { StaticCheckRun };

/** `CheckRef.ref` 접두어. `rules.yaml` `checks[].ref`와 #46의 common.ts가 같은 문자열을 쓴다 */
export const DEPCRUISE_REF_PREFIX = 'depcruise:';
export const DEPCRUISE_CONFIG = '.dependency-cruiser.cjs';
export const DEPCRUISE_SCAN_DIR = 'src';
export const DEFAULT_GRAPH_JSON_PATH = 'reports/depcruise.json';

/** dependency-cruiser JSON 가운데 여기서 읽는 부분 (`ICruiseResult`의 부분집합) */
export interface DepcruiseViolation {
  type?: string;
  from: string;
  to: string;
  rule: { name: string; severity: string };
  cycle?: Array<{ name: string } | string>;
}

export interface DepcruiseJson {
  modules?: unknown[];
  summary: {
    violations: DepcruiseViolation[];
    ruleSetUsed?: {
      forbidden?: Array<{ name: string }>;
      required?: Array<{ name: string }>;
      allowed?: unknown[];
    };
  };
}

export function resolveGraphJsonPath(ctx: AdapterContext): string {
  return resolve(ctx.root, DEFAULT_GRAPH_JSON_PATH);
}

export function depcruiseArgs(graphJsonPath: string): string[] {
  return [DEPCRUISE_SCAN_DIR, '--config', DEPCRUISE_CONFIG, '--output-type', 'json', '--output-to', graphJsonPath];
}

/** `ruleSetUsed`의 규칙 이름을 선언 순서대로. `allowed`가 있으면 depcruise의 가상 규칙 `not-in-allowed`도 */
export function ruleNames(json: DepcruiseJson): string[] {
  const set = json.summary.ruleSetUsed;
  const names = [...(set?.forbidden ?? []), ...(set?.required ?? [])].map((rule) => rule.name);
  if (set?.allowed && set.allowed.length > 0) names.push('not-in-allowed');
  // 규칙 집합에 없는 이름으로 위반이 나오면(설정이 바뀐 사이 등) 그것도 한 행으로 센다
  for (const violation of json.summary.violations) {
    if (!names.includes(violation.rule.name)) names.push(violation.rule.name);
  }
  return names;
}

/** 위반 한 건의 메시지 `<from> → <to> (<rule>)`. 순환이면 경로를 이어 붙인다 */
function describeViolation(violation: DepcruiseViolation): string {
  const base = `${violation.from} → ${violation.to} (${violation.rule.name})`;
  if (violation.cycle && violation.cycle.length > 0) {
    const path = violation.cycle.map((entry) => (typeof entry === 'string' ? entry : entry.name)).join(' → ');
    return `${base} 순환: ${path}`;
  }
  return base;
}

/**
 * dependency-cruiser JSON → 규칙별 `CheckResult[]`. 순수 함수 (테스트 픽스처로 직접 검증한다).
 * `severity: 'ignore'` 위반은 세지 않는다. 위반이 여럿이면 첫 것이 `failure`, 나머지는 `message`에 개수로.
 */
export function toStaticCheckResults(json: DepcruiseJson): CheckResult[] {
  const byRule = new Map<string, DepcruiseViolation[]>();
  for (const violation of json.summary.violations) {
    if (violation.rule.severity === 'ignore') continue;
    const list = byRule.get(violation.rule.name) ?? [];
    list.push(violation);
    byRule.set(violation.rule.name, list);
  }

  return ruleNames(json).map((name): CheckResult => {
    const check = { kind: 'static' as const, ref: `${DEPCRUISE_REF_PREFIX}${name}` };
    const violations = byRule.get(name) ?? [];
    const first = violations[0];
    if (!first) return { check, ruleIds: [], outcome: 'pass' };
    const rest = violations.length - 1;
    return {
      check,
      ruleIds: [],
      outcome: 'fail',
      failure: {
        check,
        // depcruise는 줄 번호를 주지 않는다 → 파일 첫 줄 (CheckFailure.anchor "파싱 실패 시 line: 1"과 같은 규약)
        anchor: { file: first.from, line: 1 },
        message: rest > 0 ? `${describeViolation(first)} 외 ${rest}건` : describeViolation(first),
      },
    };
  });
}

export async function runStaticChecks(ctx: AdapterContext): Promise<StaticCheckRun> {
  const graphJsonPath = resolveGraphJsonPath(ctx);
  // 이전 JSON을 "지금 결과"로 읽지 않도록 먼저 지운다. 디렉토리는 만들어 둔다 (depcruise는 안 만든다)
  await rm(graphJsonPath, { force: true });
  await mkdir(dirname(graphJsonPath), { recursive: true });

  const [tool, { output }] = await Promise.all([
    readToolInfo(ctx, 'dependency-cruiser', 'depcruise'),
    capture(ctx, { bin: 'depcruise', args: depcruiseArgs(graphJsonPath) }),
  ]);

  const json = await readDepcruiseJson(graphJsonPath);
  if (!json) return { results: [], output, graphJsonPath: null, tool };
  return { results: toStaticCheckResults(json), output, graphJsonPath, tool };
}

async function readDepcruiseJson(path: string): Promise<DepcruiseJson | null> {
  try {
    await access(path);
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isDepcruiseJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDepcruiseJson(value: unknown): value is DepcruiseJson {
  if (typeof value !== 'object' || value === null) return false;
  const summary = (value as { summary?: unknown }).summary;
  return (
    typeof summary === 'object' && summary !== null && Array.isArray((summary as { violations?: unknown }).violations)
  );
}
