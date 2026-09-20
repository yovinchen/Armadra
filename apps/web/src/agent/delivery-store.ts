/**
 * 投递在界面上的那一点痕迹（设计 `agent-delivery.md` §10）。
 *
 * core 每一次投递、排队与拒绝都发一帧 `agent.delivery`，这个模块把那条流变成
 * 界面要的三件事，一件也不多：
 *
 *  - **连线上最近一次投递**：哪条边、什么结果、什么时候。边上那一下闪动与
 *    悬停提示都从这里取，所以「刚刚发生过一件事」在两台设备上是同一个答案。
 *  - **队列该重读了**：帧里没有队列本身（core 才是那张表的唯一来源），只有
 *    「这个节点的队伍动了」这个事实。徽标据此重取，而不是自己猜 N 加一。
 *  - **顶部该说一句的拒绝**：`LOOP_DETECTED` 之类被拦下的投递。发起者的回执
 *    里有这个码，但那是没有人在看的地方——环里的两个模型各自读到一句「这是
 *    一个环」，画布前面的人什么都看不到。
 *
 * 全是易失的：刷新页面就没了。它描述的是「刚才发生了什么」，不是数据；真正
 * 的记录在 `agent_deliveries` 与队列表里，面板从 core 读。
 */
import * as React from "react";
import { create } from "zustand";
import type { WorkspaceEvent } from "@armadra/shared";

/** 边上那一下闪动持续多久。够看见，不够烦人。 */
export const DELIVERY_FLASH_MS = 2_000;

/**
 * 同一条边、同一个码的通知，被人关掉之后这么久内不再出现。
 *
 * 去重不能只按「出现过」：一个环会在每一次尝试上撞同一个码，而人关掉它就是
 * 说「我知道了」。但也不能永久闭嘴——十分钟后又开始互相喂，那是一件新的事。
 */
export const NOTICE_REPEAT_MS = 5 * 60_000;

/** 只有这几个码值得占用顶部的一行（设计 §10 最后一行）。 */
export const NOTICE_CODES = [
  "LOOP_DETECTED",
  "RATE_LIMITED",
  "TARGET_AWAITING_APPROVAL",
] as const;

export type NoticeCode = (typeof NOTICE_CODES)[number];

export function isNoticeCode(code: string | undefined): code is NoticeCode {
  return (NOTICE_CODES as readonly string[]).includes(code ?? "");
}

/** 一条边最近一次投递。 */
export interface DeliveryMark {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly outcome: string;
  readonly code?: string;
  /** 本机时钟，`Date.now()`。事件里没有时刻，而「多久以前」只在本机有意义。 */
  readonly at: number;
}

export interface DeliveryNotice {
  readonly id: string;
  readonly code: NoticeCode;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly at: number;
  /** 关掉之前撞了几次。连续的 `RATE_LIMITED` 是一条通知，不是三十条。 */
  readonly count: number;
}

/** 边的键。方向有意义：A 投给 B 与 B 投给 A 是两条不同的事。 */
export function edgeKey(sourceNodeId: string, targetNodeId: string): string {
  return `${sourceNodeId}->${targetNodeId}`;
}

interface DeliveryState {
  readonly marks: Readonly<Record<string, DeliveryMark>>;
  /** 节点 id → 这个节点的队伍变过几次。徽标用它触发重读。 */
  readonly queueVersion: Readonly<Record<string, number>>;
  readonly notices: readonly DeliveryNotice[];
  /** 关掉的时刻，按通知 id 记；`NOTICE_REPEAT_MS` 内不再出现。 */
  readonly dismissedAt: Readonly<Record<string, number>>;
  handleEvent: (event: WorkspaceEvent, now?: number) => void;
  dismissNotice: (id: string, now?: number) => void;
  reset: () => void;
}

const EMPTY = {
  marks: {},
  queueVersion: {},
  notices: [],
  dismissedAt: {},
} as const;

export const useDeliveryStore = create<DeliveryState>((set) => ({
  ...EMPTY,
  handleEvent: (event, now = Date.now()) => {
    if (event.type !== "agent.delivery") return;
    set((state) => reduce(state, event, now));
  },
  dismissNotice: (id, now = Date.now()) =>
    set((state) => ({
      notices: state.notices.filter((notice) => notice.id !== id),
      dismissedAt: { ...state.dismissedAt, [id]: now },
    })),
  reset: () => set({ ...EMPTY }),
}));

