import { RulesParseError, RulesValidationError, StoreNotInitializedError, shortCommit } from '@plumb/core';
import Link from 'next/link';
import { shortTime } from '@/components/rules/format';
import { RuleRow } from '@/components/rules/RuleRow';
import { applyRuleListFilter, hasFilter, parseRuleListFilter, readRuleList } from '@/lib/rules';

export const dynamic = 'force-dynamic';

type Query = Record<string, string | string[] | undefined>;

const KIND_OPTIONS = [
  ['', '전체'],
  ['architecture', 'arch'],
  ['technical', 'tech'],
  ['business', 'biz'],
] as const;
const APPROVAL_OPTIONS = [
  ['', '전체 (기각 제외)'],
  ['provisional', '잠정'],
  ['approved', '승인'],
  ['rejected', '기각'],
] as const;
const STATUS_OPTIONS = [
  ['', '전체'],
  ['unchecked', '⬜ 검사 없음'],
  ['fail', '🔴 실패'],
  ['recheck', '🟠 재검사'],
  ['pass-unverified', '🟡 통과'],
  ['pass-verified', '🟢 통과 · 유효'],
] as const;

/**
 * 규칙 목록 · 승인 (`/rules`, work-approve 3.1). 서버 컴포넌트 — `getStore()`를 직접 부른다 (README 3.1).
 * 필터는 URL 쿼리 `?block= &kind= &approval= &status=` (기본 전체, 6절 5번). 행을 누르면 `/rules/<id>` 상세.
 * 상태 열은 마지막 `plumb check`의 `rule-status/` 기록(#47). 머리줄에 마지막 검사 커밋 · 시각 — 없으면 "마지막 검사 없음".
 */
export default async function RulesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const filter = parseRuleListFilter(query);

  let list: Awaited<ReturnType<typeof readRuleList>>;
  try {
    list = await readRuleList();
  } catch (error) {
    if (error instanceof RulesParseError) {
      return (
        <section>
          <h1>규칙 · 승인</h1>
          <p role="alert">
            rules.yaml 을 읽지 못함: {error.line === undefined ? '' : `${error.line}줄 · `}
            {error.message}. 승인 불가
          </p>
        </section>
      );
    }
    if (error instanceof RulesValidationError || error instanceof StoreNotInitializedError) {
      return (
        <section>
          <h1>규칙 · 승인</h1>
          <p role="alert">보호 저장소를 읽지 못함: {error.message}</p>
        </section>
      );
    }
    throw error;
  }

  const rows = applyRuleListFilter(list.rules, filter);
  const blocks = [...new Set(list.rules.map((item) => item.block).filter((b): b is string => b !== undefined))].sort();
  const longest = list.longestPendingDays;

  return (
    <section>
      <header className="rules-head">
        <h1>규칙 · 승인</h1>
        <p>
          ⚠ 미확인 {list.unconfirmed}건{longest === undefined ? '' : ` · 최장 ${longest}일 체류`}
          {list.lastCheck === undefined
            ? ' · 마지막 검사 없음'
            : ` · 마지막 검사 ${shortCommit(list.lastCheck.commit)} · ${shortTime(list.lastCheck.finishedAt)}`}
        </p>
      </header>
      {list.queueLimit.exceeded ? (
        <p role="alert" className="queue-limit">
          ┃ 대기열 상한: 미확인 {list.queueLimit.maxUnconfirmed}건 초과 또는 {list.queueLimit.maxDays}일 초과 → 신규
          제안 중단 (M10) ┃
        </p>
      ) : null}

      <form method="get" action="/rules" className="rules-filter">
        <span>필터:</span>
        <label>
          블록{' '}
          <select name="block" defaultValue={filter.block ?? ''}>
            <option value="">전체</option>
            {blocks.map((block) => (
              <option key={block} value={block}>
                {block}
              </option>
            ))}
          </select>
        </label>
        <label>
          종류{' '}
          <select name="kind" defaultValue={filter.kind ?? ''}>
            {KIND_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          승인{' '}
          <select name="approval" defaultValue={filter.approval ?? ''}>
            {APPROVAL_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          상태{' '}
          <select name="status" defaultValue={filter.status ?? ''}>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">적용</button>
        {hasFilter(filter) ? <Link href="/rules">필터 해제</Link> : null}
      </form>

      {list.rules.length === 0 ? (
        <p>
          규칙 아직 없음. <code>plumb rule draft</code> (M3) 로 만들거나 <code>rules.yaml</code> 에 직접 적습니다
        </p>
      ) : rows.length === 0 ? (
        <p>
          조건에 맞는 규칙 없음 · <Link href="/rules">필터 해제</Link>
        </p>
      ) : (
        <table className="rules-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>블록</th>
              <th>종류</th>
              <th>진술</th>
              <th>상태</th>
              <th>승인</th>
              <th>
                <span className="sr-only">미확인</span>
              </th>
              <th>
                <span className="sr-only">고위험</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <RuleRow key={item.id} item={item} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
