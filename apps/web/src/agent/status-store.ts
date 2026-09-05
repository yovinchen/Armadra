/**
 * Agent 状态的前端镜像（§5.4 / §13.4）。
 *
 * 真相在 Runtime 的 `agent/status.rs`；这里只做**显示侧**的同一套归约，
 * 让节点胶囊、光晕和会话侧栏在两条事件之间不会闪：
 *
 *  - **done 保持 3s**：claude 的 hook 是并行执行的，`Stop` 之后可能还会
 *    飘来一条迟到的 `working`，它不该把刚结束的回合复活。
 *  - **未读**：`done` 到达时，如果该节点没被选中、或窗口没有焦点，
 *    就置未读；`markRead` 清除（点开节点即视为已读）。
 *  - **乱序丢弃**：`updatedAt` 比现有的旧的一律忽略。
 *
 * 其余不变式（idle 救援、awaitingInput 保持、20 分钟合成结束边）由 Runtime
 * 归约后才推给前端，前端不重复实现。
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentStatus,
  SessionSummary,
  WorkspaceEvent,
} from "@armadra/shared";

import type { StatusTone } from "../ui/status-pill";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";

/** 迟到的 `working` 在这个窗口内不能覆盖 `done`。 */
export const DONE_HOLDOFF_MS = 3_000;

/**
 * 权限请求的本地过期时间（§5.5）。
 *
 * Runtime 侧的 hook 客户端在 `ARMADRA_PERM_WAIT_SECS` 之后自己 fail-open，
 * 之后既不会再来 `agent.approval`，也未必会来新的 `agent.status`。
 * 没有这个兜底，节点头部的「允许 / 拒绝」会一直挂着，点下去只会 404。
 */
export const APPROVAL_TTL_MS = 5 * 60_000;

/** 归约时需要知道的「用户此刻在不在看这个节点」。测试里显式传入。 */
export interface StatusContext {
  selected?: boolean;
  focused?: boolean;
  now?: number;
  /** `false` 时不发已读回执（测试用）。 */
  remote?: boolean;
}

export interface AgentStatusState {
  statuses: Record<string, AgentStatus>;
  /** 每个节点最近一次进入 `done` 的时刻（毫秒），保持窗口用。 */
  doneAt: Record<string, number>;
  /** 每个节点当前 `pendingId` 是什么时候出现的（毫秒），过期用。 */
  pendingSince: Record<string, number>;
  upsert: (status: AgentStatus, context?: StatusContext) => void;
  /**
   * 清未读：本地立刻清，同时把回执 POST 给 Runtime（否则重连 / 重启后
   * `GET /sessions` 又会把未读补回来）。`remote: false` 只在测试里用。
   */
  markRead: (nodeId: string, options?: { remote?: boolean }) => void;
  /** 权限已答复（或已过期）：丢掉 `pendingId`，头部按钮随之消失。 */
  resolveApproval: (pendingId: string) => void;
  /** 扫掉超过 `APPROVAL_TTL_MS` 的 `pendingId`。 */
  sweepApprovals: (now?: number) => void;
  hydrate: (sessions: SessionSummary[], workspaceId?: string) => void;
  handleEvent: (event: WorkspaceEvent, context?: StatusContext) => void;
  reset: () => void;
}

