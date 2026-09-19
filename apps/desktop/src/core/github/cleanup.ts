/**
 * 一条 PR 被读完或合并**之后**的事（设计 §8「检查」与「清理」）：重启检查，以及
 * 删掉源分支。移植自 `apps/host/internal/githubhost/cleanup.go`。
 *
 * 两者都先重新读远端并在它动过时拒绝。两者都不被捆进别的动作里：一次合并不会删
 * 分支，删一个分支也不碰本地检出或任何正在跑的会话。
 */

import {
  GithubCheckConclusion,
  GithubWriteState,
  type DeleteGithubBranchRequest,
  type DeleteGithubBranchResponse,
  type GithubCheckSummary,
  type RerunGithubChecksRequest,
  type RerunGithubChecksResponse,
} from "./types";
import {
  DeleteGithubBranchResponseSchema,
  GithubWriteOutcomeSchema,
  RerunGithubChecksResponseSchema,
} from "./schema";
import { create } from "../contract/message";

import * as api from "./endpoints";
import { codeOf, githubError, isGithubError } from "./errors";
import { validRef } from "./pulls";
import {
  SCOPE_WRITE,
  rateLimit,
  type Caller,
  type GithubService,
} from "./service";

/**
 * 一次重跑请求的上界。head 上有比这更多不同 workflow run 的 PR 不会被一次点击整
 * 批重启；读者自己挑要哪一个。
 */
export const MAX_RERUN_TARGETS = 20;

/**
 * 挑出一次重跑真正会发给谁。
 *
 * 只有汇总自己标成 `rerunnable` 的运行才有资格——那个标志是从生产它的 app 读出来
 * 的，不是从名字猜的——而且只有没成功的那些，因为重启一个绿的检查是花 runner 时间
 * 去学一件已经知道的事。指名一个检查会把范围收到那一个运行上。
 */
export function rerunTargets(
  checks: GithubCheckSummary | undefined,
  name: string,
): bigint[] {
  const seen = new Set<bigint>();
  const targets: bigint[] = [];
  for (const run of checks?.runs ?? []) {
    if (!run.rerunnable || run.workflowRunId <= 0n) continue;
    if (name !== "" && run.name !== name) continue;
    // 还在飞的运行没有东西可重启，绿的那个重跑也只会换掉一个已知的结果。
    if (
      run.conclusion === GithubCheckConclusion.SUCCESS ||
      run.conclusion === GithubCheckConclusion.PENDING
    ) {
      continue;
    }
    if (seen.has(run.workflowRunId)) continue;
    seen.add(run.workflowRunId);
    targets.push(run.workflowRunId);
    if (targets.length === MAX_RERUN_TARGETS) break;
  }
  return targets;
}

/**
 * 重启一条 PR 里失败检查背后的那些 workflow run。
 *
 * head 会被重新读并和读者看到的那个比对：对着一个已经被换掉的提交发起的重跑会报告
 * 一份没人问过的工作。每个运行单独汇报，所以一次只被部分接受的重启是看得见的，而
 * 不是被平均成一个结论；结果从没被读到的那个留在 PENDING——**永远不重试**，因为
 * 第二次重启是第二条互相竞争的流水线。
 */
