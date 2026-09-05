import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AgentEvent, WorkspaceEvent } from "@armadra/shared";

import { t } from "../app/preferences-store";
import { onWorkspaceEvent } from "../api/events";

/**
 * 子代理临时卡片（§5.9）。
 *
 * 三条不变式，全部来自计划书：
 *
 *  - **不入库、不进撤销**：卡片只活在这个 store 里。Runtime 的 `hook/ingest`
 *    对 `subagent-*` 事件明确「published, never stored」，前端也就没有理由
 *    把它写进看板文档。刷新页面卡片消失是正确行为。
 *  - **父节点开新回合才清**：`agent.subagent` 只负责加卡片；清理挂在父节点
 *    自己的状态迁移上。Runtime 的 `AgentStatus` 没有 `newTurn` 字段，所以
 *    这里用「父节点从非 working 变成 working」当作新回合的边（父节点自己
 *    的 `done` 保持窗口已经在 status-store 里做过防抖）。清的只有**已结束**
 *    的卡片：还在跑的子代理不该因为父节点又开口而从画布上消失。
 *  - **每个父节点最多 8 张**：超出时丢最旧的，卡片是给人看的进度提示，
 *    不是日志。
 */

/** 每个父节点同时显示的卡片上限（§5.9）。 */
export const MAX_CARDS_PER_PARENT = 8;

export interface SubagentCardModel {
  /** claude 的 `tool_use_id` / codex 的 `agent_id`；两者都缺时按类型兜底。 */
  id: string;
  parentId: string;
  /** `subagentType`：Explore、code-reviewer…… */
  type?: string;
  taskLabel: string;
  /** 毫秒时间戳，计时用。 */
  startedAt: number;
  state: "working" | "done";
  durationMs?: number;
  tokens?: number;
  toolUses?: number;
  /** 结束时子代理返回的那段文本。转录尾部不在事件里，展开只显示它。 */
  result?: string;
}

export interface SubagentState {
  /** 父节点 id → 卡片，按开始顺序。 */
  cards: Record<string, SubagentCardModel[]>;
  /**
   * 父节点上一次的 Agent 状态。清卡片要看的是「迁移」而不是「当前值」，
   * 而 `status-store` 会把 `working` 合并掉，所以这里自己记一份。
   */
  parentState: Record<string, string | undefined>;
  handleEvent: (event: WorkspaceEvent, now?: number) => void;
  /** 只清已结束的卡片（父节点开了新回合）。 */
  clearFinished: (parentId: string) => void;
  /** 节点没了：连正在跑的卡片一起丢。 */
  clearParent: (parentId: string) => void;
  reset: () => void;
}

/**
 * 卡片在 React Flow 里的节点 id。带前缀是为了让它和文档节点的 UUID
 * 永远撞不上——派生节点混在同一个 `nodes` 数组里。
 */
export function subagentNodeId(cardId: string): string {
  return `subagent-card:${cardId}`;
}

/** 事件里没有 id 时的兜底键：同一个父节点 + 同一种子代理算同一张卡。 */
export function cardKey(event: AgentEvent): string {
  return (
    event.toolUseId ?? `${event.nodeId}:${event.subagentType ?? "subagent"}`
  );
}

function startCard(
  event: AgentEvent,
  now: number,
  fallbackLabel: string,
): SubagentCardModel {
  return {
    id: cardKey(event),
    parentId: event.nodeId,
    ...(event.subagentType ? { type: event.subagentType } : {}),
    taskLabel: event.taskLabel ?? event.subagentType ?? fallbackLabel,
    startedAt: now,
    state: "working",
  };
}

