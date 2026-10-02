import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DecisionParseError,
  decisionsForRule,
  formatDecision,
  getDecision,
  listDecisions,
  nextDecisionId,
  validateDecision,
  writeDecision,
} from '../index.js';
import { EXAMPLE_DECISION_PATH, makeTempPaths, REDIS_DECISION, type TempPaths } from './fixtures.js';

let t: TempPaths;

beforeEach(async () => {
  t = await makeTempPaths();
});

afterEach(() => t.cleanup());

const REFUND_DECISION = {
  title: '환불 기간 7일을 규칙으로 둔다',
  block: 'payment',
  date: '2026-10-02T03:00:00Z',
  decision: '환불 가능 기간을 결제 후 7일로 규칙화한다',
  reason: '기획 요구 PAY-02',
  rejected: '- 14일\n- 30일',
  accepted: '경계 해석은 인수 테스트가 정한다',
  links: { rules: ['pay.refund-window' as const], commits: [], events: [] },
};

describe('decisions store', () => {
  it('write: id가 있으면 decisions/<id>.md에 형식대로 쓰고 get으로 읽힌다', async () => {
    const written = await writeDecision(t.paths, { ...REDIS_DECISION });
    expect(written).toEqual(REDIS_DECISION);
    const onDisk = await readFile(t.paths.decision('D-0031'), 'utf8');
    expect(onDisk).toBe(formatDecision(REDIS_DECISION));
    expect(await getDecision(t.paths, 'D-0031')).toEqual(REDIS_DECISION);
    expect(await getDecision(t.paths, 'D-0001')).toBeUndefined();
  });

  it('write: id가 없으면 D-0001부터, 다음은 기존 최대 + 1 (4자리 zero-pad)', async () => {
    expect(await nextDecisionId(t.paths)).toBe('D-0001');
    const first = await writeDecision(t.paths, REFUND_DECISION);
    expect(first.id).toBe('D-0001');
    expect(first.links).toEqual({ rules: ['pay.refund-window'], commits: [], events: [], packages: [], services: [] });

    const second = await writeDecision(t.paths, { ...REFUND_DECISION, title: '두 번째' });
    expect(second.id).toBe('D-0002');

    await writeDecision(t.paths, { ...REDIS_DECISION, id: 'D-0031' });
    expect(await nextDecisionId(t.paths)).toBe('D-0032');
    const fourth = await writeDecision(t.paths, { ...REFUND_DECISION, title: '네 번째' });
    expect(fourth.id).toBe('D-0032');

    expect((await readdir(t.paths.decisionsDir)).sort()).toEqual(['D-0001.md', 'D-0002.md', 'D-0031.md', 'D-0032.md']);
  });

  it('write: 예시 D-0001.md를 복사해 둔 저장소에서 다음 번호는 D-0002', async () => {
    await mkdir(t.paths.decisionsDir, { recursive: true });
    await copyFile(EXAMPLE_DECISION_PATH, t.paths.decision('D-0001'));
    expect(await nextDecisionId(t.paths)).toBe('D-0002');
    const next = await writeDecision(t.paths, REFUND_DECISION);
    expect(next.id).toBe('D-0002');
    const example = await getDecision(t.paths, 'D-0001');
    expect(example?.title).toBe('환불 기간 7일을 규칙으로 둔다');
    expect(validateDecision(example as NonNullable<typeof example>)).toEqual({ incomplete: [], noReason: false });
  });

  it('write: 번호가 아닌 .md 파일은 번호 증가와 목록에서 무시한다', async () => {
    await mkdir(t.paths.decisionsDir, { recursive: true });
    await writeFile(join(t.paths.decisionsDir, 'README.md'), '# 결정 기록\n', 'utf8');
    expect(await nextDecisionId(t.paths)).toBe('D-0001');
    expect(await listDecisions(t.paths)).toEqual([]);
  });

  it('write: 스키마에 어긋나는 입력은 DecisionParseError이고 파일을 쓰지 않는다', async () => {
    const error = await writeDecision(t.paths, { ...REFUND_DECISION, date: '어제' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionParseError);
    expect((error as Error).message).toContain('at');
    expect(await listDecisions(t.paths)).toEqual([]);
  });

  it('write: 같은 id는 덮어쓴다', async () => {
    await writeDecision(t.paths, { ...REDIS_DECISION });
    await writeDecision(t.paths, { ...REDIS_DECISION, reason: '' });
    const record = await getDecision(t.paths, 'D-0031');
    expect(record?.reason).toBe('');
    expect(validateDecision(record as NonNullable<typeof record>)).toEqual({ incomplete: ['reason'], noReason: true });
  });

  it('list: 폴더가 없으면 빈 배열, 있으면 번호 오름차순', async () => {
    expect(await listDecisions(t.paths)).toEqual([]);
    await writeDecision(t.paths, { ...REDIS_DECISION, id: 'D-0031' });
    await writeDecision(t.paths, { ...REDIS_DECISION, id: 'D-0002', title: '둘' });
    await writeDecision(t.paths, { ...REDIS_DECISION, id: 'D-10000', title: '만' });
    expect((await listDecisions(t.paths)).map((d) => d.id)).toEqual(['D-0002', 'D-0031', 'D-10000']);
  });

  it('decisionsForRule: links.rules에 규칙 ID가 든 기록만', async () => {
    await writeDecision(t.paths, REFUND_DECISION);
    await writeDecision(t.paths, { ...REDIS_DECISION, id: 'D-0031' });
    await writeDecision(t.paths, { ...REFUND_DECISION, title: '두 번째 환불 결정' });

    expect((await decisionsForRule(t.paths, 'pay.refund-window')).map((d) => d.id)).toEqual(['D-0001', 'D-0032']);
    expect((await decisionsForRule(t.paths, 'auth.session-store')).map((d) => d.id)).toEqual(['D-0031']);
    expect(await decisionsForRule(t.paths, 'pay.payment-record')).toEqual([]);
  });

  it('잘못된 파일: get · list가 경로를 담은 DecisionParseError를 던진다', async () => {
    await mkdir(t.paths.decisionsDir, { recursive: true });
    await writeFile(t.paths.decision('D-0009'), '# 결정\n\n7일\n', 'utf8');
    const fromGet = await getDecision(t.paths, 'D-0009').catch((e: unknown) => e);
    expect(fromGet).toBeInstanceOf(DecisionParseError);
    expect((fromGet as Error).message).toContain('D-0009.md');
    expect((fromGet as Error).message).toContain('front matter');
    await expect(listDecisions(t.paths)).rejects.toBeInstanceOf(DecisionParseError);
  });
});
