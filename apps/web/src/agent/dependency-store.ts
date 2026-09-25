/**
 * 依赖等待在页面上的镜像（Agent 自动化设计 §6）。
 *
 * 等待关系与启动都归 core：`open-agent --after` 写依赖表，条件满足时由 core
 * 起终端、敲启动行，页面开没开都一样。页面在这里只做三件事：
 *
 *  - **别抢着启动。** 一个还在等的节点挂载时照样起 shell，但启动行不由页面
 *    敲——{@link launchHold} 答 `held` 时 `use-launch` 就停手。还没读到答案时
 *    答 `unknown`，调用方先等这一次读取（{@link whenDependenciesKnown}）；读
 *    不到就放行，core 那边启动前会看前台是不是已经在跑这个 Agent，不会敲第二遍。
 *  - **画出来。** 节点头的「等待 X」读这里；数据只来自 core，页面不按事件自己
 *    推算——上游报一次状态、画布存一次、终端退出一次，都只是「该重读了」。
 *  - **迁走旧数据。** 旧版本写在节点数据里的带依赖 `pendingLaunch` 交给 core
 *    建成依赖行，然后从节点数据里摘掉（{@link migrateLegacyLaunch}）。
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
  DependencyLaunch,
  PendingLaunch,
  WorkspaceEvent,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";

/** 事件之后等这么久再重读：一轮结束常常是连着几帧。 */
export const DEPENDENCY_REFRESH_DEBOUNCE_MS = 300;
/** 没有任何事件时也隔这么久重读一次：过期是 core 自己扫出来的，没有帧。 */
export const DEPENDENCY_POLL_MS = 30_000;

interface DependencyState {
  readonly workspaceId: string | null;
  readonly loaded: boolean;
  /** 下游节点 id → 它那一次还没了结的启动。 */
  readonly launches: Readonly<Record<string, DependencyLaunch>>;
  refresh: (workspaceId: string) => Promise<void>;
  handleEvent: (event: WorkspaceEvent) => void;
  reset: () => void;
}

let inFlight: { workspaceId: string; promise: Promise<void> } | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

export const useDependencyStore = create<DependencyState>((set, get) => ({
  workspaceId: null,
  loaded: false,
  launches: {},
  refresh: (workspaceId) => {
    if (inFlight?.workspaceId === workspaceId) return inFlight.promise;
    if (get().workspaceId !== workspaceId) {
      set({ workspaceId, loaded: false, launches: {} });
    }
    const promise = runtimeApi
      .dependencies(workspaceId)
      .then((answer) => {
        if (get().workspaceId !== workspaceId) return;
        const launches: Record<string, DependencyLaunch> = {};
        for (const launch of answer.launches) launches[launch.nodeId] = launch;
        set({ loaded: true, launches });
      })
      .catch(() => {
        // 读不到（旧 core、网络抖动）就当没有等待：放行比把节点永远卡在
        // 「还不知道」上好，core 启动前自己会看前台。
        if (get().workspaceId !== workspaceId) return;
        set({ loaded: true });
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { workspaceId, promise };
    if (poll === null) {
      poll = setInterval(() => {
        const current = get().workspaceId;
        if (current !== null) void get().refresh(current);
      }, DEPENDENCY_POLL_MS);
    }
    return promise;
  },
  handleEvent: (event) => {
    if (
      event.type !== "agent.status" &&
      event.type !== "board.changed" &&
      event.type !== "terminal.exit"
    ) {
      return;
    }
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void get().refresh(workspaceId);
    }, DEPENDENCY_REFRESH_DEBOUNCE_MS);
  },
  reset: () => {
    if (debounce !== null) clearTimeout(debounce);
    if (poll !== null) clearInterval(poll);
    debounce = null;
    poll = null;
    inFlight = null;
    set({ workspaceId: null, loaded: false, launches: {} });
  },
}));

/** 这个节点的启动现在归谁：`held` 归 core，`free` 归页面。 */
export function launchHold(
  workspaceId: string | undefined,
  nodeId: string,
): "held" | "free" | "unknown" {
  const state = useDependencyStore.getState();
  if (workspaceId === undefined || state.workspaceId !== workspaceId) {
    return "unknown";
  }
  if (!state.loaded) return "unknown";
  return state.launches[nodeId]?.state === "waiting" ? "held" : "free";
}

/** 等到这个工作空间的依赖读过至少一次（失败也算读过）。 */
export async function whenDependenciesKnown(
  workspaceId: string | undefined,
): Promise<void> {
  if (workspaceId === undefined) return;
  const state = useDependencyStore.getState();
  if (state.workspaceId === workspaceId && state.loaded) return;
  await state.refresh(workspaceId);
}

/** 节点头读的那一份。 */
export function useNodeDependencies(
  workspaceId: string | null,
  nodeId: string,
): DependencyLaunch | undefined {
  useEffect(() => {
    if (workspaceId === null) return;
    const state = useDependencyStore.getState();
    if (state.workspaceId !== workspaceId) void state.refresh(workspaceId);
  }, [workspaceId]);
  return useDependencyStore((state) =>
    state.workspaceId === workspaceId ? state.launches[nodeId] : undefined,
  );
}

/** 不等了：把这个节点还挡着它的边全部取消。 */
export async function cancelNodeDependencies(
  workspaceId: string,
  launch: DependencyLaunch,
): Promise<void> {
  const blocking = launch.dependencies.filter(
    (edge) => edge.state !== "satisfied" && edge.state !== "cancelled",
  );
  try {
    for (const edge of blocking) {
      await runtimeApi.cancelDependency(workspaceId, edge.id);
    }
  } finally {
    await useDependencyStore.getState().refresh(workspaceId);
  }
}

/**
 * 旧数据迁入：带依赖的 `pendingLaunch` 交给 core，成功之后从节点数据里摘掉
 * （不进撤销栈，同会话 id 那一类记账）。答 `false` 时调用方退回旧的页面侧等待。
 */
export async function migrateLegacyLaunch(
  workspaceId: string,
  nodeId: string,
  pending: PendingLaunch,
): Promise<boolean> {
  try {
    await runtimeApi.importLegacyDependencies(
      workspaceId,
      nodeId,
      pending.after,
    );
  } catch {
    return false;
  }
  const store = useCanvasStore.getState();
  const node = store.document?.nodes.find((item) => item.id === nodeId);
  if (node?.data.kind === "terminal" && node.data.agent?.pendingLaunch) {
    const { pendingLaunch: _dropped, ...agent } = node.data.agent;
    store.updateNodeData(nodeId, { agent }, { history: "ignore" });
  }
  await useDependencyStore.getState().refresh(workspaceId);
  return true;
}
