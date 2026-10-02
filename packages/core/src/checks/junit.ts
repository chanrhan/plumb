/**
 * JUnit XML → {@link JunitReport} (이슈 #43). `plumb check`(#47)가 테스트 러너의 `reports/junit.xml`을 읽는 입구.
 *
 * Vitest JUnit 리포터 형식(`examples/testbed/vitest.config.ts`)을 기준으로 하되 **표준 속성만 믿는다**:
 * `testsuites/testsuite/testcase`, `classname` · `name` · `file` · `time`, 자식 `failure` · `error` · `skipped`.
 * Vitest는 `file` 속성을 기본으로 쓰지 않고 `classname`과 `testsuite@name`에 파일 경로를 넣으므로 그 순서로 보완한다.
 *
 * `failure` 본문에서 두 가지를 더 읽는다 (view-verification 3.3 "실패 위치" · "PBT 반례 · 시드"):
 * - 스택의 **첫 `test/` 또는 `src/` 프레임**의 `file:line` → {@link JunitFailure.anchor}. Vitest는 ` ❯ test/….spec.ts:8:22`(루트 기준 상대)와
 *   `    at /abs/…/test/….spec.ts:8:22`(절대) 두 모양으로 쓴다. 절대 경로는 `opts.root`로 상대화하고, 못 하면 건너뛴다.
 *   프레임이 없으면 testcase의 파일과 `line: 1`
 * - `Seed:` · `Counterexample:` 줄 → fast-check 반례 · 시드 (`examples/testbed/test/setup.ts`의 보고 형식. 줄 머리글이 계약이다)
 *
 * 순수 함수다 — 파일을 읽지 않고 저장소를 모른다. 깨진 XML은 {@link JunitParseError}.
 */

import { isAbsolute, posix, relative, sep } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Anchor } from '../types/index.js';

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** testcase 결과. JUnit `failure` → fail, `error` → error, `skipped` → skipped, 아무것도 없으면 pass */
export type JunitStatus = 'pass' | 'fail' | 'error' | 'skipped';

/** `failure` 또는 `error` 요소 하나 (testcase에 여럿이면 첫 번째) */
export interface JunitFailure {
  /** 어느 요소에서 왔는가 */
  kind: 'failure' | 'error';
  /** `message` 속성. 없으면 본문 첫 줄, 그것도 없으면 빈 문자열 */
  message: string;
  /** `type` 속성 (`AssertionError` 등) */
  type?: string;
  /** 요소 본문 (Vitest는 여기에 메시지 + 스택을 넣는다) */
  body: string;
  /** 스택의 첫 `test/` · `src/` 프레임. 없으면 testcase 파일 + `line: 1`, 파일도 모르면 undefined */
  anchor?: Anchor;
  /** fast-check `Counterexample:` 줄의 값 */
  counterexample?: string;
  /** fast-check `Seed:` 줄의 값 */
  seed?: string;
}

export interface JunitCase {
  /** `classname` + `name`. 한 보고서 안에서 testcase를 구분하는 키 */
  id: string;
  name: string;
  classname: string;
  /** 테스트 파일 경로. 대상 루트 기준 상대(posix). `file` 속성 → `classname` → `testsuite@file` → `testsuite@name` 순으로 찾는다 */
  file?: string;
  /** `time` 속성 (초) */
  timeSec?: number;
  status: JunitStatus;
  /** `status`가 fail · error일 때 */
  failure?: JunitFailure;
}

export interface JunitSuite {
  name: string;
  file?: string;
  timestamp?: string;
  cases: JunitCase[];
}

export interface JunitTotals {
  tests: number;
  passed: number;
  failures: number;
  errors: number;
  skipped: number;
  /** testcase `time` 합 (초). 속성이 없는 testcase는 0으로 센다 */
  timeSec: number;
}

export interface JunitReport {
  suites: JunitSuite[];
  /** testcase를 직접 세어 만든 값. `testsuites`의 집계 속성은 믿지 않는다 */
  totals: JunitTotals;
}

export interface ParseJunitOptions {
  /** 대상 루트(절대). 절대 경로로 온 파일 · 스택 프레임을 이 기준의 상대 경로로 바꾼다 */
  root?: string;
}

/** XML이 아니거나 JUnit 모양이 아닐 때. `line` · `column`은 XML 문법 오류일 때만 */
export class JunitParseError extends Error {
  readonly line?: number;
  readonly column?: number;
  constructor(message: string, position?: { line: number; column: number }) {
    super(position ? `${message} (${position.line}:${position.column})` : message);
    this.name = 'JunitParseError';
    this.line = position?.line;
    this.column = position?.column;
  }
}

// ---------------------------------------------------------------------------
// XML → 노드
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>;

