'use client';

import type { RunId, RunSummary } from '@plumb/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RUN_STATUS_LABEL, STAGE_MARK, startedLabel } from './format';

/** 목록은 10초마다 (work-run 4절 "폴링") */
export const LIST_POLL_MS = 10_000;

export interface RunListProps {
  initial: RunSummary[];
  selectedId?: RunId;
}

/**
 * 실행 목록 (work-run 3.2). 저장소: `runs/*.json` → `GET /api/runs`. 행 클릭 = `/runs?id=`. 비면 "실행 아직 없음" (5절).
 * 읽기 실패는 직전 목록을 유지한다
 */
export function RunList({ initial, selectedId }: RunListProps) {
  const [runs, setRuns] = useState(initial);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/runs', { credentials: 'same-origin', cache: 'no-store' });
        if (cancelled || res.status !== 200) return;
        const body = (await res.json()) as { runs: RunSummary[] };
        setRuns(body.runs);
        setNow(Date.now());
      } catch {
        /* 직전 목록 유지 */
      }
    };
    const timer = setInterval(() => void tick(), LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (runs.length === 0) return <p className="runs-empty">실행 아직 없음</p>;

  return (
    <table className="runs-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>시작</th>
          <th>상태</th>
          <th>단계</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} aria-current={run.id === selectedId ? 'true' : undefined} data-status={run.status}>
            <td>
              <Link href={`/runs?id=${encodeURIComponent(run.id)}`}>{run.id}</Link>
            </td>
            <td>{startedLabel(run.startedAt, now)}</td>
            <td>{RUN_STATUS_LABEL[run.status]}</td>
            <td>{STAGE_MARK[run.stage]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
