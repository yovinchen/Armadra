import * as React from "react";

import {
  launchHold,
  migrateLegacyLaunch,
  whenDependenciesKnown,
} from "@/agent/dependency-store";
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

  /** 页面自己敲启动行。节点数据现读：等依赖那一下之后它可能已经变了。 */
  const typeLaunch = React.useCallback(() => {
    const store = useCanvasStore.getState();
    const node = store.document?.nodes.find((item) => item.id === nodeId);
    const nodeData =
      node && node.data.kind === "terminal" ? node.data : refs.dataRef.current;
    const agent = nodeData.agent;
    if (!agent) return;
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

  const fireLaunch = React.useCallback(() => {
    refs.launchTimerRef.current = null;
    if (refs.launchPhaseRef.current !== "armed") return;
    const store = useCanvasStore.getState();
    const node = store.document?.nodes.find((item) => item.id === nodeId);
    const nodeData =
      node && node.data.kind === "terminal" ? node.data : refs.dataRef.current;
    const agent = nodeData.agent;
    refs.launchPhaseRef.current = "sent";
    if (!agent) return;
    const workspaceId = store.workspace?.id;
    const send = (command: string) => {
      refs.transportRef.current?.input(`${command}\r`);
      refs.freshSessionRef.current = false;
    };
    if (agent.pendingLaunch) {
      const pending = agent.pendingLaunch;
      // 旧数据：带依赖的 `pendingLaunch` 迁进 core 的依赖表，之后由 core 启动
      // （Agent 自动化设计 §6）。迁不进去（旧 core）才退回页面自己等。
      if (pending.after.length > 0 && workspaceId !== undefined) {
        void migrateLegacyLaunch(workspaceId, nodeId, pending).then((moved) => {
          if (!moved) armPendingLaunch(nodeId, pending, send);
        });
        return;
      }
      // 不带依赖的那种是「敲这一行」（命令面板的恢复会话）：提示符已经安静
      // 下来了，交给 `pending-launch` 敲并等回执。
      armPendingLaunch(nodeId, pending, send);
      return;
    }
    // 还在等依赖的节点由 core 启动：页面只起 shell，不敲启动行。还不知道有没
    // 有等待时先读一次再决定。
    const hold = launchHold(workspaceId, nodeId);
    if (hold === "held") return;
    if (hold === "free") {
      typeLaunch();
      return;
    }
    void whenDependenciesKnown(workspaceId).then(() => {
      if (launchHold(workspaceId, nodeId) !== "held") typeLaunch();
    });
  }, [refs, nodeId, typeLaunch]);

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