/** fast-xml-parser 출력 노드. 속성은 `@_`, 본문은 `#text`, 자식 요소는 태그 이름 → 배열(아래 `isArray`) */
type XmlNode = Record<string, unknown>;

const LIST_TAGS = new Set(['testsuites', 'testsuite', 'testcase', 'failure', 'error', 'skipped']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // 숫자 · 불리언으로 바꾸지 않는다 — `name="1"` 같은 값이 깨진다. 숫자는 우리가 읽는다
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  alwaysCreateTextNode: true,
  isArray: (tagName) => LIST_TAGS.has(tagName),
});

function attrsOf(node: XmlNode): Attrs {
  const attrs: Attrs = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') && typeof value === 'string') attrs[key.slice(2)] = value;
  }
  return attrs;
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && typeof (node as XmlNode)['#text'] === 'string') {
    return (node as XmlNode)['#text'] as string;
  }
  return '';
}

function childList(node: XmlNode, tag: string): XmlNode[] {
  const value = node[tag];
  if (!Array.isArray(value)) return [];
  return value.map((child) => (child && typeof child === 'object' ? (child as XmlNode) : { '#text': textOf(child) }));
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// 경로 · 스택 · fast-check 줄
// ---------------------------------------------------------------------------

/** 파일 경로처럼 보이는가 (Vitest는 `classname`에 `src/…/x.test.ts`를 넣는다). 확장자가 있는 상대 · 절대 경로 */
const PATH_LIKE =
  /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/]|file:\/\/)?[^\s"<>|*?]*[\\/][^\s"<>|*?]*\.[A-Za-z0-9]+$|^[^\s"<>|*?/\\]+\.(?:[cm]?[jt]sx?)$/;

function looksLikePath(value: string | undefined): value is string {
  return value !== undefined && PATH_LIKE.test(value);
}

/**
 * 경로를 대상 루트 기준 상대(posix)로. `file://`를 벗기고, 절대 경로는 `root`가 있을 때만 상대화한다.
 * 상대화할 수 없는 절대 경로는 그대로 돌려준다 (호출자가 판단).
 */
export function toRootRelative(path: string, root?: string): string {
  let p = path.startsWith('file://') ? decodeURIComponent(path.slice('file://'.length)) : path;
  if (root && isAbsolute(p)) {
    const rel = relative(root, p);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) p = rel;
  }
  p = p.split(sep).join('/').replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  return posix.normalize(p);
}

/** 스택 프레임으로 인정하는 경로 접두어 (이슈 #43 · view-verification 3.3: `test/**` 첫 프레임, 구현 코드면 `src/`) */
const FRAME_PREFIX = /^(?:test|src)\//;

/** 한 줄 안의 `경로:줄[:칸]` 후보. `(`로 감싼 Node 형식과 ` ❯ fn path:l:c` Vitest 형식 모두 잡힌다 */
const FRAME_RE = /(?:^|[\s(])((?:file:\/\/)?(?:[A-Za-z]:)?[^\s():]+):(\d+)(?::\d+)?\)?(?=\s|$)/g;

/**
 * failure 본문(과 message)에서 첫 `test/` · `src/` 프레임의 `file:line`.
 * `at /abs/path:8:22` · ` ❯ test/x.spec.ts:8:22` · `(file:///abs/path:1:2)` 를 모두 읽는다.
 */
export function findAnchor(text: string, opts: ParseJunitOptions = {}): Anchor | undefined {
  for (const line of text.split(/\r?\n/)) {
    FRAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null = FRAME_RE.exec(line);
    while (match !== null) {
      const rawPath = match[1] ?? '';
      const lineNo = Number(match[2]);
      if (rawPath.includes('.') && Number.isInteger(lineNo) && lineNo > 0) {
        const file = toRootRelative(rawPath, opts.root);
        if (FRAME_PREFIX.test(file)) return { file, line: lineNo };
      }
      match = FRAME_RE.exec(line);
    }
  }
  return undefined;
}

