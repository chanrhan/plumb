/**
 * 이의 제기 흐름 (이슈 #88, 기획안 §8.4 · §9.2). ③ 뒤에 유효한 이의 제기 파일이 있으면:
 *   1. `Dispute`(status reviewing)로 상태 파일에 적는다 — 파이프라인이 이미 했다면 그대로 쓴다
 *   2. test-writer를 **읽기 전용 · 구조화 출력**으로 1회 띄워 재검토(`advisory`)를 받는다. 결과는 참고용 — 규칙 상태를 바꾸지 않는다
 *   3. 어떤 판정이든 검토 대기열(`kind: 'dispute'`)에 올리고 `Dispute.status: 'queued'` + `queueItemId`
 * 재검토가 실패(예산 · 턴 · 예외)해도 대기열에는 올라간다 — 사람이 보는 것이 종착점이다.
 */

import { parseReviewOutput, type ReviewOutput, testWriterReviewOptions } from '../harness/roles/test-writer.js';
import type { RoleRunResult, RunRoleInput } from '../harness/run-role.js';
import type { Store } from '../store/index.js';
import type { Dispute, PlumbConfig, Rule } from '../types/index.js';

export interface DisputeFlowInput {
  config: Pick<PlumbConfig, 'roles'>;
  store: Pick<Store, 'reviewQueue'>;
  rules: readonly Rule[];
  /** 상태 파일의 `disputes[]` 중 아직 `reviewing`인 것 */
  disputes: readonly Dispute[];
  /** 이의 제기 파일 본문을 읽는다 (파일 경로 → 텍스트) */
  readFile: (path: string) => Promise<string>;
  /** 역할 cwd(worktree 서비스 루트) */
  cwd: string;
  runId: Dispute['queueItemId'] extends never ? never : `r-${string}`;
  runRole: (input: RunRoleInput) => Promise<RoleRunResult>;
  now?: () => Date;
  log?: (line: string) => void;
  stderr?: (data: string) => void;
}

export interface ReviewedDispute {
  dispute: Dispute;
  review: ReviewOutput | undefined;
  /** 재검토 역할 실행의 원자료 (RoleUsage 누적용) */
  usage: { turns: number; costUsd: number | null };
}

export async function reviewDispute(input: DisputeFlowInput, dispute: Dispute): Promise<ReviewedDispute> {
  const log = input.log ?? (() => {});
  const now = input.now ?? (() => new Date());
  const rule = input.rules[0];
  let review: ReviewOutput | undefined;
  let usage = { turns: 0, costUsd: null as number | null };
  if (rule) {
    try {
      const body = await input.readFile(dispute.file);
      const options = testWriterReviewOptions({
        config: input.config,
        rule,
        dispute: { summary: dispute.summary, body },
        cwd: input.cwd,
        log,
        stderr: input.stderr,
      });
      const r = await input.runRole({ prompt: '이의 제기를 읽고 테스트 파일과 규칙 진술을 대조해 판정하라.', options });
      usage = { turns: r.turns, costUsd: r.costUsd };
      const structured =
        r.result && r.result.subtype === 'success'
          ? (r.result as { structured_output?: unknown }).structured_output
          : undefined;
      review = parseReviewOutput(structured ?? (r.answer ? safeJson(r.answer) : undefined));
      log(`[dispute] ${dispute.id} 재검토 → ${review.verdict}: ${review.reason}`);
    } catch (error) {
      review = { verdict: 'ambiguous', reason: `재검토 실행 실패: ${(error as Error).message ?? String(error)}` };
      log(`[dispute] ${dispute.id} 재검토 실패 → ambiguous`);
    }
  }
  const item = await input.store.reviewQueue.enqueue({
    kind: 'dispute',
    ruleIds: input.rules.map((r) => r.id),
    runId: input.runId,
    summary: review ? `${dispute.summary} — 재검토: ${review.verdict}` : dispute.summary,
  });
  const reviewed: Dispute = {
    ...dispute,
    status: 'queued',
    queueItemId: item.id,
    ...(review
      ? {
          advisory: {
            by: 'test-writer',
            at: now().toISOString(),
            verdict: review.verdict,
            ...(review.evidenceInput ? { evidenceInput: review.evidenceInput } : {}),
          },
        }
      : {}),
  };
  return { dispute: reviewed, review, usage };
}

export async function handleDisputes(input: DisputeFlowInput): Promise<ReviewedDispute[]> {
  const out: ReviewedDispute[] = [];
  for (const d of input.disputes) {
    if (d.status !== 'reviewing') continue;
    out.push(await reviewDispute(input, d));
  }
  return out;
}

function safeJson(text: string): unknown {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}
