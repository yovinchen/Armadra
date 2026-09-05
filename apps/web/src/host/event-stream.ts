import {
  HostEventStreamClient,
  type HostEventStreamStatus,
} from "@armadra/host-client";
import { toWorkspaceEvents } from "@armadra/shared";

import { dispatchWorkspaceEvent } from "../api/events";
import {
  resetCanvasEventCursor,
  resolveCanvasHostClient,
} from "../canvas-ownership/gateway";
import { loadHostAddress } from "./connection";

/**
 * Host 事件流的前端接线（H01 §2.3）。
 *
 * Host 持有画布时，「别处改了什么」由 Host 推过来，不再每隔几秒问一次。这里
 * 只做三件事：把流收到的信封投影成界面已经在订阅的 `WorkspaceEvent`、把游标
 * 推到这一页的末尾、告诉调用方现在的来源是流还是轮询。
 *
 * **不改画布内容**。和轮询那条路一样，它只回答「有没有别处的改动」，重读由
 * 调用方决定——本地没落盘的编辑不该被一页事件覆盖掉。
 *
 * 来源必须是明确的一档，不能含糊成「大概连上了」：轮询是流不可用时的后备，
 * 界面要能说出现在靠哪一条在跟随。
 */

/** 当前跟随的来源。每一档都是真状态。 */
export type CanvasEventSource =
  /** 流连通，正在推送；这时不轮询。 */
  | "stream"
  /** 流没连上或正在重连，退回轮询。 */
  | "polling"
  /** 已停止跟随：游标超出水位，继续问只会一直得到同一个答案。 */
  | "stopped";

export interface CanvasEventStreamHandlers {
  /** 别处改过画布，调用方应当重读。 */
  onChanged: () => void;
  /** 游标超出这台 Host 的水位：停止跟随，不回退。 */
  onDiverged: () => void;
  /** 来源变了。界面据此显示「实时」还是「轮询」。 */
  onSource: (source: CanvasEventSource) => void;
}

export interface CanvasEventStreamHandle {
  stop: () => void;
  /** 仅供测试与诊断：流自己的状态。 */
  status: () => HostEventStreamStatus;
}

/** 测试注入 WebSocket 构造；传 `null` 恢复真实实现。 */
type SocketFactory = NonNullable<
  ConstructorParameters<typeof HostEventStreamClient>[0]["socket"]
>;
let socketFactory: SocketFactory | null = null;
export function setCanvasEventSocketFactory(
  factory: SocketFactory | null,
): void {
  socketFactory = factory;
}

/**
 * 从 `afterSequence` 起接上 Host 的事件流。
 *
 * 返回 `null` 表示这台 Host 的地址根本开不出流（比如还没配 HTTPS）——那是
 * 一个确定的答案，调用方据此留在轮询上，而不是拿着一个永远不会连上的句柄。
 */
export function connectCanvasEventStream(
  workspaceId: string,
  afterSequence: bigint,
  handlers: CanvasEventStreamHandlers,
): CanvasEventStreamHandle | null {
  let stopped = false;
  let client: HostEventStreamClient;
  try {
    client = new HostEventStreamClient({
      baseUrl: loadHostAddress(),
      workspaceIds: [workspaceId],
      afterSequence,
      ...(socketFactory ? { socket: socketFactory } : {}),
      onEvents: (envelopes, page) => {
        const projection = toWorkspaceEvents(envelopes);
        for (const event of projection.events) dispatchWorkspaceEvent(event);
        // 游标先推到这一页的末尾：轮询后备接手时要从同一个位置续，
        // 不然它会把刚经流看过的那一段再当成新改动扫一遍。
        resetCanvasEventCursor(workspaceId, page.nextCursor);
        if (projection.events.length > 0 || projection.reloadRequired)
          handlers.onChanged();
      },
      onStatus: (status) => {
        if (stopped) return;
        switch (status) {
          case "streaming":
            handlers.onSource("stream");
            return;
          case "snapshotRequired":
            // 游标掉到保留下限以下。只取那个一致的序号，内容由调用方按
            // 正常读取路径重取——同一份文档不该被两条路各解一遍。
            handlers.onSource("polling");
            void reseed(workspaceId, client, handlers, () => stopped);
            return;
          case "diverged":
            handlers.onSource("stopped");
            handlers.onDiverged();
            return;
          default:
            // idle / reconnecting / denied：流不在推，后备接手。
            handlers.onSource("polling");
        }
      },
    });
  } catch {
    return null;
  }
  client.start();
  return {
    stop: () => {
      stopped = true;
      client.stop();
    },
    status: () => client.status,
  };
}

/**
 * 快照重置游标后再续上。快照自带它一致的那个序号，从那里续只会重放快照
 * 已经包含的改动，不会跳过任何一条。
 */
async function reseed(
  workspaceId: string,
  client: HostEventStreamClient,
  handlers: CanvasEventStreamHandlers,
  cancelled: () => boolean,
): Promise<void> {
  try {
    const canvas = await resolveCanvasHostClient(workspaceId, false);
    const snapshot = await canvas.getSnapshot("", 1);
    if (cancelled()) return;
    resetCanvasEventCursor(workspaceId, snapshot.sequence);
    client.resumeFromSnapshot(snapshot.sequence);
    handlers.onChanged();
  } catch {
    // 取不到快照就留在轮询上：轮询自己也会遇到同一个 `snapshotRequired`
    // 并再试一次，这里再排一轮重试只会把同一个失败叠起来。
  }
}
