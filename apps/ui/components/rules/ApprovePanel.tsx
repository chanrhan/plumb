'use client';

import type { ApiError, ApprovalState, ProposalChangeKind, ProposalId } from '@plumb/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CHANGE_KIND_LABEL } from './format';

export interface ApprovePanelProps {
  ruleId: string;
  approval: ApprovalState;
  /** 미처리 제안. 없으면 버튼이 없다 */
  proposal?: {
    id: ProposalId;
    hash: string;
    changeKind: ProposalChangeKind;
    requiresPriorApproval: boolean;
  };
}

/** work-approve 4절 오류 표 그대로 */
const MESSAGES = {
  unauthenticated: '승인되지 않음: 세션 없음. `plumb ui` 를 다시 시작하면 `/auth` 로 열립니다',
  changed: '이 규칙이 바뀌었습니다. 다시 읽습니다',
  priorApproval: '사전 승인 필요 — M10. 승인 전까지 기존 규칙 유효',
} as const;

type Outcome = { kind: 'ok'; text: string } | { kind: 'error'; text: string };

/**
 * 승인 · 기각 패널 (클라이언트 컴포넌트). `[승인]` → `POST /api/rules/:id/approve` → 200이면 다시 읽는다(`router.refresh()`).
 * 409 → "이 규칙이 바뀌었습니다. 다시 읽습니다" 뒤 다시 읽기. 401 → 세션 없음 안내, 승인 상태 표시는 그대로.
 * `[기각]`은 사유가 비어 있으면 비활성 (work-approve 3.2).
 */
export function ApprovePanel({ ruleId, approval, proposal }: ApprovePanelProps) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (proposal === undefined) {
    return (
      <section className="approve-panel">
        <h3>승인</h3>
        <p>
          처리할 제안 없음 — 승인 상태{' '}
          {approval === 'approved' ? '승인' : approval === 'rejected' ? '기각' : '잠정 (승인 기록 없음)'}
        </p>
      </section>
    );
  }

  async function post(action: 'approve' | 'reject') {
    setBusy(action);
    setOutcome(null);
    try {
      const body =
        action === 'approve'
          ? { proposalId: proposal?.id, proposalHash: proposal?.hash }
          : { proposalId: proposal?.id, proposalHash: proposal?.hash, reason };
      const res = await fetch(`/api/rules/${encodeURIComponent(ruleId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        setOutcome({ kind: 'error', text: MESSAGES.unauthenticated });
        return;
      }
      if (res.status === 409) {
        setOutcome({ kind: 'error', text: MESSAGES.changed });
        router.refresh();
        return;
      }
      if (!res.ok) {
        const error = (await res.json().catch(() => null)) as ApiError | null;
        setOutcome({ kind: 'error', text: error === null ? `오류 ${res.status}` : `${error.code}: ${error.message}` });
        return;
      }
      const data = (await res.json()) as { requiresPriorApproval?: boolean };
      if (data.requiresPriorApproval === true) {
        setOutcome({ kind: 'ok', text: MESSAGES.priorApproval });
        return;
      }
      setOutcome({ kind: 'ok', text: action === 'approve' ? '승인됨' : '기각됨' });
      setReason('');
      router.refresh();
    } catch (error) {
      setOutcome({ kind: 'error', text: `요청 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(null);
    }
  }

  const reasonEmpty = reason.trim().length === 0;

  return (
    <section className="approve-panel">
      <h3>승인</h3>
      <p>
        변경: {CHANGE_KIND_LABEL[proposal.changeKind]}
        {proposal.requiresPriorApproval ? ' → 사전 승인 필요 (승인 전까지 기존 규칙 유효)' : null}
      </p>
      <label>
        기각 사유
        <textarea
          name="reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="기각하려면 사유를 적는다 (승인 기록에 남는다)"
          disabled={busy !== null}
        />
      </label>
      <div className="approve-actions">
        <button type="button" onClick={() => post('reject')} disabled={busy !== null || reasonEmpty}>
          {busy === 'reject' ? '기각 중…' : '기각'}
        </button>
        <button type="button" onClick={() => post('approve')} disabled={busy !== null}>
          {busy === 'approve' ? '승인 중…' : '승인'}
        </button>
      </div>
      {outcome === null ? null : (
        <p role={outcome.kind === 'error' ? 'alert' : 'status'} className={`approve-${outcome.kind}`}>
          {outcome.text}
        </p>
      )}
    </section>
  );
}
