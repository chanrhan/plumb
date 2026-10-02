import { describe, expect, it } from 'vitest';
import type { RuleStatus, SourceRef } from '../../types/index.js';
import {
  anchorLink,
  anchorUrl,
  codeSpan,
  escapeCell,
  escapeMd,
  fence,
  formatSource,
  heading,
  mdTable,
  mermaid,
  PLUMB_OPEN_SCHEME,
  parseAnchorUrl,
  SOURCE_PREFIX,
  STATUS_ICON,
  shortCommit,
  source,
  sourceBar,
  statusIcon,
} from '../index.js';

describe('mdTable', () => {
  it('GFM 표 — 헤더 · 구분선 · 행', () => {
    expect(
      mdTable(
        ['블록', '파일 수'],
        [
          ['payment', '12'],
          ['auth', '3'],
        ],
      ),
    ).toBe(['| 블록 | 파일 수 |', '| --- | --- |', '| payment | 12 |', '| auth | 3 |'].join('\n'));
  });

  it('셀의 | 는 \\| 로, 줄바꿈은 <br> 로 — 링크 · 아이콘은 그대로', () => {
    const table = mdTable(
      ['a', 'b'],
      [
        ['x | y', '🔴 [f:1](plumb://open?file=f&line=1)'],
        ['줄1\n줄2', 'z'],
      ],
    );
    expect(table.split('\n')[2]).toBe('| x \\| y | 🔴 [f:1](plumb://open?file=f&line=1) |');
    expect(table.split('\n')[3]).toBe('| 줄1<br>줄2 | z |');
    expect(escapeCell('a|b\r\nc')).toBe('a\\|b<br>c');
  });

  it('짧은 행은 빈 셀로 채우고, 헤더가 없으면 빈 문자열', () => {
    expect(mdTable(['a', 'b', 'c'], [['1']]).split('\n')[2]).toBe('| 1 |  |  |');
    expect(mdTable(['a'], [])).toBe('| a |\n| --- |');
    expect(mdTable([], [['1']])).toBe('');
  });
});

describe('mermaid · fence · codeSpan · heading · escapeMd', () => {
  it('mermaid 펜스. 끝 공백은 지우고, 안에 ``` 가 있으면 펜스를 늘린다', () => {
    expect(mermaid('flowchart LR\n  app --> payment\n')).toBe('```mermaid\nflowchart LR\n  app --> payment\n```');
    expect(mermaid('a\n```\nb')).toBe('````mermaid\na\n```\nb\n````');
    expect(fence('json', '{}')).toBe('```json\n{}\n```');
  });

  it('codeSpan은 백틱을 피한다', () => {
    expect(codeSpan('src/index.ts')).toBe('`src/index.ts`');
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('`x')).toBe('`` `x ``');
  });

  it('heading은 1~6', () => {
    expect(heading(2, '블록')).toBe('## 블록');
    expect(heading(0, 'x')).toBe('# x');
    expect(heading(9, 'x')).toBe('###### x');
  });

  it('escapeMd', () => {
    expect(escapeMd('a*b_c[d]<e>|f`g#h~i\\j')).toBe('a\\*b\\_c\\[d\\]\\<e\\>\\|f\\`g\\#h\\~i\\\\j');
    expect(escapeMd('그냥 글')).toBe('그냥 글');
  });
});

