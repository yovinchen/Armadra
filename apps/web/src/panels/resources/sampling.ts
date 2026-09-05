/**
 * 一个工作空间只有一份采样订阅，所有看客共用（T02，路线图 §4.3）。
 *
 * 以前只有资源面板一个消费者，订阅逻辑就写在它的 hook 里。现在每个终端节点
 * 头部还有一个内存徽标，如果各自去订阅，一屏十个终端就是十份订阅、十条
 * 续约、十份一模一样的样本。所以订阅收在这里：
 *
 * - **谁都不看就不采样。** 最后一个看客走掉就退订，Runtime 的采样循环在最后
 *   一份订阅过期后自己停下（设计 §8）。
 * - **节奏取最快的那个。** 每个看客声明自己要 `fast`（用设置里的间隔）还是
 *   `slow`（30 秒，离屏节点用）。订阅按其中最快的那档发出去，Runtime 那边也
 *   按所有订阅里最快的一档采样——所以一个可见的徽标就够把大家拉回正常节奏，
 *   一整屏离屏徽标则是 30 秒一次。
 * - **样本只有一份。** 推送来的快照广播给所有看客，不复制、不各自解析。
 *
 * 首屏走一次 `GET`：那条请求会让 Runtime 先垫一次 CPU 基线再采，拿到的是真实
 * 数字，而不是「第一次刷新恒为 0」。
 */
import type { ResourceSnapshot } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";

/** 离屏节点的采样节奏（路线图 §4.3「节点 offscreen 时降到 30 秒」）。 */
export const SLOW_INTERVAL_MS = 30_000;

/** 续约失败重试的上限间隔；Runtime 不在时不要每秒敲门。 */
const MAX_RETRY_MS = 15_000;

/**
 * 一个看客要多快的样本。`fast` 不带间隔，用 Runtime 设置里的那档；`slow` 明确
 * 要 30 秒。之所以不让调用方直接传毫秒：节奏是产品决定，不该由每个组件各写
 * 一个数字。
 */
export type Cadence = "fast" | "slow";

export interface SamplingState {
  snapshot: ResourceSnapshot | null;
  error: string | null;
  /** 首屏还没到。已经有过样本之后即使正在重取也不再是 loading。 */
  loading: boolean;
}

type Listener = (state: SamplingState) => void;

interface Room {
  /** 首屏 `GET` 的取消句柄；房间关掉时把它一起撤掉。 */
  controller: AbortController;
  /** 看客 → 它要的节奏。用 token 做键，同一个组件重挂不会互相顶掉。 */
  members: Map<object, Cadence>;
  listeners: Map<object, Listener>;
  state: SamplingState;
  subscriptionId: string | null;
  /** 当前订阅是按哪档发出去的；节奏变了才需要重新发一次。 */
  cadence: Cadence | null;
  renewAt: ReturnType<typeof setTimeout> | null;
  stopEvents: (() => void) | null;
  /** 已经离开的房间不再写状态，避免迟到的请求复活它。 */
  closed: boolean;
}

const rooms = new Map<string, Room>();

function emit(room: Room): void {
  for (const listener of room.listeners.values()) listener(room.state);
}

function patch(room: Room, next: Partial<SamplingState>): void {
  if (room.closed) return;
  room.state = { ...room.state, ...next };
  emit(room);
}

/** 房间里最快的那档，也就是订阅该用的节奏。 */
function fastest(room: Room): Cadence {
  for (const cadence of room.members.values()) {
    if (cadence === "fast") return "fast";
  }
  return "slow";
}

function close(workspaceId: string, room: Room): void {
  room.closed = true;
  rooms.delete(workspaceId);
  room.controller.abort();
  room.stopEvents?.();
  if (room.renewAt) clearTimeout(room.renewAt);
  const held = room.subscriptionId;
  room.subscriptionId = null;
  if (held) {
    void runtimeApi.unsubscribeResources(workspaceId, held).catch(() => {});
  }
}

/**
 * 订阅 / 续约一次，并安排下一次续约。
 *
 * 续约按**自己这份订阅**的间隔来：离屏徽标 30 秒续一次，就算此刻面板开着、
 * 样本每 2 秒到一次，也不需要它跟着每 2 秒发一个请求。
 */
