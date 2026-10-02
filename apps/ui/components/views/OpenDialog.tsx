'use client';

import type { ApiError, CodeOpenReason, CodeOpenResponse, ViewName } from '@plumb/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type OpenTarget, REASON_OPTIONS } from './reasons';

export interface OpenDialogProps {
  target: OpenTarget;
  view: ViewName;
  onClose(): void;
}

const MESSAGES = {
  unauthenticated: '세션이 없습니다. `plumb ui` 를 다시 시작하면 브라우저가 `/auth` 로 열립니다',
} as const;

/**
 * 코드 열기 대화창 (work-views 2절 두 번째 그림, README 2.2). 이유 라디오 하나가 필수 — 고르지 않으면 [IDE에서 열기]가 비활성이다.
 * `[IDE에서 열기]` → `POST /api/open { view, item, file, line, reason, note }` → 200이면 닫고 다시 읽는다(열람 횟수 +1).
 * IDE 명령이 실패했으면(`record.result.status: 'failed'`) 대화창에 "IDE를 열지 못함: <명령>" — 기록은 이미 남았다 (6절 3번).
 */
export function OpenDialog({ target, view, onClose }: OpenDialogProps) {
  const router = useRouter();
  const [reason, setReason] = useState<CodeOpenReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          view,
          item: target.label,
          file: target.file,
          ...(target.line === undefined ? {} : { line: target.line }),
          reason,
          ...(note.trim().length === 0 ? {} : { note: note.trim() }),
        }),
      });
      if (res.status === 401) {
        setError(MESSAGES.unauthenticated);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null;
        setError(body === null ? `오류 ${res.status}` : `${body.code}: ${body.message}`);
        return;
      }
      const data = (await res.json()) as CodeOpenResponse;
      if (data.record.result.status === 'failed') {
        setError(`IDE를 열지 못함: ${data.record.result.command} — ${data.record.result.error} (기록은 남았다)`);
        router.refresh();
        return;
      }
      router.refresh();
      onClose();
    } catch (err) {
      setError(`요청 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="open-dialog-backdrop">
      <div className="open-dialog" role="dialog" aria-modal="true" aria-labelledby="open-dialog-title">
        <h3 id="open-dialog-title">코드 열기</h3>
        <p>
          <code>{target.label}</code>
        </p>
        <fieldset disabled={busy}>
          <legend>왜 코드를 보려 하는가 (하나 고르기)</legend>
          {REASON_OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
              />{' '}
              {option.label} <small>{option.hint}</small>
            </label>
          ))}
          <label>
            메모 한 줄
            <input
              type="text"
              name="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="비워도 된다"
            />
          </label>
        </fieldset>
        <div className="open-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="button" onClick={submit} disabled={busy || reason === null}>
            {busy ? '여는 중…' : 'IDE에서 열기'}
          </button>
        </div>
        {error === null ? null : <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
