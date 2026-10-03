/**
 * 로컬 완료 증거 진입점 (이슈 #86). testbed에서 규칙 1개로 파이프라인을 1회 돌린다. CLI(`plumb run`)는 #87.
 *   pnpm --filter @plumb/core build && node packages/core/dist/run/__probe__/run-once.js pay.refund-window [--in-place]
 * **dist에서 돌린다** — 어댑터 패키지는 `@plumb/core`(dist)의 레지스트리에 등록되므로 `tsx src/…`로 돌리면
 * src 레지스트리와 갈려 "어댑터가 등록되어 있지 않다"가 난다(`plumb check`도 같은 이유로 dist에서 돈다).
 * 저장소에 승인된 규칙이 없으면 먼저 `plumb rule propose` → `plumb approve`로 승인해야 한다(①이 막는다).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapter } from '../../adapter/load.js';
import { loadConfig } from '../../config/index.js';
import { openStore } from '../../store/index.js';
import type { RuleId } from '../../types/index.js';
import { RunPreconditionError, runPipeline } from '../pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(HERE, '..', '..', '..', '..', '..', 'examples', 'testbed');

async function main(): Promise<number> {
  const ruleId = process.argv[2] as RuleId | undefined;
  if (!ruleId) {
    process.stderr.write('usage: run-once <ruleId> [--in-place]\n');
    return 2;
  }
  const inPlace = process.argv.includes('--in-place');
  const { config, root } = await loadConfig({ target: TESTBED });
  const store = openStore(config, root);
  await store.init();
  const { adapter } = await loadAdapter(config.adapter);
  const started = Date.now();
  try {
    const { state, worktree } = await runPipeline({
      config,
      root,
      store,
      adapter,
      ruleIds: [ruleId],
      inPlace,
      log: (l) => process.stdout.write(`${l}\n`),
    });
    process.stdout.write(
      `[run] ${state.id} status=${state.status} stage=${state.stage} cost=${state.costUsd ?? '?'} wall ${Date.now() - started}ms\n`,
    );
    process.stdout.write(
      `[run] stages: ${JSON.stringify(state.stages.map((s) => ({ stage: s.stage, result: s.result })))}\n`,
    );
    if (state.outcome) process.stdout.write(`[run] outcome: ${JSON.stringify(state.outcome)}\n`);
    if (worktree) process.stdout.write(`[run] worktree 남김: ${worktree.repoRoot}\n`);
    process.stdout.write(`[run] 파일: ${store.paths.run(state.id)}\n`);
    return state.status === 'completed' ? 0 : 1;
  } catch (error) {
    if (error instanceof RunPreconditionError) {
      process.stderr.write(`[run] 시작 불가 (${error.code}): ${error.message}\n`);
      return 3;
    }
    throw error;
  }
}

main().then((code) => process.exit(code));
