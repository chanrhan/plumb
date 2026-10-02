/**
 * View 머리말 `ViewHeader`와 출처 `SourceRef` 만들기 (이슈 #53, work-views 3절 "생성 출처 표시줄" · "마지막 생성 시각/커밋").
 *
 * 출처 접두어 다섯 가지(screens/README 2.1)와 `SourceKind`는 1:1이다 — `파서:` parser · `실행:` execution · `저장소:` store ·
 * `git:` git · `사용자 입력:` user-input. 어느 것도 아닌 항목은 View에 넣지 않는다 (기획안 §6 "LLM이 그린 View는 안 된다").
 */

import type { SourceRef, ViewHeader, ViewName } from '../types/index.js';

export interface MakeHeaderOptions {
  /** `plumb views` 실행 시점의 HEAD. 없으면 머리말에 `commit` 키 자체가 없다 (화면은 "생성 커밋 기록 없음") */
  commit?: string;
  /** 생성 시각. `generatedAt`은 이 값의 ISO 8601 */
  now: Date;
  sources: SourceRef[];
}

/**
 * 공통 머리말. `commit`이 `undefined`면 키를 넣지 않는다 — JSON에 `"commit": undefined`가 남지 않게.
 * `sources`는 복사한다 (호출자의 배열을 나중에 바꿔도 머리말이 따라 바뀌지 않는다).
 */
export function makeHeader<N extends ViewName>(view: N, opts: MakeHeaderOptions): ViewHeader & { view: N } {
  const header: ViewHeader & { view: N } = {
    view,
    generatedAt: opts.now.toISOString(),
    sources: opts.sources.map((ref) => ({ ...ref })),
  };
  if (opts.commit !== undefined && opts.commit.length > 0) header.commit = opts.commit;
  return header;
}

/** `undefined` 값을 빼고 `SourceRef`를 만든다 — JSON · `toEqual` 양쪽에서 깔끔하게 */
function ref(kind: SourceRef['kind'], fields: Omit<SourceRef, 'kind'>): SourceRef {
  const out: SourceRef = { kind };
  if (fields.tool !== undefined) out.tool = fields.tool;
  if (fields.version !== undefined) out.version = fields.version;
  if (fields.input !== undefined) out.input = fields.input;
  if (fields.commit !== undefined) out.commit = fields.commit;
  return out;
}

/**
 * 출처 생성 헬퍼. README 2.1의 다섯 접두어와 1:1.
 *
 * - `source.parser('dependency-cruiser', '18.5', 'src')` — 코드·설정·스키마를 정적으로 읽은 결과
 * - `source.execution('vitest-junit', undefined, 'reports/junit.xml')` — 테스트·검사를 실제로 돌린 결과.
 *   저장소에 기록된 검사 결과를 읽어 그리더라도 값의 출처는 `실행:`이다 (README 2.1)
 * - `source.store('rules.yaml')` — 사람이 승인·결정·기록으로 쓴 것
 * - `source.git('a1b2c3d', 'HEAD~1..HEAD')` — git 이력에서 읽은 것
 * - `source.userInput('?block=payment')` — 화면에서 개발자가 직접 넣은 것
 */
export const source = {
  parser(tool: string, version?: string, input?: string): SourceRef {
    return ref('parser', { tool, version, input });
  },
  execution(tool: string, version?: string, input?: string): SourceRef {
    return ref('execution', { tool, version, input });
  },
  store(input?: string, commit?: string): SourceRef {
    return ref('store', { input, commit });
  },
  git(commit: string, input?: string): SourceRef {
    return ref('git', { commit, input });
  },
  userInput(input?: string): SourceRef {
    return ref('user-input', { input });
  },
} as const;
