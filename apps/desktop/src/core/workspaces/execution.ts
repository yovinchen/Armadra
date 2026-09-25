import type { CoreContext } from "../main";
import { invalidate } from "../git/discovery";
import { activeOperations } from "../git";
import { releaseWorkspace } from "../files/watch";
import { emptyRequest } from "../http/router";
import { executeOn, executeRemote } from "../remote/execute";
import {
  type BlockerSources,
  type Refusal,
  type RootFingerprint,
  type SwitchRequest,
  SwitchError,
  blockers,
  decide,
  stop,
  validateRequest,
} from "../remote/switch";
import { remoteWatches } from "../remote/watch";
import {
  DomainError,
  badRequest,
  conflict,
  forbidden,
  optionalString,
} from "./support";
import {
  type Workspace,
  type WorkspacePermissions,
  createRemoteWorkspace,
  getWorkspace,
  rebindWorkspaceExecution,
} from "./table";

/**
 * 工作空间与执行主机之间的两件事：在远端主机上打开一个项目，以及把已有的
 * 工作空间改绑到另一台主机（远端补全设计 §3.3）。
 *
 * 两者都只写**被证明过**的根：先让那台机器上的 Worker（本机就是这个进程）
 * 登记这个根——存在、是目录、给出规范路径与指纹——然后才写数据库。主机不可达
 * 或 Worker 不匹配时请求失败，不会留下一个指向没人核实过的目录的工作空间。
 */

interface RegisteredRoot {
  readonly root: string;
  readonly fingerprint: RootFingerprint;
}

/** 在 `hostId` 那台机器上登记 `root`；空 id 是本机。 */
async function register(hostId: string, root: string): Promise<RegisteredRoot> {
  const answer =
    hostId === ""
      ? await executeOn({ rootPath: root }, "root.register")
      : await executeRemote(hostId, "root.register", root);
  return answer as RegisteredRoot;
}

/** `POST /api/workspaces/remote` */
export async function openRemoteWorkspace(
  context: CoreContext,
  input: {
    readonly name: string;
    readonly executionHostId: string | undefined;
    readonly rootPath: string;
    readonly permissions: WorkspacePermissions | undefined;
  },
): Promise<Workspace> {
  const hostId = input.executionHostId ?? "";
  if (hostId === "") {
    throw badRequest("A remote workspace requires an execution host");
  }
  if (!input.rootPath.startsWith("/") || input.rootPath.length > 4_096) {
    throw badRequest(
      "A remote workspace root must be an absolute path on the execution host",
    );
  }
  const registered = await register(hostId, input.rootPath);
  return createRemoteWorkspace(context.db.database, {
    name: input.name,
    executionHostId: hostId,
    rootPath: registered.root,
    permissions: input.permissions,
  });
}

