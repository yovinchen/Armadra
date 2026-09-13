import { useQuery } from "@tanstack/react-query";
import {
  modelSuggestions,
  type AgentModel,
  type BuiltinAgentId,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useAgentsQuery } from "@/app/use-agents";

/**
 * 节点头部「模型」菜单的候选（用户实测反馈 F7）。
 *
 * 以前这份列表是 `packages/shared` 里的常量，发版当天就过时：用户的 Codex 已经
 * 在跑 `gpt-6-astra-high`，菜单里既没有它也没有任何别的写法。现在问 Runtime，
 * 它先问 CLI 自己（`claude --help` 的别名、Codex `config.toml` 里配好的模型），
 * 再补 models.dev 上该 provider 的条目，按发布日期倒序。
 *
 * 取不到就退回写死表——**只在这一种情况下**。菜单空着比菜单骗人好，但离线时
 * 连三个 Claude 别名都点不到也没有道理。
 *
 * 自定义 Agent 用自己的 id 请求：它借基础适配器的模型，但探的是它自己那个
 * 启动程序，这件事由 Runtime 判断，前端不复算。
 */
export function useAgentModels(agentId: string | undefined): {
  readonly models: readonly AgentModel[];
  readonly loading: boolean;
} {
  const agents = useAgentsQuery();
  const info = agents.data?.find((entry) => entry.id === agentId);
  const query = useQuery({
    queryKey: ["agent-models", agentId],
    queryFn: () => runtimeApi.agentModels(agentId as string),
    enabled: Boolean(agentId),
    // Runtime 侧已经缓存 10 分钟，这里跟着它，免得每次开菜单都发一次请求。
    staleTime: 10 * 60_000,
  });
  if (query.data) return { models: query.data, loading: false };
  const fallback = modelSuggestions(info?.baseAgent ?? agentId ?? "").map(
    (id): AgentModel => ({ id, label: id, source: "builtin" }),
  );
  return { models: fallback, loading: query.isLoading };
}

/** 写死表本身，给不需要 React 上下文的调用方。 */
export function builtinModels(
  baseAgent: BuiltinAgentId | string,
): readonly string[] {
  return modelSuggestions(baseAgent);
}
