import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspacePermissions,
} from "@armadra/shared";

import { runtimeApi } from "../api/client";

/**
 * 文件域网关。
 *
 * 搬迁时代这里要在 Runtime 的 `workspaces` 行与 Host 的 `workspace_roots`
 * 之间选一侧；单一 core 之后根注册只有一份，所以只剩 `/api/workspaces`。
 *
 * 模块留着是因为它定了一个**领域对象**：一个工作空间的根注册——在哪台机器上、
 * 冻结的根是哪条路径、允许读/写/执行到什么程度。调用点读的是它，不是一行
 * 工作空间记录的全部字段。
 */

/** 读不到注册时抛。和「注册了但什么都不允许」是两回事。 */
export class WorkspaceRegistrationError extends Error {
  readonly name = "WorkspaceRegistrationError";
  constructor(readonly workspaceId: string) {
    super(`No registration for workspace ${workspaceId}.`);
  }
}

/** 一个工作空间的根注册。 */
export interface WorkspaceRegistration {
  workspaceId: string;
  /** 空串表示本机；其余是 `settings.ssh.hosts[].id`。 */
  executionHostId: string;
  rootPath: string;
  permissions: WorkspacePermissions;
}

function fromWorkspace(workspace: Workspace): WorkspaceRegistration {
  return {
    workspaceId: workspace.id,
    executionHostId: workspace.executionHostId,
    rootPath: workspace.rootPath,
    permissions: workspace.permissions,
  };
}

export const filesGateway = {
  /**
   * 读一个工作空间的根注册。
   *
   * core 没有单个工作空间的读：列表就是那次读。不在列表里的工作空间根本
   * 没有注册，那是一个明确的答案，不是一份权限全 false 的空记录。
   */
  async registration(workspaceId: string): Promise<WorkspaceRegistration> {
    const workspaces = await runtimeApi.listWorkspaces();
    const workspace = workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new WorkspaceRegistrationError(workspaceId);
    return fromWorkspace(workspace);
  },

  /**
   * 改这个工作空间允许什么。路径不在参数里：工作空间里的一切路径都是相对
   * 冻结的根算的，悄悄换根等于把每一条已存路径的含义都改了。
   */
  async updatePermissions(
    workspaceId: string,
    permissions: WorkspacePermissions,
  ): Promise<WorkspaceRegistration> {
    return fromWorkspace(
      await runtimeApi.updateWorkspace(workspaceId, { permissions }),
    );
  },

  /** 打开（或接管）一个本机目录。 */
  createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace> {
    return runtimeApi.createWorkspace(request);
  },
};
