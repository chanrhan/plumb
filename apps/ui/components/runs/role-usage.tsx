import type { Role, RunState } from '@plumb/core';
import { usd } from './format';

/** 표에 항상 보이는 세 역할 (와이어프레임). rule-drafter는 사용량이 있을 때만 */
const SHOWN: readonly Role[] = ['test-writer', 'implementer', 'injector'];

/** 예산 줄 (work-run 3.3 "예산 사용량", 5절 "costUsd 없음"). "추정"은 비용의 원자료가 SDK 결과 메시지라서 */
export function budgetText(state: RunState): string {
  const max = state.limits.maxBudgetUsd;
  const maxText = Number.isFinite(max) ? usd(max) : '상한 없음';
  if (state.costUsd === null) return `예산 — / ${maxText} (비용 정보 없음)`;
  if (!Number.isFinite(max) || max <= 0) return `예산 ${usd(state.costUsd)} (추정) / ${maxText}`;
  const ratio = Math.min(1, state.costUsd / max);
  const filled = Math.round(ratio * 10);
  return `예산 ${usd(state.costUsd)} (추정) / ${maxText} ${'▓'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(ratio * 100)}%`;
}

/**
 * 역할별 반복 · 종료 차단 (work-run 3.3). 저장소: `roles.{role}.{turns,stopBlocks}` / 상한은 `limits`.
 * 둘 다 0이면 `—` (아직 안 돈 역할)
 */
export function RoleUsage({ state }: { state: RunState }) {
  const roles: Role[] = [
    ...SHOWN,
    ...(Object.keys(state.roles) as Role[]).filter(
      (role) => !SHOWN.includes(role) && (state.roles[role].turns > 0 || state.roles[role].stopBlocks > 0),
    ),
  ];
  const current = state.currentRole;
  const currentUsage = current === null ? null : state.roles[current];
  return (
    <section className="role-usage">
      <p>
        현재 역할 <strong>{current ?? '—'}</strong>
        {currentUsage === null ? null : (
          <span>
            {' '}
            · 반복 {currentUsage.turns} / {state.limits.maxTurns[current as Role] ?? '—'} · 종료 차단{' '}
            {currentUsage.consecutiveStopBlocks} / {state.limits.stopBlockLimit}
          </span>
        )}
      </p>
      <table className="role-table">
        <thead>
          <tr>
            <th>역할별</th>
            <th>반복</th>
            <th>차단</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => {
            const usage = state.roles[role];
            const idle = usage.turns === 0 && usage.stopBlocks === 0;
            return (
              <tr key={role} aria-current={role === current ? 'true' : undefined}>
                <td>{role}</td>
                <td>{idle ? '—' : `${usage.turns} / ${state.limits.maxTurns[role] ?? '—'}`}</td>
                <td>{idle ? '—' : `${usage.stopBlocks} / ${state.limits.stopBlockLimit}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="budget">{budgetText(state)}</p>
    </section>
  );
}
