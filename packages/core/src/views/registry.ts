/**
 * View 생성기 등록소 (이슈 #60). `plumb views`와 `plumb check --views`가 이 표를 돈다.
 *
 * `VIEW_NAMES` 여섯 개를 전부 돌되, 여기 등록되지 않은 이름은 "아직 없음"(`skipped: 'not-implemented'`)으로 적는다 —
 * 빈 자리를 목 데이터로 채우지 않는다 (CLAUDE.md "하지 않는 것"). 새 생성기는 **정적 import 한 줄 + 표에 한 줄**로 붙는다.
 *
 * 여섯 개 모두 등록됨 (#54 #55 #56 #57 #58 #59).
 */

import type { View, ViewName } from '../types/index.js';
import { architectureView } from './architecture.js';
import { changelogView } from './changelog.js';
import { contractView } from './contract.js';
import { dependenciesView } from './dependencies.js';
import { flowGenerator } from './flow.js';
import type { ViewGenerator } from './types.js';
import { verificationView } from './verification.js';

/** 이름 → 생성기. 없는 이름은 아직 구현되지 않은 View */
export type ViewGeneratorMap = Partial<Record<ViewName, ViewGenerator<View>>>;

export const VIEW_GENERATORS: ViewGeneratorMap = {
  architecture: architectureView,
  flow: flowGenerator,
  changelog: changelogView,
  verification: verificationView,
  dependencies: dependenciesView,
  contract: contractView,
};

/**
 * 어댑터로 대상 레포의 테스트 러너를 실제로 돌리는 생성기 (`flow` → `collectTraces()`가 vitest를 띄운다).
 * 다른 생성기(`extractDependencies` · `readSchemas`)와 같은 `reports/`를 두고 겹치지 않게 **병렬 묶음이 끝난 뒤 하나씩** 돌린다.
 */
export const TEST_RUNNER_VIEWS: ReadonlySet<ViewName> = new Set<ViewName>(['flow']);

/** 미구현 View가 들어올 마일스톤 · 이슈 (화면 5절 "M? 에서 구현") */
export const VIEW_PLANNED_IN: Partial<Record<ViewName, string>> = {};

export function isViewImplemented(name: ViewName, generators: ViewGeneratorMap = VIEW_GENERATORS): boolean {
  return generators[name] !== undefined;
}
