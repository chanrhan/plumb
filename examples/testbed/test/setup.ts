// Vitest setupFiles. 모든 테스트 파일 앞에서 한 번 실행된다.
// fast-check 전역 설정: 실행 횟수와 시드, 실패 보고 형식을 여기서 통일한다.
import fc from 'fast-check';

// FC_SEED=12345 pnpm test → 같은 시드로 재현. 없으면 fast-check가 매번 새 시드를 고른다.
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

/**
 * 실패 보고 형식. `Seed:`·`Counterexample:` 줄은 M5 `plumb check`가 JUnit `failure` 본문에서
 * 그대로 읽어 반례·시드를 보여 준다(docs/screens/view-verification.md 3절). 줄 머리글을 바꾸지 않는다.
 */
function report<T>(details: fc.RunDetails<T>): void {
  if (!details.failed) return;
  const lines = [
    `Property failed after ${details.numRuns} test(s)`,
    `Seed: ${details.seed}`,
    `Path: ${details.counterexamplePath ?? ''}`,
    `Counterexample: ${fc.stringify(details.counterexample)}`,
    `Shrunk ${details.numShrinks} time(s)`,
    `Got error: ${details.errorInstance instanceof Error ? details.errorInstance.stack : String(details.errorInstance)}`,
  ];
  throw new Error(lines.join('\n'));
}

fc.configureGlobal({
  numRuns: 100,
  seed,
  // 동기·비동기 property 모두 이 reporter를 쓴다 (asyncReporter를 같이 주면 fast-check가 거부한다)
  reporter: report,
});
