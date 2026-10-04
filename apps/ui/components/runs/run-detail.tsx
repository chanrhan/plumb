'use client';

import type { ApiError, RuleStatus, RunId, RunState } from '@plumb/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { STATUS_ICON } from '@/components/rules/format';
import { clock, DISPUTE_STATUS_LABEL, durationLabel, elapsedLabel, FAIL_REASON_LABEL, usd } from './format';
import { OutputTail } from './output-tail';
import { RoleUsage } from './role-usage';
import { StageTrack } from './stage-track';

/** 진행 중일 때 `GET /api/runs/:id` 간격 (work-run 4절 "1~2초") */
export const DETAIL_POLL_MS = 1500;
/** `updatedAt`이 이보다 오래 그대로면 경고 (4절 오류 표) */
export const STALE_MS = 60_000;
/** 연속 읽기 실패가 이만큼이면 "진행 파일을 읽지 못함" */
export const READ_FAILURE_LIMIT = 3;

const NO_SESSION = '세션이 없습니다. `plumb ui` 를 다시 시작하면 브라우저가 `/auth` 로 열립니다';

export interface RunDetailProps {
  id: RunId;
  /** 서버가 읽은 첫 상태. 찢긴 파일이면 `null` — 폴링이 채운다 */
  initial: RunState | null;
  /** 대상 규칙의 마지막 검사 상태 (저장소 `rule-status/`). 없으면 ⬜ */
  ruleStatus: Record<string, RuleStatus>;
}

/** 종료 줄 (work-run 2절 "종료된 실행의 마지막 줄"). 실패 · 예산 초과는 "→ 검토 대기열" (§15.4) */
export function outcomeText(state: RunState): string {
  const outcome = state.outcome;
  if (state.status === 'running' || outcome === undefined) {
    return state.status === 'running'
      ? '종료: — (진행 중)'
      : `종료: ${state.status} ${state.finishedAt ? clock(state.finishedAt) : ''}`;
  }
  const at = clock(outcome.finishedAt);
  switch (outcome.status) {
    case 'completed':
      return `종료: 완료 ${at} (${durationLabel(state.startedAt, outcome.finishedAt)})`;
    case 'failed':
      return `종료: 실패 ${at} · ${FAIL_REASON_LABEL[outcome.reason]}${outcome.role ? ` · ${outcome.role}` : ''} → 검토 대기열 ${outcome.queueItemId}`;
    case 'budget-exceeded':
      return `종료: 예산 초과 ${at} · ${usd(outcome.costUsd)} / ${usd(outcome.maxBudgetUsd)} → 검토 대기열 ${outcome.queueItemId}`;
    case 'aborted':
      return `종료: 중단 ${at} · 사용자 (${outcome.signal})`;
  }
}

type AbortUi = { kind: 'idle' } | { kind: 'requesting' } | { kind: 'requested' } | { kind: 'error'; text: string };

/**
 * 실행 상세 (work-run 3.3 전부). 값은 `runs/<id>.json` 하나에서만 온다. 진행 중이면 1.5초마다 다시 읽고, 404/503(쓰는 도중)이면
 * 직전 응답을 그대로 둔다 — 3회 연속이면 "진행 파일을 읽지 못함". 종료 상태로 바뀌면 폴링을 멈추고 서버 컴포넌트를 다시 그린다
 * (`router.refresh()` → `[▶ 새 실행]`이 살아난다). 시계(`now`)는 effect에서만 움직여 서버 렌더와 어긋나지 않는다
 */
