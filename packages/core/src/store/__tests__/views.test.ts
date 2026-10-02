import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerificationView, View } from '../../types/index.js';
import { makeHeader, source, VIEW_NAMES } from '../../views/index.js';
import { formatViewMarkdown, parseViewMarkdown, ValidationError, ViewStoreError } from '../index.js';
import { FIXED_NOW, makeTempStore, type TempStore } from './fixtures.js';

let t: TempStore;

beforeEach(async () => {
  t = await makeTempStore();
});

afterEach(() => t.cleanup());

/** 검증 View 최소 모양 — 저장소는 머리말만 검증하므로 본문은 작게 */
function verificationView(now: Date, commit?: string): VerificationView {
  const opts = commit === undefined ? { now, sources: SOURCES } : { commit, now, sources: SOURCES };
  return {
    header: makeHeader('verification', opts),
    store: { status: 'ok' },
    summary: {
      unconfirmed: 0,
      rules: 1,
      approved: 1,
      byStatus: { 'pass-verified': 0, 'pass-unverified': 0, recheck: 0, fail: 0, unchecked: 1 },
      checks: { junit: 0, static: 0 },
      quarantined: 0,
    },
    blocks: [],
    common: [],
    outOfScope: {
      blocksWithoutRules: ['auth'],
      codeWithoutRules: [],
      rulesWithoutCode: [],
      untestedFlows: { unavailable: 'no-graph' },
      unclassifiedFiles: 0,
      quarantined: [],
    },
  };
}

const SOURCES = [source.execution('plumb check', undefined, 'checks/c-0001.json'), source.store('rules.yaml')];
const MARKDOWN = '# 검증 상태\n\n출처: 실행: plumb check\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';

