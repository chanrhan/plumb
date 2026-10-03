import { describe, expect, it } from 'vitest';
import { decidePath, globToRegExp, makePathGuard, relativeToRoot, toolTargetPath } from '../path-guard.js';

const root = '/svc';
const rules = [
  { access: 'read' as const, globs: ['src/**'], mode: 'deny' as const },
  { access: 'write' as const, globs: ['test/acceptance/**'], mode: 'allow-only' as const },
];

describe('globToRegExp', () => {
  it('** · * · ? 와 특수문자', () => {
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**').test('srcx/a.ts')).toBe(false);
    expect(globToRegExp('**/*.spec.ts').test('test/acceptance/a.spec.ts')).toBe(true);
    expect(globToRegExp('**/*.spec.ts').test('a.spec.ts')).toBe(true);
    expect(globToRegExp('test/*.ts').test('test/a/b.ts')).toBe(false);
    expect(globToRegExp('.git/**').test('.git/HEAD')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
  });
});

describe('relativeToRoot · toolTargetPath', () => {
  it('절대·상대 경로를 root 기준 posix 상대로, root 밖은 ..', () => {
    expect(relativeToRoot(root, '/svc/src/a.ts')).toBe('src/a.ts');
    expect(relativeToRoot(root, 'src/a.ts')).toBe('src/a.ts');
    expect(relativeToRoot(root, '/etc/passwd')).toMatch(/^\.\./);
    expect(relativeToRoot(root, '/svc')).toBe('.');
  });
  it('도구별 경로 인자', () => {
    expect(toolTargetPath('Read', { file_path: 'a' })).toBe('a');
    expect(toolTargetPath('Grep', { pattern: 'x', path: 'src' })).toBe('src');
    expect(toolTargetPath('Grep', { pattern: 'x' })).toBe('.');
    expect(toolTargetPath('Bash', { command: 'ls' })).toBeUndefined();
  });
});

describe('decidePath — test-writer 규칙', () => {
  const cfg = { root, rules };
  it('src/** 읽기는 거부, 그 외 읽기는 허용', () => {
    expect(decidePath(cfg, 'Read', { file_path: 'src/domains/payment/refund.ts' })).toMatchObject({
      allow: false,
      access: 'read',
    });
    expect(decidePath(cfg, 'Read', { file_path: '/svc/src/x.ts' }).allow).toBe(false);
    expect(decidePath(cfg, 'Read', { file_path: 'openapi.yaml' }).allow).toBe(true);
    expect(
      decidePath(cfg, 'Read', { file_path: '.work/test-writer/stubs/src/domains/payment/refund.d.ts' }).allow,
    ).toBe(true);
  });
  it('Glob/Grep이 src나 루트 전체를 뒤지면 거부, test 아래면 허용', () => {
    expect(decidePath(cfg, 'Grep', { pattern: 'refund', path: 'src' }).allow).toBe(false);
    expect(decidePath(cfg, 'Glob', { pattern: '**/*.ts' }).allow).toBe(false); // path 없음 = cwd 전체 → src 포함
    expect(decidePath(cfg, 'Grep', { pattern: 'refund', path: 'test' }).allow).toBe(true);
  });
  it('쓰기는 test/acceptance/** 에만', () => {
    expect(decidePath(cfg, 'Write', { file_path: 'test/acceptance/refund.spec.ts' }).allow).toBe(true);
    expect(decidePath(cfg, 'Edit', { file_path: 'src/a.ts' })).toMatchObject({
      allow: false,
      reason: expect.stringContaining('안에서만'),
    });
    expect(decidePath(cfg, 'Write', { file_path: 'test/setup.ts' }).allow).toBe(false);
    expect(decidePath(cfg, 'Write', { file_path: 'package.json' }).allow).toBe(false);
  });
  it('root 밖은 읽기·쓰기 모두 거부, 파일 도구가 아니면 관여하지 않는다', () => {
    expect(decidePath(cfg, 'Read', { file_path: '../other/secret.ts' })).toMatchObject({
      allow: false,
      reason: '작업 디렉토리 밖',
    });
    expect(decidePath(cfg, 'Write', { file_path: '/tmp/x' }).allow).toBe(false);
    expect(decidePath(cfg, 'Bash', { command: 'cat src/a.ts' })).toEqual({ allow: true, access: null, relPath: null });
  });
});

describe('makePathGuard — SDK hook 출력', () => {
  it('거부면 permissionDecision deny + 로그 한 줄, 허용이면 빈 객체', async () => {
    const lines: string[] = [];
    const guard = makePathGuard({ root, rules, log: (l) => lines.push(l) });
    const base = {
      session_id: 's',
      transcript_path: '/t',
      cwd: root,
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'u',
    };
    const denied = await guard({ ...base, tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'u', {
      signal: new AbortController().signal,
    });
    expect(denied).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(lines).toEqual(['[hook] deny Read src/a.ts (src/** 읽기 금지)']);
    const allowed = await guard({ ...base, tool_name: 'Read', tool_input: { file_path: 'openapi.yaml' } }, 'u', {
      signal: new AbortController().signal,
    });
    expect(allowed).toEqual({});
  });
});
