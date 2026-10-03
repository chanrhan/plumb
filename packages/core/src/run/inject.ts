/**
 * 위반 주입 1회 (이슈 #90, 기획안 §7.4). 단계 ⑤의 한 단위 — 파이프라인 연결은 M9.
 *   임시 worktree → injector 실행(Stop: 변경이 있어야 끝난다) → 어댑터로 담당 인수 테스트 실행
 *   → 실패하면 **유효 ✔**(`check-failed`), 통과하면 **무효 ✘**(`check-passed`, 차이 탐색 #91) → `injections/<ruleId>/<i-id>.json` → worktree 제거
 * 저장하는 것: 설명 한 줄 · 위치(anchor) · 커밋 · 검사 파일 해시. 패치 본문은 저장하지 않는다.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Adapter, AdapterContext } from '../adapter/types.js';
import { hasDiffTargets, recordDiffSearch, runDiffSearch } from '../checks/diff-search.js';
import { injectorOptions, parseInjectionOutput } from '../harness/roles/injector.js';
import { runRole as defaultRunRole, type RoleRunResult, type RunRoleInput } from '../harness/run-role.js';
import { makeStopHook } from '../harness/stop.js';
import { resolveWorkRoot } from '../harness/work-dir.js';
import { sha256 } from '../store/fs.js';
import type { Store } from '../store/index.js';
import { nextInjectionId, writeInjection } from '../store/injections.js';
import type { InjectionId, PlumbConfig, Rule, RunId, Validity } from '../types/index.js';
import { collectEvidence } from './evidence.js';
import { changedPath, createWorktree, removeWorktree, type Worktree, worktreeChanges } from './worktree.js';

export interface InjectOnceDeps {
  config: PlumbConfig;
  /** `plumb.config.json`이 있는 원본 루트 */
  root: string;
  store: Pick<Store, 'paths' | 'reviewQueue'>;
  adapter: Pick<Adapter, 'runTests'>;
  rule: Rule;
  /** 차이 탐색(#91)의 `DiffSearch.runId`. 없으면 `r-0000`(파이프라인 밖 단독 실행) */
  runId?: RunId;
  /** 차이 탐색을 끈다(시험용). 기본: `plumb/diff-targets.ts`가 있으면 돈다 */
  diffSearch?: boolean;
  /** 기록 id. 없으면 다음 번호 */
  id?: InjectionId;
  runRole?: (input: RunRoleInput) => Promise<RoleRunResult>;
  createWorktree?: (serviceRoot: string, dir: string) => Promise<Worktree>;
  /** worktree를 남긴다(디버깅). 기본 false → 제거 */
  keepWorktree?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
  stderr?: (data: string) => void;
}

export interface InjectOnceResult {
  validity: Validity;
  role: { turns: number; costUsd: number | null; outcome: RoleRunResult['outcome'] };
  changedFiles: string[];
  worktree?: Worktree;
}

export class InjectionError extends Error {
  constructor(
    readonly code: 'no-change' | 'role-failed' | 'no-acceptance-tests',
    message: string,
  ) {
    super(message);
    this.name = 'InjectionError';
  }
}

function acceptanceFiles(rule: Rule): string[] {
  return rule.checks.filter((c) => c.kind === 'acceptance' || c.kind === 'pbt').map((c) => c.ref);
}

async function hashFiles(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      out[f] = sha256(await readFile(join(root, f), 'utf8'));
    } catch {
      out[f] = 'missing';
    }
  }
  return out;
}