describe('store.views', () => {
  it('write → views/<name>.json(정본) + views/<name>.md(front matter + 본문), 임시 파일 없음, 같은 generatedAt', async () => {
    const view = verificationView(FIXED_NOW, 'a1b2c3d4e5f6a7b8');
    const written = await t.store.views.write('verification', view, MARKDOWN);
    expect(written).toEqual({ view, markdown: MARKDOWN });

    expect(await readdir(t.store.paths.viewsDir)).toEqual(['verification.json', 'verification.md']);

    const json = await readFile(t.store.paths.view('verification', 'json'), 'utf8');
    expect(JSON.parse(json)).toEqual(view);
    expect(json.endsWith('\n')).toBe(true);

    const md = await readFile(t.store.paths.view('verification', 'md'), 'utf8');
    expect(md.startsWith('---\nview: verification\n')).toBe(true);
    const parsed = parseViewMarkdown(md);
    expect(parsed.header).toEqual(view.header);
    expect(parsed.header.generatedAt).toBe(view.header.generatedAt);
    expect(parsed.header.generatedAt).toBe('2026-10-02T09:00:00.000Z');
    expect(parsed.body).toBe(MARKDOWN.replace(/\n$/, ''));
    // 본문은 front matter 뒤에 그대로 있다 (UI는 read()로 본문만 받는다)
    expect(md.endsWith(`---\n\n${MARKDOWN}`)).toBe(true);
  });

  it('read 왕복: JSON과 Markdown 본문. 없으면 null', async () => {
    expect(await t.store.views.read('architecture')).toBeNull();

    const view = verificationView(FIXED_NOW);
    await t.store.views.write('verification', view, MARKDOWN);
    const stored = await t.store.views.read('verification');
    expect(stored).not.toBeNull();
    expect(stored?.view).toEqual(view);
    expect(stored?.view.header).not.toHaveProperty('commit');
    expect(stored?.markdown).toBe(MARKDOWN.replace(/\n$/, ''));
    const verification = stored?.view as VerificationView | undefined;
    expect(verification?.outOfScope.blocksWithoutRules).toEqual(['auth']);
  });

  it('다시 쓰면 덮어쓴다 — 두 파일 모두 새 generatedAt', async () => {
    await t.store.views.write('verification', verificationView(FIXED_NOW, 'old0000'), '# v1');
    const later = new Date('2026-10-03T10:00:00.000Z');
    await t.store.views.write('verification', verificationView(later, 'new1111'), '# v2');

    const stored = await t.store.views.read('verification');
    expect(stored?.view.header.generatedAt).toBe('2026-10-03T10:00:00.000Z');
    expect(stored?.view.header.commit).toBe('new1111');
    expect(stored?.markdown).toBe('# v2');
    const md = parseViewMarkdown(await readFile(t.store.paths.view('verification', 'md'), 'utf8'));
    expect(md.header.generatedAt).toBe('2026-10-03T10:00:00.000Z');
    expect(md.header.commit).toBe('new1111');
  });

  it('list()는 탭 순서(VIEW_NAMES) — 파일 이름 순도 생성 시각 순도 아니다. 여섯 이름이 아닌 파일은 무시', async () => {
    const contract = { header: makeHeader('contract', { commit: 'c0000001', now: FIXED_NOW, sources: [] }) };
    const architecture = {
      header: makeHeader('architecture', { now: new Date('2026-10-03T00:00:00.000Z'), sources: [] }),
    };
    await t.store.views.write('contract', contract as unknown as View, '# contract');
    await t.store.views.write('verification', verificationView(FIXED_NOW, 'v0000001'), '# verification');
    await t.store.views.write('architecture', architecture as unknown as View, '# architecture');
    await writeFile(`${t.store.paths.viewsDir}/notes.json`, '{}', 'utf8');

    expect(await t.store.views.list()).toEqual([
      { name: 'architecture', generatedAt: '2026-10-03T00:00:00.000Z' },
      { name: 'verification', generatedAt: '2026-10-02T09:00:00.000Z', commit: 'v0000001' },
      { name: 'contract', generatedAt: '2026-10-02T09:00:00.000Z', commit: 'c0000001' },
    ]);
    expect(VIEW_NAMES).toEqual(['architecture', 'flow', 'changelog', 'verification', 'dependencies', 'contract']);
  });

  it('비어 있으면 list []', async () => {
    expect(await t.store.views.list()).toEqual([]);
    await rm(t.store.paths.viewsDir, { recursive: true, force: true });
    expect(await t.store.views.list()).toEqual([]);
  });

  it('이름과 머리말의 view가 다르면 ValidationError — 아무것도 쓰지 않는다', async () => {
    const view = verificationView(FIXED_NOW);
    await expect(t.store.views.write('architecture', view, '# x')).rejects.toBeInstanceOf(ValidationError);
    await expect(
      t.store.views.write('verification', { header: { view: 'verification' } }, '# x'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(t.store.views.write('bogus' as never, view, '# x')).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(t.store.paths.viewsDir)).toEqual([]);
  });

  it('JSON은 있는데 Markdown이 없거나 generatedAt이 어긋나면 ViewStoreError — 반쪽을 그리지 않는다', async () => {
    const view = verificationView(FIXED_NOW);
    await t.store.views.write('verification', view, MARKDOWN);

    await writeFile(
      t.store.paths.view('verification', 'md'),
      formatViewMarkdown({ ...view.header, generatedAt: '2026-10-01T00:00:00.000Z' }, MARKDOWN),
      'utf8',
    );
    await expect(t.store.views.read('verification')).rejects.toBeInstanceOf(ViewStoreError);

    await rm(t.store.paths.view('verification', 'md'));
    await expect(t.store.views.read('verification')).rejects.toBeInstanceOf(ViewStoreError);
  });
});

describe('formatViewMarkdown ↔ parseViewMarkdown', () => {
  it('왕복. 빈 본문도 된다. front matter가 없으면 ValidationError', () => {
    const header = makeHeader('flow', { commit: 'a1b2c3d', now: FIXED_NOW, sources: SOURCES });
    const text = formatViewMarkdown(header, 'body\n\nmore');
    expect(parseViewMarkdown(text)).toEqual({ header, body: 'body\n\nmore' });
    expect(parseViewMarkdown(formatViewMarkdown(header, ''))).toEqual({ header, body: '' });
    expect(() => parseViewMarkdown('# no front matter')).toThrow(ValidationError);
    expect(() => parseViewMarkdown('---\nview: flow\n')).toThrow(ValidationError);
  });
});
