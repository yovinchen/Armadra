import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentStatus,
  CanvasNode,
  PendingLaunch,
} from "@armadra/shared";

import { useCanvasStore } from "../store/canvas-store";
import { useAgentStatusStore } from "./status-store";

/**
 * 待启动 DAG（§5.8）。
 *
 * `open-agent --after A,B` 创建的节点带 `pendingLaunch {command, after[]}`
 * 且**不起进程**。判定规则逐字来自计划书：
 *
 *  - 所有依赖 `done` 且没有 `errored` → 满足；
 *  - 依赖已经不在画布上 → 视为满足（等一个不存在的节点等不到）；
 *  - 依赖状态未知 → **不满足**（乐观放行等于让 Agent 在别人还没写完时开工）。
 *
 * 满足之后把启动行敲进 PTY、清掉 `pendingLaunch` 并落盘。45 秒没有回执就
 * 重试，三次之后交给人：节点头部出现 ▶「立即运行」。
 *
 * 计时器与发送回调都放在模块级的 `records` 里而不是组件里：`pendingLaunch`
 * 一旦清掉，驱动它的那个 effect 就没有依据继续存在了，但重试还得跑完。
 */

/** 发出启动行后等回执的时长。 */
export const STALL_TIMEOUT_MS = 45_000;
/** 自动重试次数；用完之后只剩手动 ▶。 */
export const MAX_RETRIES = 3;

export type PendingLaunchPhase = "waiting" | "sent" | "manual";

export interface PendingLaunchEntry {
  phase: PendingLaunchPhase;
  /** 已经发出去几次（第一次不算重试）。 */
  attempts: number;
}

export interface PendingLaunchState {
  entries: Record<string, PendingLaunchEntry>;
  /** 本次运行里由 `--after` 启动过的节点 → 它当时的依赖（rope 边用）。 */
  launchedAfter: Record<string, string[]>;
  set: (nodeId: string, entry: PendingLaunchEntry) => void;
  forget: (nodeId: string) => void;
  remember: (nodeId: string, after: readonly string[]) => void;
  reset: () => void;
}

export const usePendingLaunchStore = create<PendingLaunchState>((setState) => ({
  entries: {},
  launchedAfter: {},
  set: (nodeId, entry) =>
    setState((current) => ({
      entries: { ...current.entries, [nodeId]: entry },
    })),
  forget: (nodeId) =>
    setState((current) => {
      if (!(nodeId in current.entries)) return current;
      const entries = { ...current.entries };
      delete entries[nodeId];
      return { entries };
    }),
  remember: (nodeId, after) =>
    setState((current) => ({
      launchedAfter: { ...current.launchedAfter, [nodeId]: [...after] },
    })),
  reset: () => setState({ entries: {}, launchedAfter: {} }),
}));

/* --------------------------------- 门判定 --------------------------------- */

/**
 * 一个依赖是否算「完成」。导出是为了让测试逐条覆盖三种情形，
 * 也因为会话侧栏以后可能要显示同一句话。
 */
export function dependencySatisfied(
  dependencyId: string,
  nodeIds: ReadonlySet<string>,
  statuses: Readonly<Record<string, AgentStatus>>,
): boolean {
  // 节点已被删除：等它等不到了，放行。
  if (!nodeIds.has(dependencyId)) return true;
  const status = statuses[dependencyId];
  // 从来没报过状态 = 未知，不放行。
  if (!status?.state) return false;
  return status.state === "done" && status.errored !== true;
}

export function dependenciesSatisfied(
  after: readonly string[],
  nodes: readonly CanvasNode[],
  statuses: Readonly<Record<string, AgentStatus>>,
): boolean {
  const ids = new Set(nodes.map((node) => node.id));
  return after.every((id) => dependencySatisfied(id, ids, statuses));
}

/* ------------------------------ 运行期的记账 ------------------------------ */

