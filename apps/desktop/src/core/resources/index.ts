/**
 * 资源域的装配：五条路由，一个采样服务。
 *
 * 采样路由是按工作空间的（面板显示一个工作空间的会话）。`/api/power*` **不在这里**
 * ——租约属于机器、跨画布切换存活，是 phase 5 里另一条独立认领的路；这个域只在快照
 * 里报策略和抑制机制能不能用，因为面板在同一屏上显示它们。
 *
 * 终止一个孤立会话要拆一棵进程树，而拆树的那一份在终端域
 * （`terminal/process.ts` 的 `terminateTree`）。这里只决定**终止谁**：
 * `session:<id>` 是一个属于这个工作空间的会话行，`ref:<name>` 是一个没有行的后端
 * 会话。一个任意的 pid 根本不能通过这条路寻址。
 */

import { terminateTree } from "../terminal/process";
import { badRequest, coreError } from "../http/errors";
import type { ErrorResponse } from "../http/errors";
import type { HandlerResult } from "../http/router";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { workspaceExists } from "../events/workspaces";
import { ResourceService, type SubscribeRequest } from "./service";
import {
  OrphanError,
  adoptOrphan,
  orphanTarget,
  panePids,
} from "./sessions";

export { ResourceService } from "./service";
export type {
  PowerState,
  ResourceSnapshot,
  SubscribeRequest,
  Subscription,
} from "./service";
export { Sampler } from "./sample";
export type {
  HostResources,
  ProcessSample,
  SessionResources,
  SessionTarget,
} from "./sample";
export { listOrphans, sessionTargets } from "./sessions";
export type { AdoptedSession, OrphanSession } from "./sessions";

export interface ResourceDomain {
  readonly service: ResourceService;
  stop(): void;
}

let assembled: ResourceDomain | undefined;

/** 正在跑的这一轮的资源域，给需要读一次采样的别的域。 */
export function resourceDomain(): ResourceDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): ResourceDomain {
  const service = new ResourceService({
    database: context.db.database,
    settings: settingsDomain()?.settings,
    bus: context.bus,
    dataDir: context.dataDir,
  });
  const { router } = context.server;

  // 工作空间不存在时先答 404，和 Rust 的 `db::get_workspace(...)?` 同一个位置。
  const guard = (workspaceId: string): ErrorResponse | undefined =>
    workspaceExists(context.db.database, workspaceId)
      ? undefined
      : coreError(404, "not_found", "This workspace does not exist");

  router.handle("GET", "/api/workspaces/{workspaceId}/resources", (match) => {
    const workspaceId = match.params.workspaceId ?? "";
    const refusal = guard(workspaceId);
    if (refusal !== undefined) return refusal;
    return { status: 200, body: service.snapshot(workspaceId) };
  });

  router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/resources/subscription",
    (match, request) => {
      const workspaceId = match.params.workspaceId ?? "";
      const refusal = guard(workspaceId);
      if (refusal !== undefined) return refusal;
      let body: SubscribeRequest = {};
      if (request.body.byteLength > 0) {
        try {
          body = request.json<SubscribeRequest>() ?? {};
        } catch {
          return badRequest("The request body is not JSON");
        }
      }
      return { status: 200, body: service.subscribe(workspaceId, body) };
    },
  );

  router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/resources/subscription/{subscriptionId}",
    (match) => {
      service.unsubscribe(match.params.subscriptionId ?? "");
      return { status: 204 };
    },
  );

  router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/resources/orphans/{sessionId}/adopt",
    (match) => {
      const workspaceId = match.params.workspaceId ?? "";
      const refusal = guard(workspaceId);
      if (refusal !== undefined) return refusal;
      try {
        return {
          status: 200,
          body: adoptOrphan(
            context.db.database,
            workspaceId,
            match.params.sessionId ?? "",
          ),
        };
      } catch (error) {
        return orphanFailure(error);
      }
    },
  );

  router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/resources/orphans/{orphanId}/terminate",
    async (match) => {
      const workspaceId = match.params.workspaceId ?? "";
      const refusal = guard(workspaceId);
      if (refusal !== undefined) return refusal;
      let target;
      try {
        target = orphanTarget(
          context.db.database,
          workspaceId,
          match.params.orphanId ?? "",
        );
      } catch (error) {
        return orphanFailure(error);
      }
      if (target.kind === "ref") {
        // 没有行的会话按它的后端句柄销毁——tmux 知道那个名字指的是它自己的哪个
        // 会话，别的一律拒绝。
        await terminateBackend(target.reference);
        return { status: 204 };
      }
      const pid = panePids().get(backendRefOf(context, target.sessionId) ?? "");
      if (pid !== undefined) await terminateTree(pid);
      context.db.database
        .prepare(
          "UPDATE terminal_sessions SET status = 'exited', attach_state = 'exited' WHERE id = ?",
        )
        .run(target.sessionId);
      return { status: 204 };
    },
  );

  assembled = {
    service,
    stop: () => service.stop(),
  };
  return assembled;
}

function orphanFailure(error: unknown): ErrorResponse {
  if (error instanceof OrphanError) {
    return coreError(error.status, error.code, error.message);
  }
  throw error;
}

function backendRefOf(
  context: CoreContext,
  sessionId: string,
): string | undefined {
  const row = context.db.database
    .prepare("SELECT backend_ref FROM terminal_sessions WHERE id = ?")
    .get(sessionId) as { backend_ref?: unknown } | undefined;
  return typeof row?.backend_ref === "string" ? row.backend_ref : undefined;
}

async function terminateBackend(reference: string): Promise<void> {
  // 只接受这个 core 自己的会话名。一个任意的名字不能通过这条路寻址。
  if (!reference.startsWith("armadra-")) return;
  const pid = panePids().get(reference);
  if (pid !== undefined) await terminateTree(pid);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((done) => {
    execFile("tmux", ["kill-session", "-t", reference], () => done());
  });
}
