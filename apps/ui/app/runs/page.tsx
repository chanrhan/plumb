import {
  type RuleStatus,
  RulesParseError,
  RulesValidationError,
  type RunId,
  type RunState,
  type RunSummary,
  StoreNotInitializedError,
} from '@plumb/core';
import { NewRunPanel, type PanelRule } from '@/components/runs/new-run-panel';
import { RunDetail } from '@/components/runs/run-detail';
import { RunList } from '@/components/runs/run-list';
import { readRuleList } from '@/lib/rules';
import { isRunId, isUnreadableRunFile, readRunLimits, readRunList, readRunState } from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Query = { id?: string | string[] };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 실행 · 진행 상황 (`/runs`, work-run 전체). 서버 컴포넌트 — 저장소를 직접 읽어(README 3.1) 첫 화면을 그리고, 폴링은 클라이언트
 * 컴포넌트가 `GET /api/runs` · `GET /api/runs/:id`로 이어 간다. 값은 `runs/*.json` · `rules.yaml` + 승인 기록 · `plumb.config.json`에서만.
 * 선택된 실행은 `?id=`, 기본은 가장 최근 실행 (3.2). 비어 있을 때 문구는 5절
 */
export default async function RunsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const requested = first(query.id);

  const limits = await readRunLimits();

  // 쓰는 도중 찢긴 파일이 있으면 목록을 못 읽는다 — 빈 목록 + 안내, 클라이언트 폴링(10초)이 채운다
  let runs: RunSummary[] = [];
  let listError: string | undefined;
  try {
    runs = (await readRunList()).runs;
  } catch (error) {
    if (!isUnreadableRunFile(error)) throw error;
    listError = error.message;
  }

  // 패널의 규칙 목록 + 상세의 대상 규칙 상태. rules.yaml을 읽지 못하면 패널만 막고 실행 목록은 그대로 보인다
  let rules: PanelRule[] = [];
  let rulesError: string | undefined;
  const ruleStatus: Record<string, RuleStatus> = {};
  try {
    const list = await readRuleList();
    rules = list.rules.map((item) => ({ id: item.id, status: item.status, approval: item.approval }));
    for (const item of list.rules) ruleStatus[item.id] = item.status;
  } catch (error) {
    if (
      error instanceof RulesParseError ||
      error instanceof RulesValidationError ||
      error instanceof StoreNotInitializedError
    ) {
      rulesError = error.message;
    } else {
      throw error;
    }
  }

  const selectedId: RunId | undefined = requested !== undefined && isRunId(requested) ? requested : runs[0]?.id;
  const active = runs.find((run) => run.status === 'running');

  let initial: RunState | null = null;
  if (selectedId !== undefined) {
    try {
      initial = (await readRunState(selectedId)) ?? null;
    } catch (error) {
      if (!isUnreadableRunFile(error)) throw error;
      // 쓰는 도중 읽음 — 클라이언트 폴링이 채운다
    }
  }

  return (
    <section className="runs-screen">
      <header className="runs-head">
        <h1>실행</h1>
        <NewRunPanel
          rules={rules}
          limits={limits}
          {...(active === undefined ? {} : { activeRunId: active.id })}
          {...(rulesError === undefined ? {} : { rulesError })}
        />
      </header>
      <div className="runs-body">
        <div className="runs-list">
          {listError === undefined ? null : <p role="alert">진행 파일을 읽지 못함 (쓰는 도중) — 다음 폴링에서 다시</p>}
          <RunList initial={runs} {...(selectedId === undefined ? {} : { selectedId })} />
        </div>
        <div className="runs-detail">
          {selectedId === undefined ? (
            <p className="runs-empty-detail">{runs.length === 0 ? '' : '실행을 선택하세요'}</p>
          ) : requested !== undefined && !isRunId(requested) ? (
            <p>그런 실행 없음: {requested}</p>
          ) : (
            <RunDetail key={selectedId} id={selectedId} initial={initial} ruleStatus={ruleStatus} />
          )}
        </div>
      </div>
    </section>
  );
}
