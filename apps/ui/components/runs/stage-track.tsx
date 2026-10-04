import type { RunState, Stage, StageRecord, StageResult } from '@plumb/core';
import { STATUS_ICON } from '@/components/rules/format';
import { clock, STAGE_LABEL, STAGE_MARK, STAGES } from './format';

/** 한 단계의 표시 (work-run 4절 "단계 표시"). 끝난 실행이 멈춘 단계는 ● 대신 "멈춤" */
export type StageMarkKind = 'done' | 'active' | 'stopped' | 'pending';

export interface StageRow {
  stage: Stage;
  kind: StageMarkKind;
  /** 같은 단계의 가장 최근 기록. ⑤→② 되돌아가면 attempt가 오른다 → "n회차" */
  record?: StageRecord;
}

/** 단계마다 `stages[]`의 **가장 최근** 기록으로 그린다. 기록이 없고 `stage`보다 앞이면(① 등) ✔로 본다 — `stage` 가 n이면 ①~(n-1)은 ✔ */
export function stageRows(state: RunState): StageRow[] {
  return STAGES.map((stage) => {
    const record = [...state.stages].reverse().find((s) => s.stage === stage);
    let kind: StageMarkKind;
    if (record?.finishedAt !== undefined) kind = 'done';
    else if (record !== undefined) kind = state.status === 'running' ? 'active' : 'stopped';
    else if (stage < state.stage) kind = 'done';
    else if (stage === state.stage && state.status === 'running') kind = 'active';
    else kind = 'pending';
    return { stage, kind, ...(record === undefined ? {} : { record }) };
  });
}

const MARK: Record<StageMarkKind, string> = { done: '✔', active: '●', stopped: '● 멈춤', pending: '' };

/** 단계 결과 한 줄 (work-run 3.3 "단계 ② 결과" · "③ 결과" · "④ 결과"). ⑤⑥은 M7 · M8 — 자리만 */
export function stageResultText(result: StageResult): string {
  switch (result.stage) {
    case 1: {
      const times = Object.values(result.approvedAt).filter((t) => t.length > 0);
      return times.length === 0 ? '' : times.map(clock).join(' · ');
    }
    case 2:
      return `${result.allFailed ? '🔴' : '⚠'} ${result.tests.failed}/${result.tests.total} 실패${result.allFailed ? '' : ' (전부 실패해야 ✔)'}`;
    case 3:
      return `${result.allPassed ? '🟢' : '🔴'} ${result.tests.passed}/${result.tests.total} 통과${
        result.disputeId === undefined ? '' : ` · 이의 제기 ${result.disputeId}`
      }`;
    case 4:
      return Object.entries(result.byRule)
        .map(([ruleId, status]) => `${STATUS_ICON[status]} ${ruleId}`)
        .join(' · ');
    case 5:
      return `주입 ${result.injections}건 · 잡힘 ${result.caught}건${result.weak ? ' · 약함 → ②' : ''}`;
    case 6:
      return `View ${result.viewsUpdated}개 갱신 · 검토 대기열 ${result.queued}건`;
  }
}

function timeSpan(record: StageRecord): string {
  const from = clock(record.startedAt);
  return record.finishedAt === undefined ? `${from}→` : `${from}→${clock(record.finishedAt)}`;
}

/**
 * 단계 ①~⑥ 표 (work-run 2절 와이어프레임). ✔ 끝 · ● 진행 · 빈칸 미도달. "n회차"는 `attempt > 1`.
 * 값은 전부 `runs/<id>.json`의 `stage` · `stages[]` — 에이전트의 자기 보고는 어디에도 없다
 */
export function StageTrack({ state }: { state: RunState }) {
  return (
    <table className="stage-track">
      <tbody>
        {stageRows(state).map(({ stage, kind, record }) => (
          <tr key={stage} data-stage={stage} data-kind={kind}>
            <th scope="row">
              {STAGE_MARK[stage]} {STAGE_LABEL[stage]}
            </th>
            <td className="stage-mark">{MARK[kind]}</td>
            <td className="stage-attempt">
              {record !== undefined && record.attempt > 1 ? `${record.attempt}회차` : ''}
            </td>
            <td className="stage-time">{record === undefined ? '' : timeSpan(record)}</td>
            <td className="stage-result">{record?.result === undefined ? '' : stageResultText(record.result)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
