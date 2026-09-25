/**
 * 资源域的装配：五条路由，一个采样服务。
 *
 * 采样路由是按工作空间的（面板显示一个工作空间的会话）；`/api/power*` 那四条**不带
 * 工作空间**——租约属于机器、跨画布切换存活。两者装在同一个域里，是因为面板在同一
 * 屏上显示它们，而快照里的电源那一段读的就是这本租约簿。
 *
 * 终止一个孤立会话要拆一棵进程树，而拆树的那一份在终端域
 * （`terminal/process.ts` 的 `terminateTree`）。这里只决定**终止谁**：
 * `session:<id>` 是一个属于这个工作空间的会话行，`ref:<name>` 是一个没有行的后端
 * 会话。一个任意的 pid 根本不能通过这条路寻址。
 */

import { join } from "node:path";

import { terminateTree } from "../terminal/process";
import { badRequest, coreError } from "../http/errors";
import type { ErrorResponse } from "../http/errors";
import type { HandlerResult } from "../http/router";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { scheduleDomain } from "../schedule";
import { workspaceExists } from "../events/workspaces";
import {
  LeaseNotFound,
  PowerService,
  type PowerLeaseRequest,
  type PowerLeaseSource,
} from "./power";
import { KeepAwake } from "./keep-awake";
import { HostAwareResourceService } from "./hosts";
import type { ResourceService, SubscribeRequest } from "./service";
import { OrphanError, adoptOrphan, orphanTarget, panePids } from "./sessions";

export { ResourceService } from "./service";
export { PowerService } from "./power";
export type {
  PowerLease,
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
  readonly power: PowerService;
  stop(): void;
}

let assembled: ResourceDomain | undefined;

/** 正在跑的这一轮的资源域，给需要读一次采样的别的域。 */
export function resourceDomain(): ResourceDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): ResourceDomain {
  const power = new PowerService({
    policy: () => {
      const value = settingsDomain()?.settings.get("power.policy");
      return typeof value === "string" ? value : "manual";
    },
    log: (message, fields) => context.log.info(message, fields ?? {}),
  });
  // 工作时自动持有的那两把（T02）：订阅 `agent.status` 与终端退出，定时复查
  // 自动化运行。它只决定申不申请；生不生效仍由上面那条策略说了算。
  const keepAwake = new KeepAwake({
    power,
    enabled: () =>
      settingsDomain()?.settings.get("power.keepAwakeWhileWorking") !== false,
    automationActive: () => scheduleDomain()?.engine.hasActiveRuns() === true,
  });
  const unsubscribe = context.bus.on("workspace.event", ({ event }) => {
    if (event.type === "agent.status") {
      const status = event.status as { nodeId?: unknown; state?: unknown };
      keepAwake.noteStatus(
        typeof status.nodeId === "string" ? status.nodeId : "",
        typeof status.state === "string" ? status.state : undefined,
      );
      return;
    }
    if (event.type === "terminal.exit" && event.nodeId !== undefined) {
      keepAwake.noteExit(event.nodeId);
    }
  });
  keepAwake.start();
  // 远端主机的总览与 SSH 会话的远端进程树叠在本机那一份上（`hosts.ts`）。
  const service = new HostAwareResourceService({
    database: context.db.database,
    settings: settingsDomain()?.settings,
    bus: context.bus,
    dataDir: context.dataDir,
    power: () => power.state(),
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
        // 会话，别的一律拒绝；拒绝要说出来，不能答成「已终止」。
        if (!(await terminateBackend(target.reference, context.dataDir))) {
          return coreError(404, "not_found", "No such backend session");
        }
        return { status: 204 };
      }
      const pid = panePids(context.dataDir).get(
        backendRefOf(context, target.sessionId) ?? "",
      );
      if (pid !== undefined) await terminateTree(pid);
      context.db.database
        .prepare(
          "UPDATE terminal_sessions SET status = 'exited', attach_state = 'exited' WHERE id = ?",
        )
        .run(target.sessionId);
      return { status: 204 };
    },
  );

  /* ---------------------------------- 电源 -------------------------------- */

  router.handle("GET", "/api/power", () => ({
    status: 200,
    body: power.state(),
  }));

  router.handle("POST", "/api/power/leases", (_match, request) => {
    let body: unknown;
    try {
      body = request.json();
    } catch {
      return badRequest("The request body is not JSON");
    }
    const parsed = parseLeaseRequest(body);
    if (typeof parsed === "string") return badRequest(parsed);
    return { status: 200, body: power.acquire(parsed) };
  });

  router.handle(
    "POST",
    "/api/power/leases/{leaseId}/renew",
    (match, request) => {
      let ttlSeconds: number | undefined;
      if (request.body.byteLength > 0) {
        let body: unknown;
        try {
          body = request.json();
        } catch {
          return badRequest("The request body is not JSON");
        }
        const wanted = (body as { ttlSeconds?: unknown } | null)?.ttlSeconds;
        if (wanted !== undefined) {
          if (typeof wanted !== "number" || !Number.isFinite(wanted)) {
            return badRequest("ttlSeconds is not a number");
          }
          ttlSeconds = wanted;
        }
      }
      try {
        return {
          status: 200,
          body: power.renew(match.params.leaseId ?? "", ttlSeconds),
        };
      } catch (error) {
        if (error instanceof LeaseNotFound) {
          // 过期与从来没有过，对调用方是同一件事：这条租约现在不顶着什么。
          return coreError(404, "not_found", "No such power lease");
        }
        throw error;
      }
    },
  );

  router.handle("DELETE", "/api/power/leases/{leaseId}", (match) => ({
    status: 200,
    body: power.release(match.params.leaseId ?? ""),
  }));

  assembled = {
    service,
    power,
    stop: () => {
      unsubscribe();
      keepAwake.stop();
      service.stop();
      power.stop();
    },
  };
  return assembled;
}

const LEASE_SOURCES: readonly PowerLeaseSource[] = [
  "session",
  "automation",
  "manual",
];

/** 合法就是请求本身，不合法就是那句话。 */
function parseLeaseRequest(body: unknown): PowerLeaseRequest | string {
  const raw = (body ?? {}) as Record<string, unknown>;
  const source = raw.source;
  if (
    typeof source !== "string" ||
    !LEASE_SOURCES.includes(source as PowerLeaseSource)
  ) {
    return "source must be session, automation or manual";
  }
  if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
    return "reason is required";
  }
  if (raw.ttlSeconds !== undefined && typeof raw.ttlSeconds !== "number") {
    return "ttlSeconds is not a number";
  }
  return {
    source: source as PowerLeaseSource,
    reason: raw.reason,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.workspaceId === "string"
      ? { workspaceId: raw.workspaceId }
      : {}),
    ...(typeof raw.ttlSeconds === "number"
      ? { ttlSeconds: raw.ttlSeconds }
      : {}),
  };
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

async function terminateBackend(
  reference: string,
  dataDir: string,
): Promise<boolean> {
  // 只接受这个 core 自己的会话名。一个任意的名字不能通过这条路寻址。
  if (!reference.startsWith("armadra-")) return false;
  const pid = panePids(dataDir).get(reference);
  if (pid !== undefined) await terminateTree(pid);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((done) => {
    execFile(
      "tmux",
      [
        "-S",
        join(dataDir, "tmux.sock"),
        "-f",
        join(dataDir, "tmux.conf"),
        "kill-session",
        "-t",
        reference,
      ],
      () => done(),
    );
  });
  return true;
}
