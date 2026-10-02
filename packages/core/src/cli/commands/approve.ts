/**
 * `plumb approve <ruleId> [--proposal <p-id>] [--by <name>] [--note <text>]` (이슈 #32, 기획안 §9.1 · §10).
 *
 * 승인은 `rules.yaml`을 바꾸는 유일한 행위다 — 코어 `approvals.approve()`를 부른다. 두 통로(이 명령 · UI 토큰 세션) 중 CLI 쪽.
 * 대기 중인 제안이 하나면 `--proposal` 생략 가능, 여럿이면 목록을 보여주고 exit 2.
 * 고위험 영역의 완화 · 삭제 · 경계 변경(`requiresPriorApproval`)은 M10의 결정 단위 승인으로 — 메시지와 exit 3, 아무것도 쓰지 않는다.
 */

import type { Command } from 'commander';
import type { RuleId } from '../../types/index.js';
import { pickOpenProposal } from './rule.js';
import {
  CHANGE_KIND_LABEL,
  type CliContext,
  defaultApprover,
  EXIT_INPUT,
  EXIT_OK,
  EXIT_PRIOR_APPROVAL,
  type OpenedStore,
  openTargetStore,
  runCommand,
  statusLine,
  targetOf,
  writeJson,
} from './shared.js';

export const PRIOR_APPROVAL_MESSAGE = '사전 승인 필요(고위험 완화·삭제·경계 변경) — M10에서 결정 단위 승인';

export async function approveRule(
  ctx: CliContext,
  opened: OpenedStore,
  ruleId: RuleId,
  options: { proposal?: string; by: string; note?: string; json: boolean },
): Promise<number> {
  const { store } = opened;
  const proposal = await pickOpenProposal(ctx, store, ruleId, options.proposal);
  if (proposal === null) return EXIT_INPUT;

  const result = await store.approvals.approve({
    ruleId,
    proposalId: proposal.id,
    by: options.by,
    ...(options.note === undefined ? {} : { note: options.note }),
  });

  if (!result.applied) {
    if (options.json) {
      writeJson(ctx, {
        applied: false,
        requiresPriorApproval: true,
        proposal: result.proposal,
        message: PRIOR_APPROVAL_MESSAGE,
      });
    } else {
      ctx.stderr.write(`plumb: ${PRIOR_APPROVAL_MESSAGE}\n`);
      ctx.stderr.write(
        `  ${ruleId} ← ${proposal.id} (${CHANGE_KIND_LABEL[proposal.changeKind]}). 승인 전까지 기존 규칙이 유효하다. rules.yaml은 바뀌지 않았다\n`,
      );
    }
    return EXIT_PRIOR_APPROVAL;
  }

  const status = await store.status();
  if (options.json) {
    writeJson(ctx, {
      approval: result.approval,
      approvalState: 'approved',
      rulesHash: result.rulesHash,
      rule: result.rule,
      unconfirmed: status.unconfirmed,
    });
  } else {
    ctx.stdout.write(
      `승인: ${ruleId} ← ${proposal.id} (${CHANGE_KIND_LABEL[proposal.changeKind]} · by ${options.by}) · rules.yaml sha256 ${result.rulesHash.slice(0, 12)}…\n`,
    );
    ctx.stdout.write(`${statusLine(ctx, status)}\n`);
  }
  return EXIT_OK;
}

export function registerApproveCommand(program: Command, ctx: CliContext): Command {
  return program
    .command('approve <ruleId>')
    .description('제안을 승인해 rules.yaml에 반영한다 (M3)')
    .option('--proposal <p-id>', '승인할 제안. 대기 중인 제안이 하나면 생략 가능')
    .option('--by <name>', '승인자. 기본 OS 사용자 이름 (USER), 없으면 developer')
    .option('--note <text>', '승인 메모')
    .option('--json', '기계용 JSON 출력', false)
    .action(
      async (
        ruleId: string,
        options: { proposal?: string; by?: string; note?: string; json: boolean },
        command: Command,
      ) => {
        await runCommand(ctx, async () =>
          approveRule(ctx, await openTargetStore(ctx, targetOf(command)), ruleId as RuleId, {
            ...options,
            by: options.by ?? defaultApprover(ctx),
          }),
        );
      },
    );
}