/** 结束事件带来的字段；`undefined` 的一律不写，免得覆盖掉开始时的值。 */
function finishCard(
  card: SubagentCardModel,
  event: AgentEvent,
): SubagentCardModel {
  return {
    ...card,
    state: "done",
    ...(event.subagentType ? { type: event.subagentType } : {}),
    ...(event.taskLabel ? { taskLabel: event.taskLabel } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
    ...(event.toolUses === undefined ? {} : { toolUses: event.toolUses }),
    ...(event.result === undefined ? {} : { result: event.result }),
  };
}

/**
 * 默认任务名：事件里既没有 `taskLabel` 也没有类型时用。
 * 是函数而不是常量——模块级常量在导入时求值一次，切换语言不会跟着变。
 */
export const fallbackTaskLabel = (): string => t("subagent.fallback");

export const useSubagentStore = create<SubagentState>((set, get) => ({
  cards: {},
  parentState: {},

  handleEvent: (event, now = Date.now()) => {
    switch (event.type) {
      case "agent.subagent": {
        const incoming = event.event;
        if (
          incoming.kind !== "subagent-start" &&
          incoming.kind !== "subagent-end"
        ) {
          return;
        }
        const parentId = incoming.nodeId;
        const key = cardKey(incoming);
        set((current) => {
          const existing = current.cards[parentId] ?? [];
          const index = existing.findIndex((card) => card.id === key);

          if (incoming.kind === "subagent-start") {
            // 同一个 id 重复开始（客户端重放）不该造出第二张卡。
            const card = startCard(incoming, now, fallbackTaskLabel());
            const next =
              index >= 0
                ? existing.map((item, at) => (at === index ? card : item))
                : [...existing, card];
            return {
              cards: {
                ...current.cards,
                [parentId]: next.slice(-MAX_CARDS_PER_PARENT),
              },
            };
          }

          // 结束事件先到（开始那条丢了）：补一张已完成的卡，
          // 否则统计数字就永远看不见了。
          const base =
            index >= 0
              ? existing[index]!
              : startCard(incoming, now, fallbackTaskLabel());
          const card = finishCard(base, incoming);
          const next =
            index >= 0
              ? existing.map((item, at) => (at === index ? card : item))
              : [...existing, card];
          return {
            cards: {
              ...current.cards,
              [parentId]: next.slice(-MAX_CARDS_PER_PARENT),
            },
          };
        });
        return;
      }

      case "agent.status": {
        const nodeId = event.status.nodeId;
        const previous = get().parentState[nodeId];
        const incoming = event.status.state;
        set((current) => ({
          parentState: { ...current.parentState, [nodeId]: incoming },
        }));
        // 新回合的边：非 working → working。开始跑之前把上一轮的结果清掉。
        if (incoming === "working" && previous !== "working") {
          get().clearFinished(nodeId);
        }
        return;
      }

      case "terminal.exit": {
        if (event.nodeId) get().clearParent(event.nodeId);
        return;
      }

      default:
        return;
    }
  },

  clearFinished: (parentId) =>
    set((current) => {
      const existing = current.cards[parentId];
      if (!existing || existing.length === 0) return current;
      const next = existing.filter((card) => card.state !== "done");
      if (next.length === existing.length) return current;
      const cards = { ...current.cards };
      if (next.length === 0) delete cards[parentId];
      else cards[parentId] = next;
      return { cards };
    }),

  clearParent: (parentId) =>
    set((current) => {
      if (!current.cards[parentId] && !(parentId in current.parentState)) {
        return current;
      }
      const cards = { ...current.cards };
      const parentState = { ...current.parentState };
      delete cards[parentId];
      delete parentState[parentId];
      return { cards, parentState };
    }),

  reset: () => set({ cards: {}, parentState: {} }),
}));

const EMPTY: readonly SubagentCardModel[] = [];

/** 某个父节点当前的卡片（引用稳定，可以直接进依赖数组）。 */
export function useSubagentCards(
  parentId: string,
): readonly SubagentCardModel[] {
  return useSubagentStore((state) => state.cards[parentId] ?? EMPTY);
}

/** 所有卡片，按父节点分组 —— 派生边与临时节点层用。 */
export function useAllSubagentCards(): Record<string, SubagentCardModel[]> {
  return useSubagentStore(useShallow((state) => state.cards));
}

/**
 * 把事件流接到这个 store。挂在画布上一次即可；`api/events.ts` 的
 * `dispatchWorkspaceEvent` 只喂 `status-store`，其余模块都自己订阅。
 */
export function useSubagentEvents(): void {
  useEffect(() => {
    const handle = (event: WorkspaceEvent) =>
      useSubagentStore.getState().handleEvent(event);
    const off = [
      onWorkspaceEvent("agent.subagent", handle),
      onWorkspaceEvent("agent.status", handle),
      onWorkspaceEvent("terminal.exit", handle),
    ];
    return () => {
      for (const release of off) release();
    };
  }, []);
}
