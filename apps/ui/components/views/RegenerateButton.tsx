'use client';

import type { ApiError, ViewName } from '@plumb/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface RegenerateButtonProps {
  /** 비우면 전부 */
  names?: ViewName[];
  label?: string;
}

interface RegenerateBody {
  views: Array<{ name: ViewName; ok?: boolean; skipped?: string; error?: string }>;
  exitCode: number;
}

/**
 * `[재생성]` → `POST /api/views/regenerate` (work-views 3절 "오래됨 표시" 비고 · view-architecture 4절). 서버가 `plumb views`를 돌려
 * 끝날 때까지 기다리므로 버튼은 "재생성 중…"으로 잠긴다. 200이면 다시 읽는다(`router.refresh()`). 409면 "재생성 진행 중".
 */
export function RegenerateButton({ names, label }: RegenerateButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function regenerate() {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch('/api/views/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(names === undefined ? {} : { names }),
      });
      if (res.status === 409) {
        setOutcome({ kind: 'error', text: '재생성 진행 중 — 끝나면 다시 읽는다' });
        return;
      }
      if (res.status === 401) {
        setOutcome({
          kind: 'error',
          text: '세션이 없습니다. `plumb ui` 를 다시 시작하면 브라우저가 `/auth` 로 열립니다',
        });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null;
        setOutcome({ kind: 'error', text: body === null ? `오류 ${res.status}` : `${body.code}: ${body.message}` });
        return;
      }
      const body = (await res.json()) as RegenerateBody;
      const generated = body.views.filter((v) => v.ok === true).length;
      const failed = body.views.filter((v) => v.ok === false);
      const skipped = body.views.filter((v) => v.skipped !== undefined).length;
      setOutcome({
        kind: failed.length === 0 ? 'ok' : 'error',
        text: `View 갱신: ${generated} 생성 · ${failed.length} 실패 · ${skipped} 아직 없음${
          failed.length === 0 ? '' : ` — ${failed.map((f) => `${f.name}: ${f.error ?? ''}`).join(' / ')}`
        }`,
      });
      router.refresh();
    } catch (error) {
      setOutcome({ kind: 'error', text: `요청 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="regenerate">
      <button type="button" onClick={regenerate} disabled={busy}>
        {busy ? '재생성 중…' : (label ?? '재생성')}
      </button>
      {outcome === null ? null : (
        <span role={outcome.kind === 'error' ? 'alert' : 'status'} className={`regenerate-${outcome.kind}`}>
          {outcome.text}
        </span>
      )}
    </span>
  );
}