type Reducible = Pick<
  DeliveryState,
  "marks" | "queueVersion" | "notices" | "dismissedAt"
>;

/**
 * 一帧 → 新状态。导出是为了让用例不必站起一个 store 就能问「第二次撞同一个
 * 码会怎样」。
 */
export function reduce(
  state: Reducible,
  event: Extract<WorkspaceEvent, { type: "agent.delivery" }>,
  now: number,
): Partial<Reducible> {
  const key = edgeKey(event.sourceNodeId, event.targetNodeId);
  const mark: DeliveryMark = {
    sourceNodeId: event.sourceNodeId,
    targetNodeId: event.targetNodeId,
    outcome: event.outcome,
    ...(event.code === undefined ? {} : { code: event.code }),
    at: now,
  };
  const next: {
    -readonly [K in keyof Reducible]?: Reducible[K];
  } = { marks: { ...state.marks, [key]: mark } };

  // 排队与出队都动那个目标的队伍；被拦下的那一条从来没进过队。
  if (event.outcome !== "refused") {
    next.queueVersion = {
      ...state.queueVersion,
      [event.targetNodeId]: (state.queueVersion[event.targetNodeId] ?? 0) + 1,
    };
  }

  if (event.outcome === "refused" && isNoticeCode(event.code)) {
    const id = `${event.code}:${key}`;
    const existing = state.notices.find((notice) => notice.id === id);
    if (existing !== undefined) {
      // 撞第二次只更新计数与时刻：一条通知在顶部跳两遍不是更清楚，是更吵。
      next.notices = state.notices.map((notice) =>
        notice.id === id
          ? { ...notice, at: now, count: notice.count + 1 }
          : notice,
      );
    } else {
      const dismissed = state.dismissedAt[id];
      if (dismissed === undefined || now - dismissed >= NOTICE_REPEAT_MS) {
        next.notices = [
          ...state.notices,
          {
            id,
            code: event.code,
            sourceNodeId: event.sourceNodeId,
            targetNodeId: event.targetNodeId,
            at: now,
            count: 1,
          },
        ];
      }
    }
  }
  return next;
}

/** 这条边此刻要不要闪一下。 */
export function isFlashing(
  mark: DeliveryMark | undefined,
  now: number,
): boolean {
  return mark !== undefined && now - mark.at < DELIVERY_FLASH_MS;
}

/* ---------------------------- 「打开那个队列」 ---------------------------- */

/**
 * 命令面板那条「查看 X 的投递队列」要打开的，正是节点头上已经有的那个浮层。
 *
 * 用一条请求而不是把队列再画一遍：两个入口画两份列表，就会有两份「取消」的
 * 实现，也就会有两种行为。请求是即发即弃的——没有那个节点在屏幕上时什么也不
 * 会发生，这与「跳过去再打开」是同一句话的两半（调用方负责先跳过去）。
 */
type QueueRequest = (nodeId: string) => void;
const queueRequests = new Set<QueueRequest>();

export function requestDeliveryQueue(nodeId: string): void {
  for (const handler of [...queueRequests]) handler(nodeId);
}

export function onDeliveryQueueRequest(handler: QueueRequest): () => void {
  queueRequests.add(handler);
  return () => {
    queueRequests.delete(handler);
  };
}

/** 两个方向里较新的那一次。画布上的一条线是无向的，投递不是。 */
export function latestOn(
  marks: Readonly<Record<string, DeliveryMark>>,
  a: string,
  b: string,
): DeliveryMark | undefined {
  const forward = marks[edgeKey(a, b)];
  const backward = marks[edgeKey(b, a)];
  if (forward === undefined) return backward;
  if (backward === undefined) return forward;
  return forward.at >= backward.at ? forward : backward;
}

/**
 * 这条边最近一次投递，以及它此刻要不要闪。
 *
 * 闪动有一个明确的终点，所以这里挂一个到点的定时器：没有它，边会一直保持
 * 「刚刚发生过」的样子，直到下一次有什么别的东西让它重渲。
 */
export function useDeliveryEdge(
  a: string,
  b: string,
): { mark: DeliveryMark | undefined; flashing: boolean } {
  const mark = useDeliveryStore((state) => latestOn(state.marks, a, b));
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (mark === undefined) return;
    const left = mark.at + DELIVERY_FLASH_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => tick((value) => value + 1), left);
    return () => clearTimeout(timer);
  }, [mark]);
  return { mark, flashing: isFlashing(mark, Date.now()) };
}
