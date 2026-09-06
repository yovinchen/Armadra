/**
 * Agent 状态镜像的补齐点（协作通道 §3.2「刷新后徽标仍在」）。
 *
 * 镜像原来在 `useSessions` 里补：谁渲染了会话侧栏，谁顺便 hydrate。
 * 那让「节点徽标有没有」取决于侧栏挂没挂——手机布局的侧栏是 Radix Sheet，
 * 关上就卸载，刷新页面后画布上的节点一个徽标都没有，要等下一个回合的
 * `agent.status` 才回来。徽标是画布的东西，不是侧栏的东西，所以补齐挪到
 * 应用挂载处：只要打开了工作空间就跑一次，与任何面板的开合无关。
 *
 * 重连同理。事件流断开期间发生的回合没有事件可补，`agent.status` 也不会
 * 重发；`onWorkspaceConnection` 的上升沿因此重新取一次会话列表，让镜像按
 * 服务端当前的说法重建，而不是停在断开那一刻的样子。
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";
import { onWorkspaceConnection } from "../api/events";
import { useAgentStatusStore } from "./status-store";

/**
 * 在应用挂载处补齐镜像，并在事件流重连后重放。
 *
 * 查询键与 `useSessions` 完全相同，因此这里和侧栏共用同一份 react-query
 * 缓存：多挂一个订阅者不会多打一次请求。
 */
export function useAgentStatusHydration(workspaceId: string | null): void {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => runtimeApi.sessions(workspaceId!),
    enabled: Boolean(workspaceId),
    retry: false,
  });
  const hydrate = useAgentStatusStore((state) => state.hydrate);

  useEffect(() => {
    if (query.data && workspaceId) hydrate(query.data, workspaceId);
  }, [query.data, workspaceId, hydrate]);

  useEffect(() => {
    if (!workspaceId) return;
    return onWorkspaceConnection((eventWorkspaceId, connected) => {
      // 只认自己这个工作空间的上升沿：切换工作空间时旧连接的关闭事件不该
      // 触发新工作空间的重取。
      if (eventWorkspaceId !== workspaceId || !connected) return;
      void queryClient.invalidateQueries({
        queryKey: ["sessions", workspaceId],
      });
    });
  }, [workspaceId, queryClient]);
}