export async function injectOnce(deps: InjectOnceDeps): Promise<InjectOnceResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const runRole = deps.runRole ?? defaultRunRole;
  const files = acceptanceFiles(deps.rule);
  if (files.length === 0)
    throw new InjectionError('no-acceptance-tests', `${deps.rule.id}: 인수 테스트가 없어 주입을 시험할 수 없다`);

  const origServiceRoot = resolve(deps.root, deps.config.service);
  const id = deps.id ?? (await nextInjectionId(deps.store.paths, deps.rule.id));
  const dir = join(resolveWorkRoot(deps.config, deps.root), 'injections', `${deps.rule.id}-${id}`, 'repo');
  const make = deps.createWorktree ?? ((s, d) => createWorktree({ serviceRoot: s, dir: d }));
  const worktree = await make(origServiceRoot, dir);
  const serviceRoot = worktree.serviceRoot;
  const ctx: AdapterContext = { root: serviceRoot, config: deps.config };
  log(`[inject] ${id} worktree ${worktree.repoRoot} @ ${worktree.commit.slice(0, 7)}`);

  try {
    // Stop: worktree에 변경이 있어야 끝낼 수 있다 (증거는 git status — 모델의 말이 아니다)
    const stop = makeStopHook({
      kind: 'all-pass-or-dispute',
      stopBlockLimit: deps.config.stopBlockLimit,
      collect: async () => {
        const changed = await worktreeChanges(worktree);
        return changed.length > 0
          ? { tally: { total: 1, passed: 1, failed: 0 } }
          : { tally: { total: 1, passed: 0, failed: 1 }, runnerError: undefined, hasDispute: false };
      },
      log,
    });
    const r = await runRole({
      prompt: `규칙 ${deps.rule.id}("${deps.rule.statement}")을 위반하도록 구현을 한 곳만 바꿔라. 끝낼 때 JSON으로 설명과 위치를 답하라.`,
      options: injectorOptions({
        config: deps.config,
        rule: deps.rule,
        cwd: serviceRoot,
        stopHook: stop.hook,
        stderr: deps.stderr,
        log,
      }),
    });
    const changedFiles = (await worktreeChanges(worktree)).map(changedPath);
    if (!r.ok) throw new InjectionError('role-failed', `injector 실패: ${r.outcome}`);
    if (changedFiles.length === 0) throw new InjectionError('no-change', 'injector가 아무것도 바꾸지 않았다');

    const structured =
      r.result && r.result.subtype === 'success'
        ? (r.result as { structured_output?: unknown }).structured_output
        : undefined;
    const out = parseInjectionOutput(structured) ?? {
      description: `구현 변경: ${changedFiles.join(', ')}`,
      file: changedFiles[0] ?? '',
    };

    const logPath = join(deps.store.paths.injectionDir(deps.rule.id), `${id}.output.log`);
    const ev = await collectEvidence({ adapter: deps.adapter, ctx, scope: files, expectedFiles: files, logPath });
    const caught = ev.tally.total > 0 && ev.tally.failed > 0;
    log(
      `[inject] ${id} 테스트 ${ev.tally.failed}/${ev.tally.total} 실패 → ${caught ? '유효 ✔ (잡힘)' : '무효 ✘ (통과해 버림)'}`,
    );

    const base = {
      id,
      ruleId: deps.rule.id,
      description: out.description,
      anchor: {
        file: out.file,
        ...(out.line === undefined ? {} : { line: out.line }),
        ...(deps.rule.block ? { block: deps.rule.block } : {}),
      },
      commit: worktree.commit,
      at: now().toISOString(),
      checkFileHashes: await hashFiles(origServiceRoot, files),
    };
    let validity: Validity = caught
      ? { ...base, result: 'check-failed', valid: true }
      : { ...base, result: 'check-passed', valid: false };
    await writeInjection(deps.store.paths, validity);

    // 통과해 버린 주입 → 차이 탐색 (#91). 대상 정의(plumb/diff-targets.ts)가 있을 때만
    if (validity.valid === false && deps.diffSearch !== false && (await hasDiffTargets(origServiceRoot))) {
      const out = await runDiffSearch({
        originalRoot: origServiceRoot,
        injectedRoot: serviceRoot,
        ruleId: deps.rule.id,
        numRuns: deps.config.diffSearch?.numRuns ?? 1000,
        seed: deps.config.diffSearch?.seed,
      });
      const recorded = await recordDiffSearch({
        store: deps.store,
        validity,
        runId: deps.runId ?? ('r-0000' as RunId),
        out,
      });
      validity = recorded;
      log(`[inject] ${id} 차이 탐색 ${out.differing}/${out.inputs} → ${recorded.diffSearch.verdict}`);
    }
    return {
      validity,
      role: { turns: r.turns, costUsd: r.costUsd, outcome: r.outcome },
      changedFiles,
      ...(deps.keepWorktree ? { worktree } : {}),
    };
  } finally {
    if (!deps.keepWorktree) await removeWorktree(origServiceRoot, worktree).catch(() => undefined);
  }
}