export async function rerunChecks(
  service: GithubService,
  caller: Caller,
  request: RerunGithubChecksRequest,
): Promise<RerunGithubChecksResponse> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  if (request.checkName.length > 256) throw githubError("invalid");
  const now = service.now();
  let read;
  try {
    read = await api.pull(client, ref, request.number, [], now);
    service.credentials.noteSuccess();
  } catch (error) {
    throw service.translate(error);
  }
  if (read.pull.headSha === "") throw githubError("notFound");
  if (
    request.expectedHeadSha !== "" &&
    request.expectedHeadSha !== read.pull.headSha
  ) {
    return create(RerunGithubChecksResponseSchema, {
      reasonCode: "HEAD_MOVED",
      rateLimit: rateLimit(read.response.rate),
    });
  }
  let checks: GithubCheckSummary;
  try {
    checks = await api.checks(client, ref, read.pull.headSha, now);
  } catch (error) {
    throw service.translate(error);
  }
  const targets = rerunTargets(checks, request.checkName);
  if (targets.length === 0) {
    // 不是每个检查都能重启，把这件事说出来好过一个点了没反应的按钮。
    return create(RerunGithubChecksResponseSchema, {
      reasonCode: "NOT_RERUNNABLE",
      checks,
      rateLimit: rateLimit(read.response.rate),
    });
  }
  const result = create(RerunGithubChecksResponseSchema, {
    rateLimit: rateLimit(read.response.rate),
  });
  for (const runId of targets) {
    const outcome = create(GithubWriteOutcomeSchema, {
      actionId: `rerun:${runId}`,
      target: "workflow_run",
      requestedValue: String(runId),
    });
    try {
      await api.rerunWorkflowRun(client, ref, runId, request.failedOnly);
      outcome.state = GithubWriteState.APPLIED;
    } catch (error) {
      const translated = service.translate(error);
      if (isGithubError(translated, "unknownOutcome")) {
        outcome.state = GithubWriteState.PENDING;
        outcome.reasonCode = "UNKNOWN_OUTCOME";
      } else if (isGithubError(translated, "permission")) {
        outcome.state = GithubWriteState.FAILED;
        outcome.reasonCode = "PERMISSION_DENIED";
      } else if (isGithubError(translated, "notFound")) {
        outcome.state = GithubWriteState.FAILED;
        outcome.reasonCode = "NOT_FOUND";
      } else if (isGithubError(translated, "conflict")) {
        // 这里的冲突是一个远端在它当前状态下不肯重启的运行——最常见的是一个已经
        // 重新排队的运行。
        outcome.state = GithubWriteState.SKIPPED;
        outcome.reasonCode = "CONFLICT";
      } else {
        outcome.state = GithubWriteState.FAILED;
        outcome.reasonCode = "REFUSED";
      }
    }
    result.outcomes.push(outcome);
  }
  // 对着同一个 head 重新读，这样面板不会停在那批重启本来要替换掉的结论上。
  try {
    result.checks = await api.checks(
      client,
      ref,
      read.pull.headSha,
      service.now(),
    );
  } catch {
    result.checks = checks;
  }
  return result;
}

/**
 * 删掉远端的一个分支。
 *
 * `expectedSha` 是必需的而且会被重新读：一个在面板读过之后往前走了的分支会把没有
 * 被评审过的提交一起带走，那里唯一诚实的答案是拒绝并让读者再看一眼。本地什么都不
 * 碰——检出、它的 worktree 和任何正在跑的会话是另一个、另行确认的动作。
 */
export async function deleteBranch(
  service: GithubService,
  caller: Caller,
  request: DeleteGithubBranchRequest,
): Promise<DeleteGithubBranchResponse> {
  service.authorize(caller, SCOPE_WRITE);
  const client = service.client();
  const ref = service.repository(request.repository);
  const branch = request.branch;
  if (!validRef(branch) || request.expectedSha === "") {
    throw githubError("invalid");
  }
  let current: string;
  try {
    current = await api.refSha(client, ref, branch);
    service.credentials.noteSuccess();
  } catch (error) {
    if (codeOf(error) === "NOT_FOUND") {
      // 已经没了。那是调用方想要的状态，但不是这次调用造成的，所以它被报成一次
      // 带原因的拒绝，而不是一次删除。
      return create(DeleteGithubBranchResponseSchema, {
        reasonCode: "NOT_FOUND",
      });
    }
    throw service.translate(error);
  }
  if (current !== request.expectedSha) {
    return create(DeleteGithubBranchResponseSchema, {
      reasonCode: "REF_MOVED",
    });
  }
  try {
    await api.deleteRef(client, ref, branch);
  } catch (error) {
    const translated = service.translate(error);
    if (isGithubError(translated, "unknownOutcome")) {
      // 这次删除可能已经生效；重新读是唯一诚实的答案，而且永远不自动重发一次。
      try {
        await api.refSha(client, ref, branch);
      } catch (readError) {
        if (codeOf(readError) === "NOT_FOUND") {
          return create(DeleteGithubBranchResponseSchema, { deleted: true });
        }
      }
      return create(DeleteGithubBranchResponseSchema, {
        reasonCode: "UNKNOWN_OUTCOME",
      });
    }
    if (isGithubError(translated, "permission")) {
      // 分支保护和缺少推送权限从这里看是一样的，两者的意思都是「远端不会让这件
      // 事发生」。
      return create(DeleteGithubBranchResponseSchema, {
        reasonCode: "PROTECTED",
      });
    }
    if (isGithubError(translated, "notFound")) {
      return create(DeleteGithubBranchResponseSchema, {
        reasonCode: "NOT_FOUND",
      });
    }
    if (isGithubError(translated, "conflict")) {
      return create(DeleteGithubBranchResponseSchema, {
        reasonCode: "REF_MOVED",
      });
    }
    throw translated;
  }
  return create(DeleteGithubBranchResponseSchema, { deleted: true });
}
