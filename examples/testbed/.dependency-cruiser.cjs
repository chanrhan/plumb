/**
 * dependency-cruiser 설정 — 블록 구조 규칙 (기획안 §4.4·§12)
 *
 * 블록 = `src/domains/<도메인>/`. 공개 진입점 = `src/domains/<도메인>/index.ts`.
 * 규칙 이름은 기획안 §12 필수 검사 번호를 따른다:
 *   (1) 블록은 선언된 공개 계약으로만 접근           → block-1-*
 *   (2) 의존 방향은 선언된 것만 · 순환 금지            → block-2-*
 *   (3) 공개 계약 시그니처 변경은 설계 변경 이벤트     → depcruise가 아니라 git diff (M8). 여기 없음
 * 위반은 `summary.violations[]`(from · to · rule.name)로 나온다. `pnpm depcruise:json`의 JSON은
 * M8 아키텍처 View의 블록 그래프 원료다 (`modules[].source`, `modules[].dependencies[].resolved`,
 * `dependencyTypes`, `summary.violations[]`). docs/screens/view-architecture.md 3절.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'block-1-public-entry-only',
      comment:
        '필수 검사 (1). src/app/**·src/lib/** 등 도메인 밖에서 도메인 내부 파일을 import하면 안 된다. ' +
        'src/domains/<d>/index.ts(공개 진입점)만 허용',
      severity: 'error',
      from: { pathNot: '^src/domains/' },
      to: { path: '^src/domains/', pathNot: '^src/domains/[^/]+/index\\.ts$' },
    },
    {
      name: 'block-1-public-entry-only-cross-domain',
      comment:
        '필수 검사 (1). 다른 도메인의 내부 파일을 import하면 안 된다. 상대 도메인의 index.ts만 허용. ' +
        '($1 = from의 도메인 이름)',
      severity: 'error',
      from: { path: '^src/domains/([^/]+)/' },
      to: { path: '^src/domains/', pathNot: ['^src/domains/$1/', '^src/domains/[^/]+/index\\.ts$'] },
    },
    {
      name: 'block-2-no-cycles',
      comment: '필수 검사 (2). 순환 의존 금지. 파일 수준 순환도 잡는다 (블록 수준으로 접는 것은 M8)',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'block-2-declared-direction',
      comment:
        '필수 검사 (2). 도메인 간 import는 선언된 방향만. 지금은 선언이 없으므로(plumb.config.json 없음) ' +
        '도메인 간 import를 전부 금지한다. plumb.config.json `blocks.<d>.dependsOn`이 생기면 ' +
        '이 규칙은 거기서 생성한다 — 선언된 (from → to) 쌍만 to.pathNot에 추가. ($1 = from의 도메인 이름)',
      severity: 'error',
      from: { path: '^src/domains/([^/]+)/' },
      to: { path: '^src/domains/', pathNot: '^src/domains/$1/' },
    },
    {
      name: 'prisma-only-in-repo',
      comment:
        '@prisma/client(와 생성된 .prisma/client)는 src/domains/<d>/repo.ts에서만 import한다. ' +
        'DB 접근 경계가 한 파일이어야 L0 간선(앱 → DB)과 블록을 맞출 수 있다 (view-architecture 3절)',
      severity: 'error',
      from: { pathNot: '^src/domains/[^/]+/repo\\.ts$' },
      to: { path: '(^|node_modules/)(@prisma/client|\\.prisma/client)(/|$)' },
    },
    {
      name: 'app-thin',
      comment:
        'src/app/**은 얇게. 도메인 공개 진입점(src/domains/<d>/index.ts), src/lib/**, next·react(-dom)만 ' +
        'import한다. 그 밖의 것(도메인 내부, DB 클라이언트, 다른 npm 패키지)을 쓰고 싶으면 도메인이나 lib로 옮긴다',
      severity: 'error',
      from: { path: '^src/app/' },
      to: {
        pathNot: [
          '^src/domains/[^/]+/index\\.ts$',
          '^src/lib/',
          '^src/app/.*\\.css$',
          '(^|node_modules/)(next|react|react-dom)(/|$)',
          'node_modules/@types/(next|react|react-dom)(/|$)',
        ],
      },
    },
  ],
  options: {
    // 테스트 파일은 그래프에서 뺀다 — 같은 도메인의 내부 파일을 직접 import하는 것이 정상이다.
    // (M8의 미분류 파일 계산도 테스트·설정 파일을 plumb.config.json `ignore`로 제외한다)
    exclude: { path: ['\\.test\\.tsx?$', '\\.spec\\.tsx?$', '/__tests__/'] },
    // node_modules는 간선의 끝점으로만 둔다(어떤 패키지를 쓰는지 — L0 간선의 원료). 그 안은 따라가지 않는다
    doNotFollow: { path: 'node_modules' },
    // `@/*` 별칭은 tsconfig.json `paths`로 해석한다
    tsConfig: { fileName: 'tsconfig.json' },
    // `import type`도 간선으로 센다 — 타입 의존도 블록 경계를 넘으면 위반이다
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
