import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../../types/index.js';
import { DecisionParseError, formatDecision, parseDecision, validateDecision } from '../index.js';
import { EXAMPLE_DECISION_PATH, REDIS_DECISION } from './fixtures.js';

/** YAML 주석(`# …`) 줄을 뺀 원문. 주석은 값이 아니므로 왕복에서 사라진다 */
function withoutYamlComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('# '))
    .join('\n');
}

describe('formatDecision · parseDecision', () => {
  it('왕복: 형식으로 쓴 것을 다시 읽으면 같은 기록이고, 다시 쓰면 같은 원문이다', () => {
    const text = formatDecision(REDIS_DECISION);
    const parsed = parseDecision(text);
    expect(parsed).toEqual(REDIS_DECISION);
    expect(formatDecision(parsed)).toBe(text);
  });

  it('형식: front matter 키 순서 · flow 연결 목록 · 네 절 고정 순서', () => {
    expect(formatDecision(REDIS_DECISION)).toBe(
      [
        '---',
        'id: D-0031',
        'title: 세션 저장소로 redis 도입',
        'block: auth',
        'at: 2026-09-21T00:00:00Z',
        'session: r-118',
        'links:',
        '  rules: [ auth.session-store, auth.refresh-rotation ]',
        '  commits: [ a1b2c3d ]',
        '  packages: [ ioredis ]',
        '  services: [ cache:redis ]',
        '---',
        '## 결정',
        '',
        'refresh 토큰 화이트리스트를 redis에 둔다',
        '',
        '## 이유',
        '',
        `${REDIS_DECISION.reason}`,
        '',
        '## 기각한 대안',
        '',
        '- in-memory — 인스턴스가 둘 이상이면 회전 검증이 깨짐',
        '- DB 테이블 — 요청마다 조회, 만료 정리 배치 필요',
        '',
        '## 감수하는 것',
        '',
        '인프라 의존 1개 추가. redis 장애 시 로그인 불가',
        '',
      ].join('\n'),
    );
  });

  it('예시 D-0001.md: 파서를 통과하고 incomplete가 빈 배열이며 주석만 빼면 원문 그대로 다시 써진다', async () => {
    const text = await readFile(EXAMPLE_DECISION_PATH, 'utf8');
    const record = parseDecision(text, EXAMPLE_DECISION_PATH);
    expect(record.id).toBe('D-0001');
    expect(record.title).toBe('환불 기간 7일을 규칙으로 둔다');
    expect(record.block).toBe('payment');
    expect(record.date).toBe('2026-10-02T03:00:00Z');
    expect(record.session).toBeUndefined();
    expect(record.links).toEqual({ rules: ['pay.refund-window'], commits: [], events: [], packages: [], services: [] });
    expect(record.reason).toContain('PAY-02');
    expect(record.rejected).toContain('14일');
    expect(record.rejected).toContain('30일');
    expect(record.rejected).toContain('기간 없음');
    expect(record.accepted).toContain('7일 정각');
    expect(record.extra).toBeUndefined();
    expect(validateDecision(record)).toEqual({ incomplete: [], noReason: false });
    expect(formatDecision(record)).toBe(withoutYamlComments(text));
  });

  it('session 없음 → `session: null`, 빈 events는 쓰지 않고 읽으면 []', () => {
    const { session: _s, ...noSession } = REDIS_DECISION;
    const text = formatDecision(noSession);
    expect(text).toContain('\nsession: null\n');
    expect(text).not.toContain('events');
    expect(parseDecision(text)).toEqual(noSession);
  });

  it('events가 있으면 쓰고 읽는다 (도구가 역으로 채운 값)', () => {
    const record: DecisionRecord = { ...REDIS_DECISION, links: { ...REDIS_DECISION.links, events: ['E-0007'] } };
    const text = formatDecision(record);
    expect(text).toContain('  events: [ E-0007 ]');
    expect(parseDecision(text)).toEqual(record);
  });

  it('절 순서가 바뀌어도 읽히고, 다시 쓰면 고정 순서다', () => {
    const shuffled = [
      '---',
      'id: D-0002',
      'title: 순서 바뀜',
      'at: 2026-10-02T03:00:00Z',
      '---',
      '## 감수하는 것',
      '감수',
      '## 이유',
      '이유',
      '## 기각한 대안',
      '기각',
      '## 결정',
      '결정',
      '',
    ].join('\n');
    const record = parseDecision(shuffled);
    expect(record).toEqual({
      id: 'D-0002',
      title: '순서 바뀜',
      date: '2026-10-02T03:00:00Z',
      decision: '결정',
      reason: '이유',
      rejected: '기각',
      accepted: '감수',
      links: { rules: [], commits: [], events: [], packages: [], services: [] },
    });
    const formatted = formatDecision(record);
    expect(formatted.indexOf('## 결정')).toBeLessThan(formatted.indexOf('## 이유'));
    expect(formatted.indexOf('## 이유')).toBeLessThan(formatted.indexOf('## 기각한 대안'));
    expect(formatted.indexOf('## 기각한 대안')).toBeLessThan(formatted.indexOf('## 감수하는 것'));
  });

  it('모르는 절은 extra에 보존되고 왕복해도 남는다', () => {
    const text = `${formatDecision(REDIS_DECISION)}\n## 참고 링크\n\n- https://example.com\n\n## 후속\n`;
    const record = parseDecision(text);
    expect(record.extra).toEqual([
      { heading: '참고 링크', body: '- https://example.com' },
      { heading: '후속', body: '' },
    ]);
    expect(formatDecision(record)).toBe(text);
    expect(parseDecision(formatDecision(record))).toEqual(record);
  });

  it('없는 절은 빈 문자열이다 (빈 절 판정은 validateDecision)', () => {
    const record = parseDecision('---\nid: D-0003\ntitle: 결정만\nat: 2026-10-02T03:00:00Z\n---\n## 결정\n\n7일\n');
    expect(record.decision).toBe('7일');
    expect(record.reason).toBe('');
    expect(record.rejected).toBe('');
    expect(record.accepted).toBe('');
  });

  it('코드 펜스 안의 `## `은 절 제목이 아니고 본문은 그대로 남는다', () => {
    const body = '```md\n## 이것은 제목이 아니다\n```';
    const record = parseDecision(
      `---\nid: D-0004\ntitle: 펜스\nat: 2026-10-02T03:00:00Z\n---\n## 결정\n\n${body}\n\n## 이유\n\n이유\n`,
    );
    expect(record.decision).toBe(body);
    expect(record.extra).toBeUndefined();
  });

  it('잘못된 파일 → DecisionParseError', () => {
    const front = '---\nid: D-0005\ntitle: 제목\nat: 2026-10-02T03:00:00Z\n---\n';
    const cases: Array<[string, string, string]> = [
      ['front matter 없음', '## 결정\n\n7일\n', 'front matter'],
      ['닫는 --- 없음', '---\nid: D-0005\n## 결정\n', '닫는 ---'],
      ['YAML 오류', '---\nid: [\n---\n## 결정\n', 'YAML'],
      ['절 제목 없음', `${front}그냥 글\n`, '절 제목'],
      ['절 제목 없음(빈 본문)', front, '절 제목'],
      ['첫 절 앞에 본문', `${front}머리말\n\n## 결정\n\n7일\n`, '첫 절 제목 앞'],
      ['같은 절 두 번', `${front}## 결정\n\n하나\n\n## 결정\n\n둘\n`, '두 번'],
      ['id 형식', '---\nid: D-1\ntitle: 제목\nat: 2026-10-02T03:00:00Z\n---\n## 결정\n', 'id'],
      ['id 없음', '---\ntitle: 제목\nat: 2026-10-02T03:00:00Z\n---\n## 결정\n', 'id'],
      ['at 형식', '---\nid: D-0005\ntitle: 제목\nat: 어제\n---\n## 결정\n', 'at'],
      ['title 비어 있음', '---\nid: D-0005\ntitle: ""\nat: 2026-10-02T03:00:00Z\n---\n## 결정\n', 'title'],
      [
        'session 형식',
        '---\nid: D-0005\ntitle: 제목\nat: 2026-10-02T03:00:00Z\nsession: s-118\n---\n## 결정\n',
        'session',
      ],
      [
        '규칙 ID 형식',
        '---\nid: D-0005\ntitle: 제목\nat: 2026-10-02T03:00:00Z\nlinks:\n  rules: [refund]\n---\n## 결정\n',
        'links.rules',
      ],
      [
        '알 수 없는 연결 키',
        '---\nid: D-0005\ntitle: 제목\nat: 2026-10-02T03:00:00Z\nlinks:\n  issues: []\n---\n## 결정\n',
        'links.issues',
      ],
      ['알 수 없는 키', '---\nid: D-0005\ntitle: 제목\nat: 2026-10-02T03:00:00Z\nauthor: me\n---\n## 결정\n', 'author'],
    ];
    for (const [label, text, fragment] of cases) {
      let error: unknown;
      try {
        parseDecision(text, 'decisions/D-0005.md');
      } catch (e) {
        error = e;
      }
      expect(error, label).toBeInstanceOf(DecisionParseError);
      expect((error as Error).message, label).toContain('decisions/D-0005.md');
      expect((error as Error).message, label).toContain(fragment);
    }
  });
});
