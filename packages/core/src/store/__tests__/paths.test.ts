import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStoreRoot, STORE_LAYOUT, storeDirectories, storePaths, ValidationError } from '../index.js';

const HOME = '/home/dev';
const ROOT = '/work/testbed';

describe('resolveStoreRoot', () => {
  it('config.store 없음 → ~/.plumb/stores/<basename(root)>/', () => {
    expect(resolveStoreRoot({}, ROOT, { home: HOME })).toBe(join(HOME, '.plumb', 'stores', 'testbed'));
  });

  it('상대 config.store → 대상 루트 기준', () => {
    expect(resolveStoreRoot({ store: './.plumb-store' }, ROOT, { home: HOME })).toBe(join(ROOT, '.plumb-store'));
  });

  it('절대 config.store → 그대로', () => {
    expect(resolveStoreRoot({ store: '/var/plumb/x' }, ROOT, { home: HOME })).toBe('/var/plumb/x');
  });

  it('상대 대상 루트는 cwd 기준으로 푼다', () => {
    expect(resolveStoreRoot({}, 'rel/testbed', { home: HOME })).toBe(join(HOME, '.plumb', 'stores', 'testbed'));
    expect(resolveStoreRoot({ store: 's' }, 'rel/testbed', { home: HOME })).toBe(resolve('rel/testbed', 's'));
  });
});

describe('storePaths', () => {
  const paths = storePaths({ store: './.plumb-store' }, ROOT, { home: HOME });
  const store = join(ROOT, '.plumb-store');

  it('레이아웃 (이슈 #31 범위)', () => {
    expect(paths.root).toBe(store);
    expect(paths.project).toBe('testbed');
    expect(paths.targetRoot).toBe(ROOT);
    expect(paths.rules).toBe(join(store, 'rules.yaml'));
    expect(paths.meta).toBe(join(store, 'meta.json'));
    expect(paths.codeOpens).toBe(join(store, 'code-opens.jsonl'));
    expect(paths.proposal('pay.refund-window', 'p-0001')).toBe(
      join(store, 'proposals', 'pay.refund-window', 'p-0001.json'),
    );
    expect(paths.proposalDir('pay.refund-window')).toBe(join(store, 'proposals', 'pay.refund-window'));
    expect(paths.approvals('pay.refund-window')).toBe(join(store, 'approvals', 'pay.refund-window.jsonl'));
    expect(paths.ruleStatus('pay.refund-window')).toBe(join(store, 'rule-status', 'pay.refund-window.json'));
    expect(paths.check('c-0001')).toBe(join(store, 'checks', 'c-0001.json'));
    expect(paths.decision('D-0001')).toBe(join(store, 'decisions', 'D-0001.md'));
    expect(paths.run('r-0003')).toBe(join(store, 'runs', 'r-0003.json'));
    expect(paths.view('verification', 'json')).toBe(join(store, 'views', 'verification.json'));
    expect(paths.view('verification', 'md')).toBe(join(store, 'views', 'verification.md'));
    expect(paths.contract('contracts/openapi.yaml')).toBe(join(store, 'contracts', 'contracts__openapi.yaml.json'));
    expect(paths.reviewQueueItem('q-0001')).toBe(join(store, 'review-queue', 'q-0001.json'));
  });

  it('폴더 목록은 레이아웃의 폴더 항목 전부', () => {
    const dirs = storeDirectories(paths);
    for (const name of [
      'proposals',
      'approvals',
      'rule-status',
      'checks',
      'decisions',
      'runs',
      'views',
      'contracts',
      'review-queue',
      'injections',
    ]) {
      expect(dirs).toContain(join(store, name));
    }
    expect(dirs).toContain(store);
    expect(Object.values(STORE_LAYOUT)).toHaveLength(13);
    expect(paths.injection('pay.refund-window', 'i-0001')).toBe(
      join(store, 'injections', 'pay.refund-window', 'i-0001.json'),
    );
  });

  it('경로 이탈 식별자는 거부한다', () => {
    expect(() => paths.approvals('../etc' as never)).toThrow(ValidationError);
    expect(() => paths.proposal('pay.x', '../../p' as never)).toThrow(ValidationError);
    expect(() => paths.run('r-a/b' as never)).toThrow(ValidationError);
    expect(() => paths.decision('D-00 01' as never)).toThrow(ValidationError);
  });
});