/** 从请求体读出改绑请求；形状见 `switchExecutionHostRequestSchema`。 */
export function switchRequestOf(body: Record<string, unknown>): SwitchRequest {
  const hostId = body.executionHostId ?? "";
  if (typeof hostId !== "string" || hostId.length > 64) {
    throw badRequest("executionHostId must be a string");
  }
  const rootPath = optionalString(body, "rootPath");
  if (rootPath === undefined || rootPath === "") {
    throw badRequest("Workspace root is required");
  }
  const flag = (name: string): boolean | undefined => {
    const value = body[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean")
      throw badRequest(`${name} must be a boolean`);
    return value;
  };
  const force = flag("force");
  const stopBlockers = flag("stopBlockers");
  const migrateFiles = flag("migrateFiles");
  return {
    executionHostId: hostId,
    rootPath,
    ...(force === undefined ? {} : { force }),
    ...(stopBlockers === undefined ? {} : { stopBlockers }),
    ...(migrateFiles === undefined ? {} : { migrateFiles }),
  };
}

/** 改绑的结果：成功是新的工作空间行，拒绝是 409 的结构化理由。 */
export type SwitchOutcome =
  | { readonly kind: "switched"; readonly workspace: Workspace }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** `PATCH /api/workspaces/{id}/execution-host` */
export async function switchExecutionHost(
  context: CoreContext,
  workspaceId: string,
  request: SwitchRequest,
): Promise<SwitchOutcome> {
  const database = context.db.database;
  const workspace = getWorkspace(database, workspaceId);
  if (!workspace.permissions.read) {
    throw forbidden("This workspace is not readable");
  }
  try {
    validateRequest(request, workspace.permissions.write);
  } catch (failure) {
    if (failure instanceof SwitchError) {
      throw new DomainError(failure.status, failure.code, failure.message);
    }
    throw failure;
  }
  const fromHost = workspace.executionHostId ?? "";
  const toHost = request.executionHostId;

  // 新根先登记：它不存在或那台机器不可达，就没有什么可比，也不该往下走。
  const target = await register(toHost, request.rootPath);
  if (fromHost === toHost && target.root === workspace.rootPath) {
    return { kind: "switched", workspace };
  }

  // 旧根读不到（主机下线、目录已删）不是「一致」：只有强制才能越过。
  let from: RootFingerprint | undefined;
  try {
    from = (await register(fromHost, workspace.rootPath)).fingerprint;
  } catch {
    from = undefined;
  }

  const sources = blockerSources(context);
  const stopped =
    request.stopBlockers === true
      ? await stop(workspaceId, sources, {
          stopTerminal: async (sessionId) => {
            await terminate(context, sessionId);
          },
        })
      : [];
  const remaining = await blockers(database, workspaceId, sources);
  const force = request.force === true;
  const refusal =
    decide({ remaining, stopped, from, to: target.fingerprint, force }) ??
    (from === undefined && !force
      ? ({
          code: "root_mismatch",
          message: "读不到原执行主机上的根，无法核对新目录是不是同一个项目",
          to: target.fingerprint,
          ...(stopped.length === 0 ? {} : { stopped }),
        } satisfies Refusal)
      : undefined);
  if (refusal !== undefined) return { kind: "refused", refusal };

  const matched =
    from !== undefined &&
    from.head === target.fingerprint.head &&
    from.entries === target.fingerprint.entries;
  let updated: Workspace;
  try {
    updated = rebindWorkspaceExecution(
      database,
      workspaceId,
      toHost,
      target.root,
    );
  } catch (failure) {
    if (
      failure instanceof Error &&
      /UNIQUE constraint failed/u.test(failure.message)
    ) {
      throw conflict("Another workspace already uses this root");
    }
    throw failure;
  }
  if (!matched) {
    // 强制越过了不一致：这是一个需要事后能查到的决定。
    context.log.warn("workspace.executionHostChanged", {
      workspaceId,
      from: fromHost === "" ? "local" : fromHost,
      to: toHost === "" ? "local" : toHost,
      forced: true,
    });
  } else {
    context.log.info("workspace.executionHostChanged", {
      workspaceId,
      from: fromHost === "" ? "local" : fromHost,
      to: toHost === "" ? "local" : toHost,
      forced: false,
    });
  }

  // 旧主机上的登记全部作废：监听、仓库发现缓存。节点与画布不动，前端整片重取。
  releaseWorkspace(workspaceId);
  remoteWatches.releaseWorkspace(workspaceId);
  invalidate(workspaceId);
  context.bus.emit("workspace.event", {
    workspaceId,
    event: { type: "workspace.updated", workspaceId },
  });
  return { kind: "switched", workspace: updated };
}

/**
 * 还绑在旧主机上的东西从哪里来。
 *
 * 终端从数据库读（仍在运行、属于某个节点的会话）；进行中的 Git 操作问 Git 域。
 * 编辑器草稿只存在于客户端，服务端看不见，所以不在这里——切换成功后前端整片
 * 重取，草稿仍在节点里，保存时版本校验会让它显式地决定。浏览器会话只跑在
 * 控制端，不随执行主机走。
 */
function blockerSources(context: CoreContext): BlockerSources {
  const database = context.db.database;
  return {
    terminals: async (workspaceId) => {
      try {
        return (
          database
            .prepare(
              "SELECT id, owner_node_id FROM terminal_sessions " +
                "WHERE workspace_id = ? AND status = 'running' AND owner_node_id IS NOT NULL " +
                "ORDER BY created_at",
            )
            .all(workspaceId) as { id: string; owner_node_id: string }[]
        ).map((row) => ({ nodeId: row.owner_node_id, sessionId: row.id }));
      } catch {
        return [];
      }
    },
    gitOperations: (workspaceId) => activeOperations(workspaceId),
  };
}

/**
 * 结束一个终端会话，连同它的持久会话。
 *
 * 经路由表调终端域自己的 `terminate`，而不是在这里再持有一份终端管理器：
 * 结束会话的规则（进程组、tmux 窗口、状态落库）只该有一处。
 */
async function terminate(
  context: CoreContext,
  sessionId: string,
): Promise<void> {
  const path = `/api/terminals/${encodeURIComponent(sessionId)}/terminate`;
  const body = Buffer.from(JSON.stringify({ mode: "session" }), "utf8");
  await context.server.router.dispatch("POST", path, {
    ...emptyRequest("POST", path),
    headers: { "content-type": "application/json" },
    body,
    json: <T>() => JSON.parse(body.toString("utf8")) as T,
  });
}