export function RunDetail({ id, initial, ruleStatus }: RunDetailProps) {
  const router = useRouter();
  const [state, setState] = useState<RunState | null>(initial);
  const [failures, setFailures] = useState(0);
  const [session, setSession] = useState(true);
  const [now, setNow] = useState<number | null>(null);
  const [abort, setAbort] = useState<AbortUi>({ kind: 'idle' });

  const running = state === null || state.status === 'running';

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!running || !session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (cancelled) return;
        if (res.status === 200) {
          const body = (await res.json()) as RunState;
          setState(body);
          setFailures(0);
          if (body.status !== 'running') router.refresh();
          return;
        }
        if (res.status === 401) {
          setSession(false);
          return;
        }
        // 404(spawn 직후) · 503(쓰는 도중) — 직전 응답 유지
        setFailures((n) => n + 1);
      } catch {
        if (!cancelled) setFailures((n) => n + 1);
      }
    };
    const timer = setInterval(() => void tick(), DETAIL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, running, session, router]);

  async function requestAbort() {
    if (state === null) return;
    const ok = globalThis.confirm(
      `실행 ${state.id} 을 중단합니까? 지금까지의 테스트 파일과 구현은 worktree 에 남습니다`,
    );
    if (!ok) return;
    setAbort({ kind: 'requesting' });
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/abort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ confirm: true }),
      });
      if (res.status === 202) {
        setAbort({ kind: 'requested' });
        return;
      }
      if (res.status === 401) {
        setAbort({ kind: 'error', text: NO_SESSION });
        return;
      }
      const body = (await res.json().catch(() => null)) as ApiError | null;
      setAbort({
        kind: 'error',
        text:
          res.status === 409
            ? '이미 끝난 실행입니다 — 다음 폴링에 반영됩니다'
            : body === null
              ? `오류 ${res.status}`
              : `${body.code}: ${body.message}`,
      });
    } catch (error) {
      setAbort({ kind: 'error', text: `요청 실패: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  if (state === null) {
    return (
      <section className="run-detail" aria-busy="true">
        <h2>{id}</h2>
        <p role="status">
          {failures >= READ_FAILURE_LIMIT ? '진행 파일을 읽지 못함 (3회 연속)' : '진행 파일을 읽는 중…'}
        </p>
        {session ? null : <p role="alert">{NO_SESSION}</p>}
      </section>
    );
  }

  const updatedAgoSec =
    now === null ? null : Math.max(0, Math.round((now - new Date(state.updatedAt).getTime()) / 1000));
  const stale = state.status === 'running' && now !== null && now - new Date(state.updatedAt).getTime() > STALE_MS;
  const elapsed =
    state.status === 'running'
      ? now === null
        ? '—'
        : elapsedLabel(now - new Date(state.startedAt).getTime())
      : state.finishedAt === undefined
        ? '—'
        : elapsedLabel(new Date(state.finishedAt).getTime() - new Date(state.startedAt).getTime());

  return (
    <section className="run-detail">
      <header className="run-detail-head">
        <h2>
          {state.id} · {clock(state.startedAt)} · 경과 {elapsed}
        </h2>
        <p>
          마지막 갱신 {updatedAgoSec === null ? '—' : `${updatedAgoSec}초 전`} · pid {state.pid}
        </p>
        {stale ? (
          <p role="alert" className="run-stale">
            ⚠ 60초 넘게 갱신 없음. 프로세스가 멈췄을 수 있습니다 (pid {state.pid})
          </p>
        ) : null}
        {failures >= READ_FAILURE_LIMIT ? (
          <p role="alert">진행 파일을 읽지 못함 ({failures}회 연속) — 직전 상태를 보이고 있습니다</p>
        ) : null}
        {session ? null : <p role="alert">{NO_SESSION}</p>}
        <p>
          대상:{' '}
          {state.ruleIds.map((ruleId, index) => (
            <span key={ruleId}>
              {index > 0 ? ' · ' : ''}
              <Link href={`/rules/${encodeURIComponent(ruleId)}`}>{ruleId}</Link>{' '}
              {STATUS_ICON[ruleStatus[ruleId] ?? 'unchecked']}
            </span>
          ))}
        </p>
      </header>

      <StageTrack state={state} />
      <RoleUsage state={state} />

      <section className="run-disputes">
        {state.disputes.length === 0 ? (
          <p>이의 제기: 없음</p>
        ) : (
          <details open>
            <summary>이의 제기: ⚠ {state.disputes.length}건</summary>
            <ul>
              {state.disputes.map((dispute) => (
                <li key={dispute.id}>
                  {clock(dispute.at)} {dispute.by} → {dispute.reviewer} {DISPUTE_STATUS_LABEL[dispute.status]}
                  {dispute.advisory === undefined ? null : <small> · 재검토(참고용): {dispute.advisory.verdict}</small>}
                  <br />
                  <q>{dispute.summary}</q>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <OutputTail output={state.capturedOutput} />

      <footer className="run-detail-foot">
        <span>{outcomeText(state)}</span>
        {state.status === 'running' ? (
          <span className="run-abort">
            <button
              type="button"
              onClick={() => void requestAbort()}
              disabled={abort.kind === 'requesting' || abort.kind === 'requested'}
            >
              {abort.kind === 'requesting' || abort.kind === 'requested' ? '중단 요청함…' : '중단'}
            </button>
            {abort.kind === 'error' ? <span role="alert">{abort.text}</span> : null}
          </span>
        ) : null}
      </footer>
    </section>
  );
}