async function renew(workspaceId: string, room: Room): Promise<void> {
  if (room.closed) return;
  const cadence = fastest(room);
  // 先记下来再发请求：请求还在飞的时候又加进来一个同档的看客，不该因为
  // `cadence` 还是 null 就再发一份一模一样的订阅。
  room.cadence = cadence;
  try {
    const subscription = await runtimeApi.subscribeResources(
      workspaceId,
      room.subscriptionId ?? undefined,
      cadence === "slow" ? SLOW_INTERVAL_MS : undefined,
    );
    if (room.closed) {
      // 组件已经卸载：把刚拿到的订阅还回去，别留一份没人要的采样。
      void runtimeApi
        .unsubscribeResources(workspaceId, subscription.subscriptionId)
        .catch(() => {});
      return;
    }
    room.subscriptionId = subscription.subscriptionId;
    patch(room, { error: null });
    room.renewAt = setTimeout(
      () => void renew(workspaceId, room),
      subscription.intervalMs,
    );
  } catch (cause) {
    patch(room, {
      error: cause instanceof Error ? cause.message : String(cause),
      loading: false,
    });
    if (!room.closed) {
      room.renewAt = setTimeout(
        () => void renew(workspaceId, room),
        MAX_RETRY_MS,
      );
    }
  }
}

/** 节奏变了就立刻重发一次订阅，而不是等下一次续约。 */
function reconcile(workspaceId: string, room: Room): void {
  if (room.closed || room.cadence === fastest(room)) return;
  if (room.renewAt) clearTimeout(room.renewAt);
  void renew(workspaceId, room);
}

function open(workspaceId: string): Room {
  const room: Room = {
    members: new Map(),
    listeners: new Map(),
    state: { snapshot: null, error: null, loading: true },
    subscriptionId: null,
    cadence: null,
    renewAt: null,
    stopEvents: null,
    controller: new AbortController(),
    closed: false,
  };
  rooms.set(workspaceId, room);

  room.stopEvents = onWorkspaceEvent("resource.sample", (event) => {
    if (event.snapshot.workspaceId !== workspaceId) return;
    patch(room, { snapshot: event.snapshot, loading: false, error: null });
  });

  // 首屏。失败不影响订阅：推送照样可能到。
  void runtimeApi
    .resources(workspaceId, room.controller.signal)
    .then((first) => {
      if (room.state.snapshot) return;
      patch(room, { snapshot: first, loading: false, error: null });
    })
    .catch((cause: unknown) => {
      patch(room, {
        error: cause instanceof Error ? cause.message : String(cause),
        loading: false,
      });
    });

  // 订阅不在这里发：`fastest` 要看房间里的看客，而第一个看客是
  // `joinSampling` 登记的。在它登记之前发出去的订阅会是「没人要」的那档。
  return room;
}

export interface SamplingHandle {
  /** 当前状态，供刚加入的看客立刻画一帧。 */
  current: () => SamplingState;
  /** 改自己要的节奏；变快会立刻重发订阅。 */
  setCadence: (cadence: Cadence) => void;
  /** 重新取一次首屏；已有的样本保留，不会闪回 loading。 */
  refresh: () => void;
  leave: () => void;
}

/**
 * 加入一个工作空间的采样。返回的句柄必须 `leave()`——最后一个看客走掉时，
 * 订阅才会被退掉。
 */
export function joinSampling(
  workspaceId: string,
  cadence: Cadence,
  listener: Listener,
): SamplingHandle {
  const token = {};
  let room = rooms.get(workspaceId);
  const fresh = !room;
  if (!room) room = open(workspaceId);
  const joined = room;
  joined.members.set(token, cadence);
  joined.listeners.set(token, listener);
  if (fresh) void renew(workspaceId, joined);
  else reconcile(workspaceId, joined);

  return {
    current: () => joined.state,
    setCadence: (next) => {
      if (joined.closed || joined.members.get(token) === next) return;
      joined.members.set(token, next);
      reconcile(workspaceId, joined);
    },
    refresh: () => {
      if (joined.closed) return;
      void runtimeApi
        .resources(workspaceId)
        .then((snapshot) =>
          patch(joined, { snapshot, error: null, loading: false }),
        )
        .catch((cause: unknown) =>
          patch(joined, {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
    },
    leave: () => {
      joined.members.delete(token);
      joined.listeners.delete(token);
      if (joined.members.size === 0) {
        close(workspaceId, joined);
        return;
      }
      // 走掉的可能正是那个要快节奏的：剩下的都离屏了就该慢下来，而不是让
      // 一份快订阅一直续到过期。
      reconcile(workspaceId, joined);
    },
  };
}

/** 测试用：把所有房间关掉，免得一个用例的订阅漏进下一个。 */
export function resetSampling(): void {
  for (const [workspaceId, room] of [...rooms]) close(workspaceId, room);
}
