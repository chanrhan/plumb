/**
 * 블록 트리 사이드바와 `GET /api/blocks`가 공유하는 서버 쪽 읽기 모델 (이슈 #121, README 2절 공통 레이아웃). 값은 전부 코어에서 온다 —
 * 목 데이터 없음. 계산은 코어 `computeBlocksResponse`, 여기는 입력 네 가지를 모을 뿐이다:
 *
 * - 파서: `plumb.config.json` `blocks`(`getConfig`) · 아키텍처 View JSON(`store.views.read('architecture')` — 없으면 `null` → `no-graph`)
 * - 저장소: `rules.yaml`(`store.rules.list`) · 마지막 `plumb check`의 상태 기록(`store.ruleStatus.list`)
 *
 * View JSON은 있는데 Markdown이 없으면 코어가 `ViewStoreError`를 던진다 — 반쪽을 조용히 그리지 않는다. 호출자(layout · route)가 메시지를 정한다.
 */

import { type ArchitectureView, type BlocksResponse, computeBlocksResponse } from '@plumb/core';
import { getConfig } from './rules';
import { getStore } from './store';

/** 저장소의 아키텍처 View JSON 중 블록 트리가 쓰는 부분. 아직 생성 안 됐으면 `null` */
export async function readArchitectureGraph(): Promise<Pick<ArchitectureView, 'blocks' | 'unclassified'> | null> {
  const store = await getStore();
  const stored = await store.views.read('architecture');
  if (stored === null || stored.view.header.view !== 'architecture') return null;
  const view = stored.view as ArchitectureView;
  return { blocks: view.blocks, unclassified: view.unclassified };
}

/** `GET /api/blocks` 200 본문이자 사이드바의 입력 */
export async function readBlocksResponse(): Promise<BlocksResponse> {
  const store = await getStore();
  const [config, rules, statuses, graph] = await Promise.all([
    getConfig(),
    store.rules.list(),
    store.ruleStatus.list(),
    readArchitectureGraph(),
  ]);
  return computeBlocksResponse({ config, rules, statuses, graph });
}
