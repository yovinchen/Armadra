/**
 * The workspace event domain: one WebSocket route, and the fan-out behind it.
 *
 * R1b builds the transport; the domains fill it. Anything that wants to tell a
 * board something emits `workspace.event` on the bus and is done — it never
 * learns whether anybody was listening, which is the same contract
 * `EventHub::publish` had on the Rust side (it returns a receiver count that no
 * caller reads).
 */

import {
  type RequestIdentity,
  accessGate,
  allows,
  onAccessChanged,
  requestIdentity,
} from "../identity/gate";
import { scope } from "../identity/scopes";
import type { CoreContext } from "../main";
import { workspaceExists } from "./workspaces";
import { catchUp } from "./outbox";
import { WorkspaceEventStream } from "./stream";

export {
  WorkspaceEventStream,
  MAX_QUEUED_FRAMES,
  MAX_REPLAY_PASSES,
  cursorFrame,
} from "./stream";
export type { EventSink } from "./stream";
export {
  MAX_CATCH_UP_EVENTS,
  RETAINED_EVENTS,
  appendEvent,
  catchUp,
  outboxReady,
  prune,
  watermark,
} from "./outbox";
export type { CatchUpPage, CursorStatus, OutboxRecord } from "./outbox";

export const EVENTS_PATH = "/api/workspaces/{workspaceId}/events";

/**
 * `?cursor=` 的读法。
 *
 * 只认十进制非负整数，`0` 表示「从这个 core 发过的第一条开始」。空字符串、
 * 负数、小数、别的进制一律是坏请求而不是 0：一个把游标写错的客户端应该在升级
 * 时就知道，而不是安静地收到一整份历史。
 *
 * `now` 是第三个答案，给**还没有位置**的客户端（R7c）：不补发任何历史，只在
 * 订阅一开始报一次当前水位，此后按普通的续订订阅收控制帧。页面第一次连上时
 * 用的就是它——它要的是「从现在起别漏」，不是「把这个 core 发过的一切重放
 * 一遍」，而后者正是 `cursor=0` 的意思。
 */
export function parseCursor(
  raw: string | null,
): number | "now" | "invalid" | null {
  if (raw === null) return null;
  if (raw === "now") return "now";
  if (!/^\d{1,19}$/.test(raw)) return "invalid";
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : "invalid";
}

let assembled: WorkspaceEventStream | undefined;

/**
 * 升级请求 → 它背后的身份。guard 与 open 拿到的是同一个请求对象，而 open 跑在
 * `ws` 完成握手的回调里，异步上下文不保证还在；所以身份在 guard 里按请求记下。
 */
const subscribers = new WeakMap<object, RequestIdentity>();

/** 这个订阅者此刻还能不能看这块画布：先确认会话还在，再问判定入口。 */
function stillAllowed(identity: RequestIdentity, workspaceId: string): boolean {
  const subject =
    identity.revalidate === undefined
      ? identity.subject
      : identity.revalidate();
  if (subject === undefined) return false;
  return accessGate().permits(subject, [scope("events:read", workspaceId)]);
}

/**
 * The stream of the running core, for the domains that need to know whether a
 * workspace is being watched at all — resource sampling is the first of them,
 * and it exists so that a closed panel costs nothing.
 */
export function eventStream(): WorkspaceEventStream | undefined {
  return assembled;
}

export function install(context: CoreContext): WorkspaceEventStream {
  const stream = new WorkspaceEventStream();
  stream.attach(context.bus);
  if (stream.useOutbox(context.db.database)) {
    context.log.info("事件 outbox 已就绪：断线可带 ?cursor= 续订");
  }

  context.server.stream(
    EVENTS_PATH,
    (socket, params, request) => {
      const workspaceId = params.workspaceId ?? "";
      const cursor = parseCursor(request.query.get("cursor"));
      const release = stream.attachSocket(
        workspaceId,
        socket,
        cursor === "now"
          ? { cursor: "now" as const }
          : typeof cursor === "number"
            ? { cursor }
            : {},
      );
      // 订阅者是谁在升级前就定了（guard 里记下的那一份）。授权一变就复核：
      // 撤销共享、移出组、停用账号、撤销设备之后，这条已经升级的 socket 不会
      // 再经过任何请求级的门，只能在这里关掉——关闭码 4403 让页面分得清「被拒」
      // 和「断线」，重连会在升级前拿到 403。
      const identity = subscribers.get(request.raw);
      const stop =
        identity === undefined
          ? () => {}
          : onAccessChanged(() => {
              if (!stillAllowed(identity, workspaceId)) {
                socket.close(4403, "forbidden");
              }
            });
      const end = () => {
        stop();
        release();
      };
      // The stream is read-only; a client frame only matters as a close. A
      // `message` handler that answered would be a second protocol nothing on
      // the other side speaks.
      socket.on("close", end);
      socket.on("error", end);
    },
    (params, request) => {
      // Before the upgrade, exactly as the Rust route does: a workspace that
      // does not exist is an HTTP 404, not a socket that opens and closes.
      const workspaceId = params.workspaceId ?? "";
      if (!workspaceExists(context.db.database, workspaceId)) {
        return { status: 404, reason: "Not Found" };
      }
      // 订阅的 scope 判定（设计 §4.2 / S6）。事件流按工作空间扇出，所以
      // 「谁能收到这块画布的帧」正好是一条 `events:read@workspace`：主体是这次
      // 请求的身份（服务器壳放进来的），本机壳里是 owner。拒绝必须发生在升级
      // **之前**——一个开了又关的 socket 会让页面按 1 秒的下限无限重连。
      if (!allows([scope("events:read", workspaceId)])) {
        return { status: 403, reason: "Forbidden" };
      }
      const identity = requestIdentity();
      if (identity !== undefined && request.raw !== undefined) {
        subscribers.set(request.raw, identity);
      }
      // 游标的三档判定在升级之前，和 合并前的实现 一样：三个状态是三个答案，
      // 不是同一个答案的深浅。拒绝写在状态行上（`409 SNAPSHOT_REQUIRED`），
      // 因为这时候还没有 socket 可以说话；带不带游标由客户端决定，页面不带，
      // 所以页面永远走 404 / 成功这两条老路。
      const cursor = parseCursor(request.query.get("cursor"));
      if (cursor === null) return undefined;
      if (cursor === "invalid")
        return { status: 400, reason: "INVALID_CURSOR" };
      const database = stream.durable;
      if (database === undefined) {
        return { status: 409, reason: "SNAPSHOT_REQUIRED" };
      }
      // `now` 不读历史，所以没有可以掉出保留下限的东西可判。
      if (cursor === "now") return undefined;
      const page = catchUp(database, workspaceId, cursor, 1);
      if (page.status === "snapshotRequired") {
        return { status: 409, reason: "SNAPSHOT_REQUIRED" };
      }
      if (page.status === "cursorAhead") {
        return { status: 409, reason: "CURSOR_AHEAD" };
      }
      return undefined;
    },
  );

  assembled = stream;
  return stream;
}