function isNodeSelected(nodeId: string): boolean {
  return useCanvasStore.getState().selectedNodeIds.includes(nodeId);
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.hasFocus();
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

/* ------------------------------- 已读回执 -------------------------------- */

const RUNTIME_BASE: string =
  (import.meta.env.VITE_RUNTIME_URL as string | undefined) ??
  "http://127.0.0.1:43120";

interface OptionalRuntimeApi {
  markAgentRead?: (nodeId: string) => Promise<unknown>;
}

/**
 * `POST /api/agent-status/{nodeId}/read`。
 * `api/client.ts` 由另一位 agent 归属，方法可能还没补上，所以做成软引用：
 * 有同名方法就走它（带鉴权头与错误映射），没有就退回裸 fetch。
 */
export async function postAgentRead(nodeId: string): Promise<void> {
  const optional = runtimeApi as unknown as OptionalRuntimeApi;
  if (typeof optional.markAgentRead === "function") {
    await optional.markAgentRead(nodeId);
    return;
  }
  if (typeof fetch !== "function") return;
  await fetch(
    `${RUNTIME_BASE}/api/agent-status/${encodeURIComponent(nodeId)}/read`,
    { method: "POST" },
  );
}

export const useAgentStatusStore = create<AgentStatusState>((set, get) => ({
  statuses: {},
  doneAt: {},
  pendingSince: {},

  upsert: (incoming, context) => {
    const now = context?.now ?? Date.now();
    const previous = get().statuses[incoming.nodeId];

    // 乱序帧：只按时间戳判断，不按到达顺序。
    if (previous && millis(incoming.updatedAt) < millis(previous.updatedAt)) {
      return;
    }

    // `terminal.exit` 已经把镜像条目删掉了；60s 后巡检才补出来的那条合成
    // 收尾不该把它重新变出来，否则终端都凉了一分钟，节点上又冒出个胶囊。
    if (!previous && isSyntheticClose(incoming)) return;

    let state = incoming.state;
    const doneAt = get().doneAt[incoming.nodeId];
    const holding =
      previous?.state === "done" &&
      incoming.state === "working" &&
      doneAt !== undefined &&
      now - doneAt < DONE_HOLDOFF_MS;
    if (holding) state = "done";

    // 未读只由 Runtime 置位、由已读回执清除（§5.4）。开新回合**不算**看过：
    // §5.7 的消息投递正是靠往目标 PTY 写一行来开新回合，那时用户可能根本
    // 没看过上一回合的结果；在这里清掉徽标，恰好清在它最有信息量的时候。
    // 所以这里只把 Runtime 的值原样带过来，不做「非 done 即已读」的清除。
    let unread = incoming.unread;
    // 唯一的本地判断：回合结束的那一刻用户正盯着这个节点，那他就是看到了。
    // 只有客户端知道这件事，所以由客户端补一条已读回执，让 SQLite 跟上——
    // 否则刷新一次徽标又会回来。
    let watched = false;
    if (state === "done" && incoming.unread) {
      const selected = context?.selected ?? isNodeSelected(incoming.nodeId);
      const focused = context?.focused ?? isWindowFocused();
      const entered = previous?.state !== "done";
      watched = entered && selected && focused;
      if (watched) unread = false;
    }

    const next: AgentStatus = { ...incoming, state, unread };
    set((current) => {
      const pendingSince = { ...current.pendingSince };
      if (!next.pendingId) delete pendingSince[incoming.nodeId];
      else if (previous?.pendingId !== next.pendingId) {
        pendingSince[incoming.nodeId] = now;
      }
      return {
        statuses: { ...current.statuses, [incoming.nodeId]: next },
        doneAt:
          state === "done" && previous?.state !== "done"
            ? { ...current.doneAt, [incoming.nodeId]: now }
            : current.doneAt,
        pendingSince,
      };
    });
    if (watched && context?.remote !== false) {
      // 已知竞态（不修）：回执在途时如果又结束了一个回合，Runtime 会先把
      // `unread` 重新置起来、再被这条回执清掉，于是第二个回合被当成看过了。
      // 要修得给回执带上它确认的那一帧（序号或时间戳），代价高于收益——
      // 触发它需要两个回合在一个来回的往返时间内先后结束。
      void postAgentRead(incoming.nodeId).catch(() => undefined);
    }
  },

  markRead: (nodeId, options) => {
    const status = get().statuses[nodeId];
    if (!status || !status.unread) return;
    set((current) => ({
      statuses: {
        ...current.statuses,
        [nodeId]: { ...current.statuses[nodeId]!, unread: false },
      },
    }));
    if (options?.remote === false) return;
    // 回执失败不回滚：本地已读是用户看见的事实，下一条状态帧会重新对齐。
    void postAgentRead(nodeId).catch(() => undefined);
  },

  resolveApproval: (pendingId) =>
    set((current) => {
      const entry = Object.entries(current.statuses).find(
        ([, status]) => status.pendingId === pendingId,
      );
      if (!entry) return current;
      const [nodeId, status] = entry;
      const { pendingId: _dropped, ...rest } = status;
      const pendingSince = { ...current.pendingSince };
      delete pendingSince[nodeId];
      return {
        statuses: { ...current.statuses, [nodeId]: rest },
        pendingSince,
      };
    }),

  sweepApprovals: (now = Date.now()) =>
    set((current) => {
      const expired = Object.entries(current.pendingSince).filter(
        ([, since]) => now - since >= APPROVAL_TTL_MS,
      );
      if (expired.length === 0) return current;
      const statuses = { ...current.statuses };
      const pendingSince = { ...current.pendingSince };
      for (const [nodeId] of expired) {
        delete pendingSince[nodeId];
        const status = statuses[nodeId];
        if (!status?.pendingId) continue;
        const { pendingId: _dropped, ...rest } = status;
        statuses[nodeId] = rest;
      }
      return { statuses, pendingSince };
    }),

  /**
   * 用 `GET /sessions` 的结果补齐镜像（冷启动、重连后）。
   * 只补有 Agent 的会话——普通终端没有状态可镜像——并且不覆盖更新的本地条目。
   */
  hydrate: (sessions, workspaceId) =>
    set((current) => {
      const statuses = { ...current.statuses };
      let changed = false;
      for (const session of sessions) {
        if (!session.agentId) continue;
        const previous = statuses[session.nodeId];
        if (previous && millis(session.updatedAt) <= millis(previous.updatedAt))
          continue;
        statuses[session.nodeId] = {
          nodeId: session.nodeId,
          workspaceId: workspaceId ?? previous?.workspaceId ?? "",
          agentId: session.agentId,
          state: session.state,
          unread: session.unread,
          sessionId: session.sessionId,
          pendingId: session.pendingId,
          verified: previous?.verified ?? false,
          restored: true,
          updatedAt: session.updatedAt,
        };
        changed = true;
      }
      return changed ? { statuses } : current;
    }),

  handleEvent: (event, context) => {
    switch (event.type) {
      case "agent.status":
        get().upsert(event.status, context);
        return;
      case "agent.approval": {
        // 已答复的那一份（`answer` 已写、或显式 `resolved`）不是新请求，
        // 而是「这条没了」：直接丢 `pendingId`，不等下一条 `agent.status`。
        if (isResolvedApproval(event.request)) {
          get().resolveApproval(event.pendingId);
          return;
        }
        // Runtime 在 approval 之前已经推过一条 `blocked` 状态；这里只补
        // `pendingId`，不凭空造状态条目（缺 workspaceId / agentId）。
        const previous = get().statuses[event.nodeId];
        if (!previous) return;
        const now = context?.now ?? Date.now();
        set((current) => ({
          statuses: {
            ...current.statuses,
            [event.nodeId]: {
              ...previous,
              state: "blocked",
              pendingId: event.pendingId,
            },
          },
          pendingSince: { ...current.pendingSince, [event.nodeId]: now },
        }));
        return;
      }
      case "terminal.exit": {
        // 进程没了就没有 Agent 状态可言，会话行改由 `alive=false` 表达。
        const nodeId = event.nodeId;
        if (!nodeId || !get().statuses[nodeId]) return;
        set((current) => {
          const statuses = { ...current.statuses };
          const doneAt = { ...current.doneAt };
          const pendingSince = { ...current.pendingSince };
          delete statuses[nodeId];
          delete doneAt[nodeId];
          delete pendingSince[nodeId];
          return { statuses, doneAt, pendingSince };
        });
        return;
      }
      default:
        return;
    }
  },

  reset: () => set({ statuses: {}, doneAt: {}, pendingSince: {} }),
}));

export function useAgentStatus(nodeId: string): AgentStatus | undefined {
  return useAgentStatusStore((state) => state.statuses[nodeId]);
}

/** 侧栏项目头的三个信号徽标（§3.5）。 */
export interface StatusCounts {
  attention: number;
  unread: number;
  working: number;
}

/** 需要你：等待权限或等待回答。 */
export function isAttention(status: {
  state?: AgentStatus["state"];
  pendingId?: string;
}): boolean {
  return (
    status.state === "blocked" ||
    status.state === "waiting" ||
    Boolean(status.pendingId)
  );
}

export function countStatuses(
  statuses: Record<string, AgentStatus>,
  workspaceId?: string | null,
): StatusCounts {
  let attention = 0;
  let unread = 0;
  let working = 0;
  for (const status of Object.values(statuses)) {
    if (workspaceId && status.workspaceId && status.workspaceId !== workspaceId)
      continue;
    if (isAttention(status)) attention += 1;
    else if (status.unread) unread += 1;
    else if (status.state === "working") working += 1;
  }
  return { attention, unread, working };
}

export function useStatusCounts(workspaceId: string | null): StatusCounts {
  return useAgentStatusStore(
    useShallow((state) => countStatuses(state.statuses, workspaceId)),
  );
}

/* ------------------------------ 权限请求形状 ------------------------------ */

/**
 * `agent.approval.request` 是 Runtime 的 `AgentApproval` 记录（`request` 是
 * hook 的原始载荷）。判定「已了结」时同时认两种形状：写了 `answer` 的记录，
 * 以及显式带 `resolved: true` 的通知帧。
 */
export function isResolvedApproval(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const record = request as {
    resolved?: unknown;
    answer?: unknown;
    answeredAt?: unknown;
  };
  if (record.resolved === true) return true;
  return (
    (typeof record.answer === "string" && record.answer.length > 0) ||
    (typeof record.answeredAt === "string" && record.answeredAt.length > 0)
  );
}

/* -------------------------------- 显示映射 -------------------------------- */

/**
 * Runtime **合成**的收尾，而不是某个回合真的跑出了结果。两种来源，
 * 都由 60s 巡检写出，靠 `lastMessage` 的前缀自报家门：
 *
 *  - `stale=true`：20 分钟没有 hook 回报（`reduce::stale_event`）。
 *  - `terminated=true`：终端在回合结束前就没了，CLI 被杀，没机会发 `Stop`。
 *
 * 两者都只是「让节点别再声称 RUNNING」，不是对回合的判决。Runtime 已经
 * 把这一点编码进数据了：合成收尾的 `errored` / `interrupted` 都是 `false`
 * （不冒充 TURN FAILED / PAUSED），并且标了 `silent`，所以它不置未读。
 * 于是显示侧不必再拦一道——胶囊读判决与未读即可，看到什么都是真的。
 *
 * 这个判据只用在**通知**上：状态确实从 working 变成了 done，但没有任何
 * 结果产生，不该弹「已完成」。
 */
const SYNTHETIC_CLOSE_MARKERS = ["stale=true", "terminated=true"] as const;

export function isSyntheticClose(status: AgentStatus): boolean {
  const message = status.lastMessage;
  if (!message) return false;
  return SYNTHETIC_CLOSE_MARKERS.some((marker) => message.startsWith(marker));
}

/**
 * 这条 `done` 是否代表「刚刚跑完的一个回合」。
 * `restored`（Runtime 重启后从 SQLite 读回来的）与合成收尾都不算。
 */
export function isFreshDone(status: AgentStatus): boolean {
  return (
    status.state === "done" && !status.restored && !isSyntheticClose(status)
  );
}

export type AgentGlow = "working" | "attention" | "unread";

/** 胶囊文案的 i18n 键（`i18n/agent.ts`）。 */
export type AgentStateLabelKey =
  | "agent.state.working"
  | "agent.state.waiting"
  | "agent.state.blocked"
  | "agent.state.done"
  | "agent.state.errored"
  | "agent.state.interrupted";

export interface AgentHeaderState {
  pill?: { tone: StatusTone; labelKey: AgentStateLabelKey };
  glow?: AgentGlow;
}

/**
 * Agent 状态 → 状态胶囊 + 光晕（§3.4 / §5.4）。节点头部、子代理卡片共用。
 *
 * | 状态 | 胶囊 | 光晕 |
 * | --- | --- | --- |
 * | `working` | RUNNING（working） | working |
 * | `blocked` / `waiting` | NEEDS YOU（attention） | attention |
 * | `done` + `errored` | TURN FAILED（failed） | 未读时 unread |
 * | `done` + `interrupted` | PAUSED（paused） | 未读时 unread |
 * | `done` + `restored` / stale | 无 | 无 |
 * | `done` + 未读 | DONE（unread） | unread |
 * | 其余（含无状态、已读的 done） | 无 | 无 |
 */
export function agentHeaderState(
  status: AgentStatus | undefined,
): AgentHeaderState {
  if (!status?.state) return {};
  switch (status.state) {
    case "working":
      return {
        pill: { tone: "working", labelKey: "agent.state.working" },
        glow: "working",
      };
    case "blocked":
      return {
        pill: { tone: "attention", labelKey: "agent.state.blocked" },
        glow: "attention",
      };
    case "waiting":
      return {
        pill: { tone: "attention", labelKey: "agent.state.waiting" },
        glow: "attention",
      };
    case "done": {
      const glow: AgentGlow | undefined = status.unread ? "unread" : undefined;
      // 合成收尾不必在这里拦：Runtime 给它的判决是 `false`、且不置未读，
      // 所以它自然落到最后一行的 `{}`。反过来，如果此刻仍有未读，那是**更早
      // 一个回合**留下的、确实还没人看过的输出（Runtime 特意不清它），
      // 该出的 DONE 胶囊照出——终端死了不代表之前那次的结果不用看。
      //
      // `restored` 的行是重启后读回来的旧判决：判决本身仍然成立（上一回合
      // 确实失败/被打断），所以照出胶囊；只是不冒充「刚跑完」的未读结果。
      if (status.errored) {
        return {
          pill: { tone: "failed", labelKey: "agent.state.errored" },
          ...(glow ? { glow } : {}),
        };
      }
      if (status.interrupted) {
        return {
          pill: { tone: "paused", labelKey: "agent.state.interrupted" },
          ...(glow ? { glow } : {}),
        };
      }
      if (!status.unread || status.restored) return {};
      return {
        pill: { tone: "unread", labelKey: "agent.state.done" },
        glow: "unread",
      };
    }
    default:
      return {};
  }
}