interface Record_ {
  command: string;
  after: string[];
  send: (command: string) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const records = new Map<string, Record_>();

function clearTimer(record: Record_): void {
  if (record.timer) clearTimeout(record.timer);
  record.timer = null;
}

/** 节点自己报过状态、或 CLI 已经自报了会话 id，就算启动行落地了。 */
function acknowledged(nodeId: string): boolean {
  if (useAgentStatusStore.getState().statuses[nodeId]) return true;
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((item) => item.id === nodeId);
  return Boolean(node?.data.kind === "terminal" && node.data.agent?.sessionId);
}

/** 把 `pendingLaunch` 从节点数据里摘掉并记下启动行（走正常的自动保存）。 */
function commitLaunch(nodeId: string, command: string): void {
  const store = useCanvasStore.getState();
  const node = store.document?.nodes.find((item) => item.id === nodeId);
  if (!node || node.data.kind !== "terminal" || !node.data.agent) return;
  const { pendingLaunch: _dropped, ...agent } = node.data.agent;
  store.updateNodeData(nodeId, {
    agent: { ...agent, initialCommand: command },
  });
}

function scheduleStallCheck(nodeId: string): void {
  const record = records.get(nodeId);
  if (!record) return;
  clearTimer(record);
  record.timer = setTimeout(() => {
    const current = records.get(nodeId);
    if (!current) return;
    current.timer = null;
    if (acknowledged(nodeId)) return;
    const entry = usePendingLaunchStore.getState().entries[nodeId];
    const attempts = entry?.attempts ?? 1;
    if (attempts > MAX_RETRIES) {
      // 三次都没有回执：不再自己重试，交给节点头部的 ▶。
      usePendingLaunchStore
        .getState()
        .set(nodeId, { phase: "manual", attempts });
      return;
    }
    usePendingLaunchStore
      .getState()
      .set(nodeId, { phase: "sent", attempts: attempts + 1 });
    current.send(current.command);
    scheduleStallCheck(nodeId);
  }, STALL_TIMEOUT_MS);
}

function fire(nodeId: string): void {
  const record = records.get(nodeId);
  if (!record) return;
  const store = usePendingLaunchStore.getState();
  if (store.entries[nodeId]?.phase !== "waiting") return;
  store.set(nodeId, { phase: "sent", attempts: 1 });
  store.remember(nodeId, record.after);
  record.send(record.command);
  commitLaunch(nodeId, record.command);
  scheduleStallCheck(nodeId);
}

/** 依赖变了就重算一次。便宜到可以挂在每一次 store 变更上。 */
export function evaluatePendingLaunch(nodeId: string): void {
  const record = records.get(nodeId);
  if (!record) return;
  if (usePendingLaunchStore.getState().entries[nodeId]?.phase !== "waiting") {
    return;
  }
  const nodes = useCanvasStore.getState().document?.nodes ?? [];
  const statuses = useAgentStatusStore.getState().statuses;
  if (!dependenciesSatisfied(record.after, nodes, statuses)) return;
  fire(nodeId);
}

/** 头部 ▶：不再等回执，直接再敲一次。 */
export function runPendingLaunchNow(nodeId: string): void {
  const record = records.get(nodeId);
  if (!record) return;
  const store = usePendingLaunchStore.getState();
  const attempts = (store.entries[nodeId]?.attempts ?? 0) + 1;
  store.set(nodeId, { phase: "sent", attempts });
  store.remember(nodeId, record.after);
  record.send(record.command);
  commitLaunch(nodeId, record.command);
  clearTimer(record);
}

/**
 * 终端表面在 `hello` + 提示符安静下来之后调它。重复调用只更新发送回调
 * （重连之后 transport 换了一个）。
 */
export function armPendingLaunch(
  nodeId: string,
  pending: PendingLaunch,
  send: (command: string) => void,
): void {
  const existing = records.get(nodeId);
  if (existing) {
    existing.send = send;
  } else {
    records.set(nodeId, {
      command: pending.command,
      after: [...pending.after],
      send,
      timer: null,
    });
    usePendingLaunchStore.getState().set(nodeId, {
      phase: "waiting",
      attempts: 0,
    });
  }
  evaluatePendingLaunch(nodeId);
}

/** 节点卸载 / 会话重建：停掉计时器，但保留「谁开出了谁」的记忆。 */
export function disarmPendingLaunch(nodeId: string): void {
  const record = records.get(nodeId);
  if (!record) return;
  clearTimer(record);
  records.delete(nodeId);
  usePendingLaunchStore.getState().forget(nodeId);
}

/** 测试用：清掉所有计时器与状态。 */
export function resetPendingLaunches(): void {
  for (const record of records.values()) clearTimer(record);
  records.clear();
  usePendingLaunchStore.getState().reset();
}

/* ---------------------------------- hooks --------------------------------- */

/**
 * 依赖状态一变就重算。挂在终端表面上：只要那个节点还在画布上，
 * 它就是唯一有资格敲启动行的地方。
 */
export function usePendingLaunchWatcher(nodeId: string, armed: boolean): void {
  useEffect(() => {
    if (!armed) return;
    const evaluate = () => evaluatePendingLaunch(nodeId);
    evaluate();
    const offCanvas = useCanvasStore.subscribe(evaluate);
    const offStatus = useAgentStatusStore.subscribe(evaluate);
    return () => {
      offCanvas();
      offStatus();
    };
  }, [armed, nodeId]);
}

export function usePendingLaunch(
  nodeId: string,
): PendingLaunchEntry | undefined {
  return usePendingLaunchStore((state) => state.entries[nodeId]);
}

export function useLaunchedAfter(): Record<string, string[]> {
  return usePendingLaunchStore(useShallow((state) => state.launchedAfter));
}
