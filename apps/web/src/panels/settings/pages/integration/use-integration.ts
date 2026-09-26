import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";

import { runtimeApi } from "@/api/client";

export function integrationKey(agentId: string) {
  return ["agent-integration", agentId] as const;
}

/** 设置页「集成」一行的全部状态：注入方式、Hook、技能、旧残留，一次读出。 */
export function useAgentIntegration(agent: AgentInfo) {
  const query = useQuery({
    queryKey: integrationKey(agent.id),
    queryFn: ({ signal }) => runtimeApi.agentIntegration(agent.id, signal),
  });
  return {
    integration: query.data ?? null,
    loading: query.isPending,
    error: query.error,
  };
}

/** 重新生成之后同时失效「这一行」与 `GET /api/agents`：两边都带着状态。 */
export function useIntegrationRefresh() {
  const client = useQueryClient();
  return (agentId: string) => {
    void client.invalidateQueries({ queryKey: integrationKey(agentId) });
    void client.invalidateQueries({ queryKey: ["agents"] });
  };
}
