import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";
import { runtimeApi } from "../api/client";
import { setAgentRegistry } from "../agent/launch";
import { agentIsEnabled, usePreferencesStore } from "./preferences-store";

/**
 * `GET /api/agents` 的共享查询。Dock 的新建菜单、命令面板与设置页都读它，
 * react-query 保证只发一次请求。
 *
 * 拿到结果后同步推给 `agent/launch`：自定义 Agent 的名字、颜色与启动程序
 * 只有这个接口知道，而查显示名的地方（节点头、画布卡、会话卡）都是同步的。
 */
export function useAgentsQuery() {
  const query = useQuery({
    queryKey: ["agents"],
    queryFn: runtimeApi.agents,
    staleTime: 60_000,
    retry: false,
  });
  const agents = query.data;
  useEffect(() => {
    if (agents) setAgentRegistry(agents);
  }, [agents]);
  return query;
}

/**
 * 新建菜单里该出现的 Agent（§24.1 Agent 页的三态）。
 *
 * `default` 跟随本机检测，`enabled` 即使没检测到也保留（配合自定义启动命令），
 * `disabled` 一律不列。
 */
export function useEnabledAgents(): AgentInfo[] {
  const agents = useAgentsQuery();
  const modes = usePreferencesStore((state) => state.agentModes);
  return useMemo(
    () =>
      (agents.data ?? []).filter((agent) =>
        agentIsEnabled(modes[agent.id], agent.installed),
      ),
    [agents.data, modes],
  );
}
