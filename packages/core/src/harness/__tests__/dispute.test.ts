import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDisputes, toDispute, validateDisputeText } from '../dispute.js';

describe('validateDisputeText', () => {
  it('첫 줄 요약(제목 기호 허용) + 근거 본문이 있어야 유효', () => {
    const v = validateDisputeText(
      '# 테스트가 7일 경계를 포함으로 본다\n\n규칙은 "초과"인데 테스트는 정확히 7일째도 거절을 기대한다. 입력: paidAt=2026-01-01, requestedAt=2026-01-08.',
    );
    expect(v).toMatchObject({ ok: true, summary: '테스트가 7일 경계를 포함으로 본다' });
  });
  it('빈 파일 · 짧은 요약 · 근거 없음은 무효', () => {
    expect(validateDisputeText('\n\n')).toMatchObject({ ok: false, reason: '빈 파일' });
    expect(validateDisputeText('안 됨\n근거를 충분히 길게 적었다고 치자 어쩌구 저쩌구')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('요약이 너무 짧다'),
    });
    expect(validateDisputeText('테스트가 규칙과 다르다고 생각한다\n짧음')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('근거가'),
    });
  });
});

describe('scanDisputes · toDispute', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('디렉토리가 없으면 빈 결과', async () => {
    expect(await scanDisputes('/nonexistent/disputes')).toEqual({ valid: [], invalid: [] });
  });
  it('d-*.md만 보고, 유효/무효를 가른다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plumb-disputes-'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'd-boundary.md'),
      '7일 경계 해석이 테스트와 규칙에서 다르다\n\n규칙은 초과(>7d)인데 테스트는 >=7d에서 거절을 기대한다. 입력 예: 정확히 7일.',
    );
    await writeFile(join(dir, 'd-empty.md'), '');
    await writeFile(join(dir, 'notes.md'), '이건 이의 제기 파일이 아니다 — 이름 패턴이 다르다');
    const scan = await scanDisputes(dir);
    expect(scan.valid.map((d) => d.id)).toEqual(['d-boundary']);
    expect(scan.invalid).toEqual([{ file: join(dir, 'd-empty.md'), reason: '빈 파일' }]);
    const dispute = toDispute(
      scan.valid[0] as NonNullable<(typeof scan.valid)[0]>,
      'implementer',
      'test-writer',
      '2026-10-03T00:00:00.000Z',
    );
    expect(dispute).toEqual({
      id: 'd-boundary',
      at: '2026-10-03T00:00:00.000Z',
      by: 'implementer',
      reviewer: 'test-writer',
      summary: '7일 경계 해석이 테스트와 규칙에서 다르다',
      file: join(dir, 'd-boundary.md'),
      status: 'reviewing',
    });
  });
});