describe('anchorLink — plumb://open 스킴 (README 2.2)', () => {
  it('[file:line](plumb://open?file=<encoded>&line=<n>) — 경로는 URL 인코딩', () => {
    const anchor = { file: 'src/domains/payment/a b.ts', line: 42, block: 'payment' };
    expect(anchorUrl(anchor)).toBe('plumb://open?file=src%2Fdomains%2Fpayment%2Fa+b.ts&line=42');
    expect(anchorLink(anchor)).toBe(
      '[src/domains/payment/a b.ts:42](plumb://open?file=src%2Fdomains%2Fpayment%2Fa+b.ts&line=42)',
    );
    expect(anchorLink({ file: 'x&y=1.ts', line: 3 })).toBe('[x&y=1.ts:3](plumb://open?file=x%26y%3D1.ts&line=3)');
    expect(PLUMB_OPEN_SCHEME).toBe('plumb://open');
  });

  it('줄이 없으면 line 없이, 라벨을 주면 라벨로 (대괄호 이스케이프)', () => {
    expect(anchorLink({ file: 'test/a.spec.ts' })).toBe('[test/a.spec.ts](plumb://open?file=test%2Fa.spec.ts)');
    expect(anchorLink({ file: 'f.ts', line: 1 }, 'IDE에서 열기')).toBe('[IDE에서 열기](plumb://open?file=f.ts&line=1)');
    expect(anchorLink({ file: 'f.ts', line: 1 }, '[x]')).toBe('[\\[x\\]](plumb://open?file=f.ts&line=1)');
  });

  it('file이 없으면 링크가 없다 — 라벨만, 그마저 없으면 빈 문자열', () => {
    expect(anchorUrl({ block: 'payment' })).toBeNull();
    expect(anchorLink({ block: 'payment' })).toBe('');
    expect(anchorLink({ line: 3 }, '근거 없음')).toBe('근거 없음');
    expect(anchorLink({ file: '' })).toBe('');
  });

  it('parseAnchorUrl은 anchorUrl의 역. 다른 스킴 · file 없음 · 줄이 숫자가 아니면 null', () => {
    const anchor = { file: 'src/domains/payment/a b.ts', line: 42 };
    expect(parseAnchorUrl(anchorUrl(anchor) ?? '')).toEqual(anchor);
    expect(parseAnchorUrl('plumb://open?file=f.ts')).toEqual({ file: 'f.ts' });
    expect(parseAnchorUrl('https://example.com/?file=f.ts')).toBeNull();
    expect(parseAnchorUrl('plumb://open?line=3')).toBeNull();
    expect(parseAnchorUrl('plumb://open?file=f.ts&line=abc')).toBeNull();
  });
});

describe('sourceBar — 출처 표시줄 다섯 종류 (README 2.1)', () => {
  it('SourceKind → 접두어 매핑은 한 곳', () => {
    expect(SOURCE_PREFIX).toEqual({
      parser: '파서:',
      execution: '실행:',
      store: '저장소:',
      git: 'git:',
      'user-input': '사용자 입력:',
    });
  });

  it('다섯 종류를 · 로 잇는 한 줄', () => {
    const sources: SourceRef[] = [
      source.parser('dependency-cruiser', '18.5', 'src'),
      source.execution('vitest-junit', undefined, 'reports/junit.xml'),
      source.store('rules.yaml'),
      source.git('a1b2c3d4e5f6a7b8', 'HEAD~1..HEAD'),
      source.userInput('?block=payment'),
    ];
    expect(sourceBar(sources)).toBe(
      '출처: 파서: dependency-cruiser 18.5 (src) · 실행: vitest-junit (reports/junit.xml) · 저장소: rules.yaml · git: a1b2c3d (HEAD~1..HEAD) · 사용자 입력: ?block=payment',
    );
  });

  it('필드가 없으면 접두어만, git이 아닌 출처의 커밋은 @로, 비어 있으면 "출처: 없음"', () => {
    expect(formatSource(source.userInput())).toBe('사용자 입력:');
    expect(formatSource(source.store())).toBe('저장소:');
    expect(formatSource(source.parser('openapi'))).toBe('파서: openapi');
    expect(formatSource(source.store('checks/c-0001.json', 'a1b2c3d4e5f6a7b8'))).toBe(
      '저장소: checks/c-0001.json @a1b2c3d',
    );
    expect(formatSource(source.git('abc'))).toBe('git: abc');
    expect(sourceBar([])).toBe('출처: 없음');
    expect(shortCommit('a1b2c3d4e5f6a7b8')).toBe('a1b2c3d');
  });
});

describe('statusIcon', () => {
  it('🟢 🟡 🟠 🔴 ⬜ — rules.ts RuleStatus 주석과 같다', () => {
    const expected: Record<RuleStatus, string> = {
      'pass-verified': '🟢',
      'pass-unverified': '🟡',
      recheck: '🟠',
      fail: '🔴',
      unchecked: '⬜',
    };
    expect(STATUS_ICON).toEqual(expected);
    for (const status of Object.keys(expected) as RuleStatus[]) expect(statusIcon(status)).toBe(expected[status]);
  });
});
