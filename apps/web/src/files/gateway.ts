import type { HostFilesystemClient } from "@armadra/host-client";
import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspacePermissions,
} from "@armadra/shared";

import { RuntimeRequestError, runtimeApi } from "../api/client";
import { resolveHostCanvasClient } from "../canvas-ownership/host-session";
import type { CanvasOwnershipStatus } from "../canvas-ownership/store";
import { domainStatus, useOwnership } from "../ownership/store";
import { resolveHostFilesystemClient } from "./host-session";

/**
 * 文件域网关（业务迁移 §2.5）—— 一次写只落一侧。
 *
 * 搬过去的是**决定**，不是文件：读写文件、监听、搜索、Git 命令永远在执行
 * 主机上跑，切换前后都走 Host 的 `/api` 转发。这里只管两件事——工作空间的
 * 根注册在哪台机器上、这个工作空间允许读/写/执行到什么程度——它们切换后由
 * Host 记录，Runtime 对应的写路由回 `ownership_moved`。
 *
 * 路由规则和画布网关一样：读跟着最后一次探到的归属走，探不到就读 Runtime
 * （它交出写权之后仍然照常答读）；写则相反，归属没落定就不写。
 */

/** 归属没落定，这一次写不该发生。 */
export class FilesystemReadOnlyError extends Error {
  readonly name = "FilesystemReadOnlyError";
  constructor(readonly status: CanvasOwnershipStatus) {
    super(`Workspace registration is read-only (${status}).`);
  }
}

/**
 * Runtime 已经交出写权。**不重试**：同一个请求再发一次还是 409，
 * 而且写方已经换人了。捕获它的地方应该重新探归属，再决定走哪边。
 */
export class FilesystemOwnershipMovedError extends Error {
  readonly name = "FilesystemOwnershipMovedError";
}

function isOwnershipMoved(error: unknown): boolean {
  return (
    error instanceof RuntimeRequestError &&
    error.status === 409 &&
    error.code === "ownership_moved"
  );
}

type HostResolver = (
  workspaceId: string,
  mutation: boolean,
) => Promise<HostFilesystemClient>;

let resolver: HostResolver = resolveHostFilesystemClient;

/** 测试注入 Host 客户端；传 `null` 恢复真实实现。 */
export function setFilesystemHostResolver(next: HostResolver | null): void {
  resolver = next ?? resolveHostFilesystemClient;
}

type CanvasResolver = typeof resolveHostCanvasClient;
let canvasResolver: CanvasResolver = resolveHostCanvasClient;

/**
 * 建工作空间要同时落两个域：画布域的工作空间实体，文件域的根注册。
 * 测试按域各注入一个替身，免得一个假客户端要冒充两层面。
 */
export function setFilesystemCanvasResolver(next: CanvasResolver | null): void {
  canvasResolver = next ?? resolveHostCanvasClient;
}

async function settled(): Promise<CanvasOwnershipStatus> {
  const state = useOwnership.getState();
  const current = state.failed
    ? "error"
    : domainStatus("filesystem", state.domains);
  // `error` 和 `unknown` 一样要重探：探测失败是一次丢掉的请求，不是判决，
  // 把工作空间设置卡成只读直到有人点横幅，会把一次抖动变成一次卡死。
  if (current !== "unknown" && current !== "error") return current;
  const domains = await state.probe();
  return useOwnership.getState().failed
    ? "error"
    : domainStatus("filesystem", domains);
}

async function writeRoute(): Promise<"runtime" | "host"> {
  const status = await settled();
  if (status !== "runtime" && status !== "host")
    throw new FilesystemReadOnlyError(status);
  return status;
}

async function readRoute(): Promise<"runtime" | "host"> {
  return (await settled()) === "host" ? "host" : "runtime";
}

/** Runtime 写的统一出口：把 `ownership_moved` 从普通 409 里摘出来。 */
async function runtimeWrite<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isOwnershipMoved(error)) throw error;
    await useOwnership.getState().probe();
    throw new FilesystemOwnershipMovedError();
  }
}

/**
 * 一个工作空间的根注册，两侧投影成同一个形状。
 *
 * 读不到注册会抛，而不是回一份权限全 false 的空记录：「还没注册」和
 * 「注册了但什么都不允许」是两回事，界面对两者的说法也不一样。
 */
export interface WorkspaceRegistration {
  workspaceId: string;
  /** 空串表示本机；其余是 `settings.ssh.hosts[].id`。 */
  executionHostId: string;
  rootPath: string;
  permissions: WorkspacePermissions;
}

