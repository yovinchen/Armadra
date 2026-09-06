import {
  DEFAULT_WORKSPACE_PERMISSIONS,
  WORKSPACE_COLORS,
  type CreateWorkspaceRequest,
} from "@armadra/shared";

/**
 * 建一个工作空间要的东西全都能从路径推出来（2026-09-05 精简）。
 *
 * 用户只选路径：名称 = 路径末段，颜色按色板轮询，权限固定读/写/执行全开。
 * 三个对话框（新建文件夹 / 打开文件夹 / 克隆仓库）共用这里的纯函数，
 * 免得各自再长出一套默认值。
 */

/** `/a/b/c`、`C:\a\b`、结尾多余的分隔符，都取最后一段。 */
export function workspaceNameOf(path: string): string {
  const parts = path.trim().split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * 颜色不再让用户挑：按已有工作空间的数量在色板上轮询，
 * 连着建的几个自然是不同颜色。
 */
export function pickWorkspaceColor(existing: readonly unknown[]): string {
  const index = existing.length % WORKSPACE_COLORS.length;
  return WORKSPACE_COLORS[index] ?? WORKSPACE_COLORS[0];
}

/** 拼一条 `POST /api/workspaces` 的请求体。 */
export function workspaceRequest(
  rootPath: string,
  existing: readonly unknown[],
  createDirectory = false,
): CreateWorkspaceRequest {
  const path = rootPath.trim();
  return {
    name: workspaceNameOf(path),
    rootPath: path,
    color: pickWorkspaceColor(existing),
    permissions: { ...DEFAULT_WORKSPACE_PERMISSIONS },
    ...(createDirectory ? { createDirectory: true } : {}),
  };
}
