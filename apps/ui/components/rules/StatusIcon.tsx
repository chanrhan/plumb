import type { RuleStatus } from '@plumb/core';
import { STATUS_ICON, STATUS_LABEL } from './format';

/** 상태 🟢🟡🟠🔴⬜ 한 글자. 커밋 · 시각이 없으면 "검사 없음" (work-approve 5절) */
export function StatusIcon({
  status,
  statusAt,
}: {
  status: RuleStatus;
  statusAt?: { commit: string; checkedAt: string };
}) {
  const title =
    statusAt === undefined ? `${STATUS_LABEL[status]} · 검사 없음` : `${STATUS_LABEL[status]} · ${statusAt.commit}`;
  return (
    <span role="img" title={title} aria-label={title}>
      {STATUS_ICON[status]}
    </span>
  );
}