/** `Seed: 42` · `Counterexample: [8]` 줄 (setup.ts의 reporter 형식). 첫 줄만 */
function fastCheckLine(text: string, head: 'Seed' | 'Counterexample'): string | undefined {
  const match = new RegExp(`^\\s*${head}:[ \\t]*(.*)$`, 'm').exec(text);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

function readFailure(
  kind: 'failure' | 'error',
  node: XmlNode,
  fallback: { file?: string },
  opts: ParseJunitOptions,
): JunitFailure {
  const attrs = attrsOf(node);
  const body = textOf(node);
  const message = attrs.message ?? body.split(/\r?\n/)[0] ?? '';
  const searchText = body ? `${body}\n${attrs.message ?? ''}` : (attrs.message ?? '');
  const anchor = findAnchor(searchText, opts) ?? (fallback.file ? { file: fallback.file, line: 1 } : undefined);
  const failure: JunitFailure = { kind, message, body };
  if (attrs.type) failure.type = attrs.type;
  if (anchor) failure.anchor = anchor;
  const counterexample = fastCheckLine(searchText, 'Counterexample');
  const seed = fastCheckLine(searchText, 'Seed');
  if (counterexample) failure.counterexample = counterexample;
  if (seed) failure.seed = seed;
  return failure;
}

function readCase(node: XmlNode, suite: { file?: string }, opts: ParseJunitOptions): JunitCase {
  const attrs = attrsOf(node);
  const classname = attrs.classname ?? '';
  const name = attrs.name ?? '';
  const fileSource = [attrs.file, classname, suite.file].find(looksLikePath);
  const file = fileSource ? toRootRelative(fileSource, opts.root) : undefined;

  const testcase: JunitCase = { id: `${classname}::${name}`, name, classname, status: 'pass' };
  if (file) testcase.file = file;
  const timeSec = parseTime(attrs.time);
  if (timeSec !== undefined) testcase.timeSec = timeSec;

  const errors = childList(node, 'error');
  const failures = childList(node, 'failure');
  if (errors[0]) {
    testcase.status = 'error';
    testcase.failure = readFailure('error', errors[0], { file }, opts);
  } else if (failures[0]) {
    testcase.status = 'fail';
    testcase.failure = readFailure('failure', failures[0], { file }, opts);
  } else if (childList(node, 'skipped').length > 0) {
    testcase.status = 'skipped';
  }
  return testcase;
}

function readSuite(node: XmlNode, opts: ParseJunitOptions): JunitSuite {
  const attrs = attrsOf(node);
  const name = attrs.name ?? '';
  const fileSource = [attrs.file, name].find(looksLikePath);
  const file = fileSource ? toRootRelative(fileSource, opts.root) : undefined;
  const suite: JunitSuite = { name, cases: [] };
  if (file) suite.file = file;
  if (attrs.timestamp) suite.timestamp = attrs.timestamp;
  suite.cases = childList(node, 'testcase').map((testcase) => readCase(testcase, { file }, opts));
  return suite;
}

/** 루트가 `testsuites`면 그 아래 `testsuite`들, 루트가 `testsuite` 하나면 그것. 중첩 `testsuite`도 편다 */
function collectSuites(root: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (node: XmlNode): void => {
    for (const child of childList(node, 'testsuite')) {
      out.push(child);
      visit(child);
    }
  };
  for (const suites of childList(root, 'testsuites')) visit(suites);
  visit(root);
  return out;
}

function totalsOf(suites: JunitSuite[]): JunitTotals {
  const totals: JunitTotals = { tests: 0, passed: 0, failures: 0, errors: 0, skipped: 0, timeSec: 0 };
  for (const suite of suites) {
    for (const testcase of suite.cases) {
      totals.tests += 1;
      totals.timeSec += testcase.timeSec ?? 0;
      if (testcase.status === 'pass') totals.passed += 1;
      else if (testcase.status === 'fail') totals.failures += 1;
      else if (testcase.status === 'error') totals.errors += 1;
      else totals.skipped += 1;
    }
  }
  return totals;
}

/**
 * JUnit XML 문자열 → {@link JunitReport}. 깨진 XML · JUnit 모양이 아닌 문서는 {@link JunitParseError}.
 * 빈 `testsuites`(테스트 0개)는 오류가 아니다 — `passWithNoTests`가 그런 파일을 만든다.
 */
export function parseJunit(xml: string, opts: ParseJunitOptions = {}): JunitReport {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new JunitParseError('JUnit XML이 비어 있다');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    throw new JunitParseError(`XML 문법 오류: ${msg}`, { line, column: col });
  }
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new JunitParseError(`XML 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new JunitParseError('XML 루트 요소가 없다');
  }
  const root = parsed as XmlNode;
  if (!('testsuites' in root) && !('testsuite' in root)) {
    const rootTag = Object.keys(root).find((key) => !key.startsWith('?') && !key.startsWith('@_'));
    throw new JunitParseError(`JUnit 문서가 아니다: 루트 요소 <${rootTag ?? '?'}> (testsuites 또는 testsuite 필요)`);
  }
  const suites = collectSuites(root).map((suite) => readSuite(suite, opts));
  return { suites, totals: totalsOf(suites) };
}

/** 보고서의 모든 testcase를 문서 순서대로 */
export function allCases(report: JunitReport): JunitCase[] {
  return report.suites.flatMap((suite) => suite.cases);
}
