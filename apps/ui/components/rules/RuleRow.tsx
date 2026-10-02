import type { RuleListItem } from '@plumb/core';
import Link from 'next/link';
import { APPROVAL_LABEL, KIND_SHORT } from './format';
import { StatusIcon } from './StatusIcon';

/** 목록 한 행 = 규칙 하나 (work-approve 3.1). 열: ID · 블록 · 종류 · EARS 한 줄 · 상태 · 승인 · ⚠ 미확인 · ⚡ */
export function RuleRow({ item }: { item: RuleListItem }) {
  return (
    <tr>
      <td>
        <Link href={`/rules/${encodeURIComponent(item.id)}`}>{item.id}</Link>
      </td>
      <td>
        {item.block ?? '—'}
        {item.block !== undefined && !item.blockKnown ? <span title="블록 트리에 없는 블록"> ?</span> : null}
      </td>
      <td>
        <abbr title={item.kind}>{KIND_SHORT[item.kind]}</abbr>
      </td>
      <td className="statement">{item.statement}</td>
      <td>
        <StatusIcon status={item.status} statusAt={item.statusAt} />
      </td>
      <td>{APPROVAL_LABEL[item.approval]}</td>
      <td>{item.approval === 'provisional' ? <span title="잠정 — 사람이 아직 확인하지 않음">⚠ 미확인</span> : null}</td>
      <td>{item.highRisk ? <span title="고위험 (risk: high 또는 고위험 블록)">⚡</span> : null}</td>
    </tr>
  );
}
