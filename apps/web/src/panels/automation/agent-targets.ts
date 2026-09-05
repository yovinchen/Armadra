import { create, AgentLaunchSpecSchema } from "@armadra/protocol";
import type { AgentLaunchSpec } from "@armadra/protocol";
import type { CanvasNode } from "@armadra/shared";

import { buildAgentLaunchArgv } from "@/agent/launch";

/**
 * 画布上可以作为「定时提示词」目标的 Agent 终端（自动化设计 §4）。
 *
 * 只列还活着的 Agent 终端：目标身份是节点 + 冻结的 Agent 定义，没有 Agent 的
 * 普通终端不在这里出现——往任意 TUI 里注入输入不是这个功能要做的事。
 */
export interface AgentTargetOption {
  nodeId: string;
  title: string;
  agentId: string;
  sessionId: string;
  cwd: string;
}

export function agentTargets(
  nodes: readonly CanvasNode[] | undefined,
): AgentTargetOption[] {
  if (!nodes) return [];
  const options: AgentTargetOption[] = [];
  for (const node of nodes) {
    if (node.data.kind !== "terminal") continue;
    const { agent, sessionId, ssh, cwd } = node.data;
    // 远端会话的执行位置不在这台 Host 上，冻结它只会做出一份必然拒绝的计划。
    if (!agent?.id || !sessionId || ssh) continue;
    options.push({
      nodeId: node.id,
      title: node.title || agent.id,
      agentId: agent.id,
      sessionId,
      cwd: cwd ?? ".",
    });
  }
  return options;
}

/**
 * 冻结进计划的启动定义。
 *
 * 只带 argv、目录与用于显示/核对的模式与模型；程序名不在里面——执行侧按
 * `agentId` 从自己的注册表解析，所以一份存下来的计划永远变不成「运行这个
 * 二进制」。
 */
export function frozenLaunch(
  option: AgentTargetOption,
  node: CanvasNode | undefined,
): AgentLaunchSpec {
  const agent = node?.data.kind === "terminal" ? node.data.agent : undefined;
  const argv = agent
    ? buildAgentLaunchArgv(agent)
    : { program: "", args: [] as string[] };
  return create(AgentLaunchSpecSchema, {
    agentId: option.agentId,
    workingDirectory: option.cwd,
    args: argv.args,
    permissionMode: agent?.permissionMode ?? "",
    modelId: agent?.model ?? "",
    accountId: "default",
  });
}
