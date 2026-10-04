/**
 * 로컬 완료 증거 진입점 (#90 · #102). testbed에서 규칙 1개를 위반 주입 1회 → `injections/<ruleId>/<i-id>.json`.
 *   pnpm --filter @plumb/core build && node packages/core/dist/run/__probe__/inject-once.js pay.refund-window [--keep]
 * 전제: 인수 테스트가 있고 통과하는 상태(파이프라인 ③까지 끝난 worktree를 원본에 반영했거나, 원본에 테스트·구현이 있음).
 * dist에서 돌린다(어댑터 레지스트리는 dist 인스턴스).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapter } from '../../adapter/load.js';
import { loadConfig } from '../../config/index.js';
import { openStore } from '../../store/index.js';
import type { RuleId } from '../../types/index.js';
import { InjectionError, injectOnce } from '../inject.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(HERE, '..', '..', '..', '..', '..', 'examples', 'testbed');

async function main(): Promise<number> {
  const ruleId = process.argv[2] as RuleId | undefined;
  if (!ruleId) {
    process.stderr.write('usage: inject-once <ruleId> [--keep]\n');
    return 2;
  }
  const { config, root } = await loadConfig({ target: TESTBED });
  const store = openStore(config, root);
  await store.init();
  const rule = await store.rules.get(ruleId);
  if (!rule) {
    process.stderr.write(`[inject] 규칙 없음: ${ruleId} (승인된 규칙만)\n`);
    return 3;
  }
  const { adapter } = await loadAdapter(config.adapter);
  const started = Date.now();
  try {
    const r = await injectOnce({
      config,
      root,
      store,
      adapter,
      rule,
      keepWorktree: process.argv.includes('--keep'),
      log: (l) => process.stdout.write(`${l}\n`),
    });
    process.stdout.write(
      `[inject] ${r.validity.id} result=${r.validity.result} valid=${r.validity.valid} · "${r.validity.description}" @ ${r.validity.anchor?.file ?? '?'}:${r.validity.anchor?.line ?? '?'}\n`,
    );
    if (r.validity.valid === false && r.validity.diffSearch)
      process.stdout.write(
        `[inject] 차이 탐색 ${r.validity.diffSearch.differingOutputs}/${r.validity.diffSearch.inputs} → ${r.validity.diffSearch.verdict}\n`,
      );
    process.stdout.write(
      `[inject] 파일: ${store.paths.injection(ruleId, r.validity.id)} · 역할 턴 ${r.role.turns} · 비용 ${r.role.costUsd ?? '?'} · wall ${Date.now() - started}ms\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof InjectionError) {
      process.stderr.write(`[inject] 실패 (${error.code}): ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

main().then((code) => process.exit(code));
