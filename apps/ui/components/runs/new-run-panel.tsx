'use client';

import type { ApiError, ApprovalState, CreateRunResponse, RuleId, RuleStatus, RunId } from '@plumb/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
// 클라이언트 번들에는 코어의 값(Node 전용 모듈을 끌어온다)을 넣지 않는다 — 아이콘 · 라벨은 화면 쪽 복사본
import { APPROVAL_LABEL, STATUS_ICON } from '@/components/rules/format';
import type { RunLimitsView } from '@/lib/runs';
import { usd } from './format';

/** 패널의 규칙 한 줄 — 저장소: `rules.yaml` + 승인 기록 + 마지막 검사 결과 (`GET /api/rules`의 행에서 뽑는다) */
export interface PanelRule {
  id: RuleId;
  status: RuleStatus;
  approval: ApprovalState;
}

export interface NewRunPanelProps {
  rules: PanelRule[];
  limits: RunLimitsView;
  /** 진행 중인 실행. 있으면 버튼 비활성 + "r-0003 이 진행 중" (동시 1개) */
  activeRunId?: RunId;
  /** `rules.yaml`을 읽지 못했을 때의 메시지 — 패널은 열리지 않는다 */
  rulesError?: string;
}

/** work-run 4절 오류 표 그대로 */
const MESSAGES = {
  unauthenticated: '실행되지 않음: 세션 없음. `plumb ui` 를 다시 시작하면 `/auth` 로 열립니다',
  noBudget: '상한 없음 (plumb.config.json 에 run.maxBudgetUsd 를 적으세요)',
} as const;

export function limitsText(limits: RunLimitsView): string {
  const turns = Object.entries(limits.maxTurns)
    .map(([role, max]) => `${role} ${max}`)
    .join(' · ');
  return `${limits.maxBudgetUsd === undefined ? MESSAGES.noBudget : `예산 상한 ${usd(limits.maxBudgetUsd)}`} · 역할별 maxTurns ${
    turns.length === 0 ? '—' : turns
  } · stopBlockLimit ${limits.stopBlockLimit}`;
}

/**
 * `[▶ 새 실행]` + 펼침 패널 (work-run 3.1 · 4절 · 5절). 승인된 규칙만 체크 가능, 잠정은 보이되 `선택 불가`. 첫 슬라이스는 1개 선택.
 * `[시작]` → `POST /api/runs { ruleIds }` → 201이면 `/runs?id=<id>`로 이동하고 패널을 닫는다. 400 · 409는 서버 메시지 그대로(체크 유지),
 * 500은 "실행 프로세스를 시작하지 못함". 상한이 없으면 `[시작]` 비활성 — 상한 없는 실행은 허용하지 않는다 (§15.4)
 */
export function NewRunPanel({ rules, limits, activeRunId, rulesError }: NewRunPanelProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<RuleId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approved = rules.filter((rule) => rule.approval === 'approved');
  const disabledReason =
    rulesError !== undefined
      ? `규칙을 읽지 못함: ${rulesError}`
      : activeRunId !== undefined
        ? `${activeRunId} 이 진행 중`
        : rules.length === 0
          ? '규칙이 없습니다'
          : approved.length === 0
            ? '승인된 규칙이 없습니다. /rules 에서 승인하세요'
            : null;

  async function start() {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ruleIds: [selected] }),
      });
      if (res.status === 201) {
        const body = (await res.json()) as CreateRunResponse;
        setOpen(false);
        setSelected(null);
        router.push(`/runs?id=${encodeURIComponent(body.id)}`);
        router.refresh();
        return;
      }
      if (res.status === 401) {
        setError(MESSAGES.unauthenticated);
        return;
      }
      const body = (await res.json().catch(() => null)) as ApiError | null;
      if (res.status === 500) {
        setError(`실행 프로세스를 시작하지 못함: ${body?.message ?? `오류 ${res.status}`}`);
        return;
      }
      setError(body === null ? `오류 ${res.status}` : body.message);
    } catch (err) {
      setError(`요청 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="new-run">
      <div className="new-run-bar">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabledReason !== null}
          aria-expanded={open}
          title={disabledReason ?? undefined}
        >
          ▶ 새 실행
        </button>
        {disabledReason === null ? null : <span className="new-run-reason">{disabledReason}</span>}
      </div>
      {open && disabledReason === null ? (
        <fieldset className="new-run-panel" disabled={busy}>
          <legend>새 실행</legend>
          <p>규칙 선택 (승인된 규칙만)</p>
          <ul>
            {rules.map((rule) => {
              const selectable = rule.approval === 'approved';
              return (
                <li key={rule.id}>
                  <label>
                    <input
                      type="checkbox"
                      name="ruleId"
                      value={rule.id}
                      checked={selected === rule.id}
                      disabled={!selectable}
                      onChange={() => setSelected(selected === rule.id ? null : rule.id)}
                    />{' '}
                    {rule.id} {STATUS_ICON[rule.status]} {APPROVAL_LABEL[rule.approval]}
                    {selectable ? '' : ' ⚠ (선택 불가)'}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="new-run-limits">{limitsText(limits)}</p>
          {error === null ? null : (
            <p role="alert" className="new-run-error">
              {error}
            </p>
          )}
          <div className="new-run-actions">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void start()}
              disabled={selected === null || limits.maxBudgetUsd === undefined || busy}
              title={limits.maxBudgetUsd === undefined ? MESSAGES.noBudget : undefined}
            >
              {busy ? '시작 중…' : '시작'}
            </button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
