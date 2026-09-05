import * as React from "react";
import {
  agentDefinition,
  effectiveCapabilities,
  resolveAgentCapabilities,
  type AgentCapability,
  type AgentInfo,
  type BuiltinAgentId,
  type ExecutionHostKind,
  type ResolvedCapability,
} from "@armadra/shared";

import { useAgentsQuery } from "@/app/use-agents";

/**
 * 有效能力（Agent 自动化设计 §1）。
 *
 * 求交集的规则全在 shared 的 `resolveAgentCapabilities` 里（纯函数、有测试）；
 * 这里只负责把 `GET /api/agents` 那一行拆成它要的四份输入：
 *
 *   * 基础适配器声明的能力 —— 自定义 Agent 的那一行已经被 Runtime 收窄过，
 *     所以 `info.capabilities` 就是「基础声明 ∩ 自定义配置」；
 *   * CLI 版本探测结果 —— 探不到就是 `unknown`，`unknown` 不画按钮；
 *   * 执行主机 —— SSH 终端的转录和账号都在对面那台机器上。
 *
 * 一律不做名称推断：注册表里没有的能力，任何一步都加不回来。
 */
export function resolveNodeCapabilities(
  info: AgentInfo | undefined,
  host: ExecutionHostKind,
): readonly ResolvedCapability[] {
  if (!info) return [];
  const baseAgent = (info.baseAgent ?? info.id) as BuiltinAgentId;
  if (!agentDefinition(baseAgent)) return [];
  return resolveAgentCapabilities({
    baseAgent,
    // Runtime 已经把自定义 Agent 关掉的能力过滤掉了；把结果当成「声明」传进
    // 去，比在这里再复算一遍 `disabledCapabilities` 少一个会走偏的副本。
    declared: info.capabilities,
    probe: info.probe ?? null,
    host,
  });
}

/** 某个节点当前真正可用的能力集合；`unknown` 不在其中。 */
export function useNodeCapabilities(
  agentId: string | undefined,
  host: ExecutionHostKind,
): readonly AgentCapability[] {
  const agents = useAgentsQuery();
  const info = agents.data?.find((entry) => entry.id === agentId);
  return React.useMemo(() => {
    if (!info) return [];
    const baseAgent = (info.baseAgent ?? info.id) as BuiltinAgentId;
    if (!agentDefinition(baseAgent)) return [];
    return effectiveCapabilities({
      baseAgent,
      declared: info.capabilities,
      probe: info.probe ?? null,
      host,
    });
  }, [info, host]);
}
