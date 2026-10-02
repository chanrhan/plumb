import type { Approval, Rule } from '@plumb/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApprovePanel } from '@/components/rules/ApprovePanel';
import { APPROVAL_LABEL, CHANGE_KIND_LABEL, KIND_LABEL, STATUS_LABEL, shortTime } from '@/components/rules/format';
import { StatusIcon } from '@/components/rules/StatusIcon';
import { isRuleId, readRuleDetail } from '@/lib/rules';

export const dynamic = 'force-dynamic';

const UNCHECKED_REASON = {
  'no-checks': '검사 없음',
  'check-missing': '검사 파일 없음',
  unapproved: '미승인',
  quarantined: '불안정 격리',
  'not-run': '아직 안 돌림',
} as const;

const ACTION_LABEL: Record<Approval['action'], string> = { propose: '제안', approve: '승인', reject: '기각' };

/**
 * 규칙 상세 (`/rules/[id]`, work-approve 3.2). 진술 · 출처 · 의존 · 검사 · 결정 기록 · 제안 diff · 승인 이력 · 승인/기각 패널.
 * 값은 전부 `readRuleDetail()`(코어 저장소)에서 온다. 규칙도 제안도 없으면 404.
 */
export default async function RuleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  if (!isRuleId(id)) notFound();
  const detail = await readRuleDetail(id);
  if (detail === undefined) notFound();

  const shown: Rule | null = detail.rule ?? detail.proposal?.after ?? detail.proposal?.before ?? null;
  const proposal = detail.proposal;

  return (
    <article className="rule-detail">
      <p>
        <Link href="/rules">← 규칙 목록</Link>
      </p>
      <header className="rules-head">
        <h1>{id}</h1>
        <p>
          {shown?.kind === undefined ? null : <span>{KIND_LABEL[shown.kind]}</span>}
          {shown?.block === undefined ? null : <span> · {shown.block}</span>}
          {detail.highRisk ? <span title="고위험"> · ⚡ 고위험</span> : null}
          <span> · 승인 {APPROVAL_LABEL[detail.approval]}</span>
          {detail.approval === 'provisional' ? <span> · ⚠ 미확인</span> : null}
        </p>
      </header>

      {proposal === undefined ? null : (
        <p>
          변경: {CHANGE_KIND_LABEL[proposal.changeKind]}
          {proposal.requiresPriorApproval ? ' → 사전 승인 필요 (승인 전까지 기존 규칙 유효)' : null}
          {detail.rule === undefined ? ' (승인 전까지 rules.yaml 에 없음)' : null}
        </p>
      )}

      <section>
        <h2>진술</h2>
        {shown === null ? <p>삭제 제안 — 진술 없음</p> : <p className="statement">{shown.statement}</p>}
        {shown?.summary === undefined ? null : <p>요약: {shown.summary}</p>}
        <p>출처: {shown?.source ?? '—'}</p>
      </section>

      <section>
        <h2>의존</h2>
        {detail.depends.length === 0 ? (
          <p>의존 없음</p>
        ) : (
          <ul>
            {detail.depends.map((dep) => (
              <li key={dep.ruleId}>
                {dep.exists ? <Link href={`/rules/${encodeURIComponent(dep.ruleId)}`}>{dep.ruleId}</Link> : dep.ruleId}{' '}
                <StatusIcon status={dep.status} />
                {dep.exists ? null : <span> (규칙 없음)</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>검사</h2>
        <p>
          <StatusIcon status={detail.status.status} statusAt={detail.statusAt} /> {STATUS_LABEL[detail.status.status]}
          {detail.status.status === 'unchecked' ? ` — ${UNCHECKED_REASON[detail.status.reason]}` : null}
          {detail.statusAt === undefined
            ? ' · 검사 없음'
            : ` · ${detail.statusAt.commit} · ${shortTime(detail.statusAt.checkedAt)}`}
        </p>
        {detail.checks.length === 0 ? (
          <p>검사 없음</p>
        ) : (
          <ul>
            {detail.checks.map((check) => (
              <li key={`${check.check.kind}:${check.check.ref}`}>
                <code>{check.check.ref}</code> <small>({check.check.kind})</small>{' '}
                {check.exists ? (
                  check.lastResult === undefined ? (
                    <span>⬜ 검사 없음</span>
                  ) : (
                    <span>
                      {check.lastResult.outcome} · {check.lastResult.commit} · {shortTime(check.lastResult.finishedAt)}
                    </span>
                  )
                ) : (
                  <span>⬜ 파일 없음</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>결정</h2>
        {detail.decisionFile === undefined ? (
          <p>결정 기록 없음</p>
        ) : detail.decisionFile.exists ? (
          <p>
            {detail.decisionFile.id} — 있음 (<code>{detail.decisionFile.path}</code>). 네 항목(결정 · 이유 · 기각 ·
            감수)은 #35
          </p>
        ) : (
          <p>{detail.decisionFile.id} 파일 없음</p>
        )}
      </section>

      <section>
        <h2>변경 diff</h2>
        {proposal === undefined ? (
          <p>현재 제안 없음</p>
        ) : (
          <>
            <p>
              제안 {proposal.id} · {shortTime(proposal.proposedAt)} ·{' '}
              {proposal.proposedBy === 'cli' ? 'cli' : `run ${proposal.proposedBy}`}
            </p>
            <pre className="rule-diff">
              {detail.diff.map((line) => (
                <div
                  key={`${line.op}${line.field}`}
                  className={`diff-${line.op === '+' ? 'add' : line.op === '-' ? 'del' : 'same'}`}
                >
                  {line.op} {line.text}
                </div>
              ))}
            </pre>
          </>
        )}
      </section>

      <section>
        <h2>이력</h2>
        {detail.approvals.length === 0 && proposal === undefined ? (
          <p>승인 이력 없음</p>
        ) : (
          <ul>
            {proposal === undefined ? null : (
              <li>
                제안 {shortTime(proposal.proposedAt)} (
                {proposal.proposedBy === 'cli' ? 'cli' : `run ${proposal.proposedBy}`}) · {proposal.id}
              </li>
            )}
            {detail.approvals.map((record) => (
              <li key={`${record.at}-${record.action}-${record.proposalId}`}>
                {ACTION_LABEL[record.action]} {shortTime(record.at)} · {record.by} · {record.proposalId}
                {record.reason === undefined ? null : ` · 사유: ${record.reason}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ApprovePanel
        ruleId={id}
        approval={detail.approval}
        proposal={
          proposal === undefined || detail.proposalHash === undefined
            ? undefined
            : {
                id: proposal.id,
                hash: detail.proposalHash,
                changeKind: proposal.changeKind,
                requiresPriorApproval: proposal.requiresPriorApproval,
              }
        }
      />
    </article>
  );
}
