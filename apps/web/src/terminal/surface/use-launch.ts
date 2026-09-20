import * as React from "react";

import { buildAgentLaunch } from "@/agent/launch";
import { armPendingLaunch } from "@/agent/pending-launch";
import { useCanvasStore } from "@/store/canvas-store";
import { LAUNCH_COLD_MS, LAUNCH_QUIET_MS } from "./constants";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

export interface LaunchSequence {
  clearLaunchTimers: () => void;
  armLaunch: () => void;
  noteOutput: () => void;
}

/**
 * 启动行时序（计划书 §5.1）：`hello` 之后武装，提示符安静下来就敲，
 * 一直没有输出则冷启动兜底。整个过程只发生一次，由 `launchPhaseRef` 保证。
 */
export function useLaunchSequence(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    patch: (next: Partial<ConnectionStatus>) => void;
  },
): LaunchSequence {
  const { nodeId, patch } = options;

  const clearLaunchTimers = React.useCallback(() => {
    if (refs.launchTimerRef.current) clearTimeout(refs.launchTimerRef.current);
    if (refs.promptTimerRef.current) clearTimeout(refs.promptTimerRef.current);
    refs.launchTimerRef.current = null;
    refs.promptTimerRef.current = null;
  }, [refs]);

  const fireLaunch = React.useCallback(() => {
    refs.launchTimerRef.current = null;
    if (refs.launchPhaseRef.current !== "armed") return;
    const store = useCanvasStore.getState();
    const node = store.document?.nodes.find((item) => item.id === nodeId);
    const nodeData =
      node && node.data.kind === "terminal" ? node.data : refs.dataRef.current;
    const agent = nodeData.agent;
    if (!agent) {
      refs.launchPhaseRef.current = "sent";
      return;
    }
    refs.launchPhaseRef.current = "sent";
    // `--after` 造出来的节点不在这里启动：把启动行交给 `pending-launch`，
    // 由它等依赖都 `done` 之后再敲（§5.8）。提示符已经安静下来了，
    // 所以之后任何时刻发出去都不会被写到半截的提示符里。
    if (agent.pendingLaunch) {
      const pending = agent.pendingLaunch;
      armPendingLaunch(nodeId, pending, (command) => {
        refs.transportRef.current?.input(`${command}\r`);
        refs.freshSessionRef.current = false;
      });
      return;
    }
    try {
      // 启动行永远在这里重拼，节点上那个 `initialCommand` 从来不是一条指令：
      // 它是「这次连接敲了什么」的记账，和会话 id 同一类（`use-session.ts`）。
      // Agent 建节点时也不再往里写任务了——第一条任务走投递，由 core 在节点第
      // 一次报空闲之后投进来（设计 agent-delivery.md §8）。所以这里也没有第二
      // 条「提示词写进 stdin」的路：启动行只负责把 CLI 起起来。
      const launch = buildAgentLaunch(agent);
      refs.transportRef.current?.input(`${launch.command}\r`);
      refs.freshSessionRef.current = false;
      store.updateNodeData(
        nodeId,
        { agent: { ...agent, initialCommand: launch.command } },
        { history: "ignore" },
      );
    } catch (cause) {
      patch({
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [refs, nodeId, patch]);

  const armLaunch = React.useCallback(() => {
    if (refs.launchPhaseRef.current !== "idle") return;
    refs.launchPhaseRef.current = "armed";
    clearLaunchTimers();
    refs.launchTimerRef.current = setTimeout(fireLaunch, LAUNCH_COLD_MS);
  }, [clearLaunchTimers, fireLaunch]);

  const noteOutput = React.useCallback(() => {
    if (refs.launchPhaseRef.current !== "armed") return;
    if (refs.launchTimerRef.current) clearTimeout(refs.launchTimerRef.current);
    refs.launchTimerRef.current = setTimeout(fireLaunch, LAUNCH_QUIET_MS);
  }, [fireLaunch]);

  return { clearLaunchTimers, armLaunch, noteOutput };
}