export const filesGateway = {
  /**
   * 读一个工作空间的根注册。
   *
   * Runtime 侧的答案来自 `workspaces` 行本身，Host 侧来自 `workspace_roots`：
   * 两边投影成同一个领域对象，调用方不需要知道走了哪一侧。
   */
  async registration(workspaceId: string): Promise<WorkspaceRegistration> {
    if ((await readRoute()) === "runtime") {
      // The Runtime has no single-workspace read: the list is the read, and
      // narrowing it here keeps the gateway's answer the same shape either
      // way. A workspace that is not in it has no registration at all.
      const workspaces = await runtimeApi.listWorkspaces();
      const workspace = workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) throw new FilesystemReadOnlyError("error");
      return {
        workspaceId: workspace.id,
        executionHostId: workspace.executionHostId,
        rootPath: workspace.rootPath,
        permissions: workspace.permissions,
      };
    }
    const root = await (await resolver(workspaceId, false)).getRoot();
    return {
      workspaceId: root.workspaceId,
      executionHostId: root.executionHostId,
      rootPath: root.canonicalPath,
      permissions: root.permissions,
    };
  },

  /**
   * 改这个工作空间允许什么。路径不在参数里：工作空间里的一切路径都是相对
   * 冻结的根算的，悄悄换根等于把每一条已存路径的含义都改了。
   */
  async updatePermissions(
    workspaceId: string,
    permissions: WorkspacePermissions,
  ): Promise<WorkspaceRegistration> {
    if ((await writeRoute()) === "runtime") {
      const workspace = await runtimeWrite(() =>
        runtimeApi.updateWorkspace(workspaceId, { permissions }),
      );
      return {
        workspaceId: workspace.id,
        executionHostId: workspace.executionHostId,
        rootPath: workspace.rootPath,
        permissions: workspace.permissions,
      };
    }
    const client = await resolver(workspaceId, true);
    const current = await client.getRoot();
    const root = await client.updateRoot({
      operationId: `filesystem/${workspaceId}/permissions/${current.revision}`,
      permissions,
      expectedRevision: current.revision,
    });
    return {
      workspaceId: root.workspaceId,
      executionHostId: root.executionHostId,
      rootPath: root.canonicalPath,
      permissions: root.permissions,
    };
  },

  /**
   * 打开（或接管）一个本机目录。
   *
   * Runtime 那一侧是一次 `POST /api/workspaces`。Host 这一侧是两步，因为
   * 两个域各记各的：画布域记下工作空间实体，文件域冻结根。顺序不能反——
   * 先有工作空间，才谈得上给它注册根。
   */
  async createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace> {
    if ((await writeRoute()) === "runtime")
      return runtimeWrite(() => runtimeApi.createWorkspace(request));
    const workspaceId = globalThis.crypto.randomUUID();
    const now = BigInt(Date.now());
    const canvas = await canvasResolver(workspaceId, true);
    const created = await canvas.putWorkspace({
      operationId: `workspace/${workspaceId}/create`,
      workspace: {
        $typeName: "armadra.v1.CanvasWorkspace",
        workspaceId,
        name: request.name,
        rootPath: request.rootPath,
        color: request.color ?? "",
        permissions: {
          $typeName: "armadra.v1.CanvasWorkspacePermissions",
          read: request.permissions?.read ?? true,
          write: request.permissions?.write ?? true,
          execute: request.permissions?.execute ?? false,
        },
        createdAtUnixMs: now,
        updatedAtUnixMs: now,
        lastOpenedAtUnixMs: now,
        revision: 0n,
      },
      expectedRevision: 0n,
    });
    const stored = created.workspace!;
    // 根注册是文件域自己的记录，和工作空间实体分开：切换回 Runtime 时它
    // 是反向包里那一份，工作空间实体则由画布域带回去。
    const root = await (
      await resolver(workspaceId, true)
    ).registerRoot({
      operationId: `filesystem/${workspaceId}/register`,
      canonicalPath: request.rootPath,
      permissions: {
        read: stored.permissions?.read ?? true,
        write: stored.permissions?.write ?? true,
        execute: stored.permissions?.execute ?? false,
      },
      expectedRevision: 0n,
    });
    return {
      id: workspaceId,
      name: stored.name,
      rootPath: root.canonicalPath,
      color: stored.color,
      executionHostId: root.executionHostId,
      permissions: root.permissions,
      lastOpenedAt: new Date(Number(stored.lastOpenedAtUnixMs)).toISOString(),
      createdAt: new Date(Number(stored.createdAtUnixMs)).toISOString(),
      updatedAt: new Date(Number(stored.updatedAtUnixMs)).toISOString(),
    };
  },
};
