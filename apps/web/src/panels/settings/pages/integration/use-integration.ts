import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";

import { runtimeApi, RuntimeRequestError } from "@/api/client";
import type { AgentIntegration, IntegrationMode } from "./types";

/**
 * 一个 CLI 的接入怎么送进去（设计 §4）。
 *
 * 与 Runtime 的 `agent.rs::state_source_for` 是同一张表的前端副本，只在
 * Runtime 还没有 `GET …/integration` 时用作兜底；接上之后以 Runtime 答的
 * `mode` 为准。自定义 Agent 跟着它的基础适配器走，和权限旗标、事件表一样。
 *
 *  - `launch`：Claude 与 Copilot 在启动行上带临时配置，不碰全局文件；
 *  - `file`：Codex 的 `~/.codex/hooks.json`、Gemini 的 `settings.json`；
 *  - `extension`：CLI 进程内的扩展自己连 `hook.sock`。
 */
const FALLBACK_MODES: Record<string, IntegrationMode> = {
  claude: "launch",
  copilot: "launch",
  codex: "file",
  gemini: "file",
  opencode: "extension",
  pi: "extension",
  omp: "extension",
};

export function fallbackMode(agent: AgentInfo): IntegrationMode {
  return FALLBACK_MODES[agent.baseAgent ?? agent.id] ?? "file";
}

/**
 * Runtime 还没有这条路由时，用 `GET /api/agents` 已经答过的东西拼一份。
 *
 * 少的正是新加的那两样：注入方式只能查表，旧残留一条都报不出来——所以
 * 页面在这种情况下不画「检测到旧残留」，而不是画一个空的、看起来像「干净」
 * 的区块。两者不是一回事。
 */
function fromAgentInfo(agent: AgentInfo): AgentIntegration {
  return {
    agentId: agent.id,
    mode: fallbackMode(agent),
    hook: {
      installed: typeof agent.clientRevision === "number",
      revision: agent.clientRevision ?? null,
    },
    skill: {
      installed: typeof agent.skillsRevision === "number",
      revision: agent.skillsRevision ?? null,
    },
    legacy: { found: [] },
    revision: agent.clientRevision ?? 0,
  };
}

function missingRoute(error: unknown): boolean {
  return error instanceof RuntimeRequestError && error.status === 404;
}

export function integrationKey(agentId: string) {
  return ["agent-integration", agentId] as const;
}

/**
 * 设置页「集成」一行的全部状态。
 *
 * `supported` 说的是 Runtime 到底有没有这条路由：没有的时候这一行仍然显示
 * Hook 与技能（它们本来就在 `GET /api/agents` 里），只是不谈旧残留，也不给
 * 「修复」按钮——一个必然 404 的按钮比没有按钮更糟（F1 就是这么被误读的）。
 */
export function useAgentIntegration(agent: AgentInfo) {
  const query = useQuery({
    queryKey: integrationKey(agent.id),
    retry: false,
    queryFn: ({ signal }) =>
      runtimeApi
        .agentIntegration(agent.id, signal)
        .then((integration) => ({ integration, supported: true }))
        .catch((error: unknown) => {
          if (!missingRoute(error)) throw error;
          return { integration: null, supported: false };
        }),
  });
  const supported = query.data?.supported ?? false;
  return {
    integration: query.data?.integration ?? fromAgentInfo(agent),
    supported,
    loading: query.isPending,
  };
}

/** 装 / 卸之后同时失效「这一行」与 `GET /api/agents`：两边都带着状态。 */
export function useIntegrationRefresh() {
  const client = useQueryClient();
  return (agentId: string) => {
    void client.invalidateQueries({ queryKey: integrationKey(agentId) });
    void client.invalidateQueries({ queryKey: ["agents"] });
  };
}

/**
 * 一个按钮同时管 Hook 与技能。
 *
 * Runtime 那边把两者合成了一个安装单元；这里在它还没有合之前退回分别调用
 * 老的两条路由，顺序是先 Hook 后技能——技能只是一份说明书，Hook 没装上时
 * 单独装它没有意义。
 */
export async function runIntegrationInstall(
  agentId: string,
  action: "install" | "uninstall",
): Promise<string | null> {
  try {
    const answer = await (action === "install"
      ? runtimeApi.installAgentIntegration(agentId)
      : runtimeApi.uninstallAgentIntegration(agentId));
    return answer.hook.warning ?? null;
  } catch (error) {
    if (!missingRoute(error)) throw error;
  }
  if (action === "uninstall") {
    await runtimeApi.uninstallAgentSkills(agentId);
    const report = await runtimeApi.uninstallAgentHooks(agentId);
    return report.warning ?? null;
  }
  const report = await runtimeApi.installAgentHooks(agentId);
  await runtimeApi.installAgentSkills(agentId);
  return report.warning ?? null;
}
