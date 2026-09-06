import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";

/**
 * 工作空间列表（`GET /api/workspaces`）。
 *
 * 首页删掉之后（§27）这份查询只剩侧栏在用：顶行下拉列已知工作空间、
 * 「项目」组按 `openWorkspaceIds` 排行、`useBoardSync` 启动时按 id 找回
 * 上次那个。所以它从 `WorkspaceGrid` 搬到这里，独立成一个模块。
 *
 * `retry: false` 是刻意的：Runtime 连不上时要立刻把错误状态交出去，
 * 而不是先卡三次重试。但错误状态下每 3 秒自己探一次——桌面壳重启 Runtime、
 * 或 `pnpm dev` 那边刚起来时，界面自己就回来了（`useBoardSync` 随后会把
 * 上次的工作空间接上），用户不必做任何事。
 */
const RECONNECT_POLL_MS = 3_000;

export function useWorkspacesQuery() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: runtimeApi.listWorkspaces,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.status === "error" ? RECONNECT_POLL_MS : false,
  });
}
