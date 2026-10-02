import { type Approval, anchorText, describeStatusDetail, type Rule, STATUS_ICON, shortCommit } from '@plumb/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApprovePanel } from '@/components/rules/ApprovePanel';
import { APPROVAL_LABEL, CHANGE_KIND_LABEL, KIND_LABEL, STATUS_LABEL, shortTime } from '@/components/rules/format';
import { StatusIcon } from '@/components/rules/StatusIcon';
import { isRuleId, readRuleDetail } from '@/lib/rules';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<Approval['action'], string> = { propose: '제안', approve: '승인', reject: '기각' };

/**
 * 규칙 상세 (`/rules/[id]`, work-approve 3.2). 진술 · 출처 · 의존 · 검사 · 결정 기록 · 제안 diff · 승인 이력 · 승인/기각 패널.
 * 값은 전부 `readRuleDetail()`(코어 저장소)에서 온다. 규칙도 제안도 없으면 404.
 * 검사 절은 마지막 `plumb check`의 상태 기록(#47): 사유 문구(view-verification 3.3 비고 — 코어 `describeStatusDetail`) ·
 * 마지막 검사 커밋 · 시각 · 실패면 `file:line` + 메시지 (+ fast-check 반례 · 시드) · 검사 파일별 마지막 결과.
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
          {` — ${describeStatusDetail(detail.status)}`}
          {detail.statusAt === undefined
            ? ' · 검사 없음'
            : ` · ${shortCommit(detail.statusAt.commit)} · ${shortTime(detail.statusAt.checkedAt)}`}
        </p>
        {detail.status.status === 'fail' ? (
          <ul className="rule-failures">
            {detail.status.failures.map((failure) => (
              <li key={`${failure.check.ref}:${anchorText(failure.anchor)}`}>
                <code>{anchorText(failure.anchor)}</code> {failure.message.split(/\r?\n/)[0]}
                {failure.counterexample === undefined && failure.seed === undefined ? null : (
                  <small>
                    {' '}
                    · fast-check 반례: {failure.counterexample ?? '—'}
                    {failure.seed === undefined ? '' : ` · 시드 ${failure.seed}`}
                  </small>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {detail.history === undefined || detail.history.length === 0 ? null : (
          <p>
            이력: 최근 {detail.history.length}회 {detail.history.map((status) => STATUS_ICON[status]).join(' ')}
            {detail.since === undefined ? '' : ` · 이 상태 since ${shortTime(detail.since)}`}
          </p>
        )}
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
                      {check.lastResult.outcome} · {shortCommit(check.lastResult.commit)} ·{' '}
                      {shortTime(check.lastResult.finishedAt)}
                      {check.lastResult.anchor === undefined ? null : (
                        <>
                          {' '}
                          · <code>{anchorText(check.lastResult.anchor)}</code>
                        </>
                      )}
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
