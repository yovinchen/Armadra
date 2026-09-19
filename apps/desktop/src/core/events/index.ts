/**
 * The workspace event domain: one WebSocket route, and the fan-out behind it.
 *
 * R1b builds the transport; the domains fill it. Anything that wants to tell a
 * board something emits `workspace.event` on the bus and is done — it never
 * learns whether anybody was listening, which is the same contract
 * `EventHub::publish` had on the Rust side (it returns a receiver count that no
 * caller reads).
 */

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
 */
export function parseCursor(raw: string | null): number | "invalid" | null {
  if (raw === null) return null;
  if (!/^\d{1,19}$/.test(raw)) return "invalid";
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : "invalid";
}

let assembled: WorkspaceEventStream | undefined;

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
        typeof cursor === "number" ? { cursor } : {},
      );
      // The stream is read-only; a client frame only matters as a close. A
      // `message` handler that answered would be a second protocol nothing on
      // the other side speaks.
      socket.on("close", release);
      socket.on("error", release);
    },
    (params, request) => {
      // Before the upgrade, exactly as the Rust route does: a workspace that
      // does not exist is an HTTP 404, not a socket that opens and closes.
      const workspaceId = params.workspaceId ?? "";
      if (!workspaceExists(context.db.database, workspaceId)) {
        return { status: 404, reason: "Not Found" };
      }
      // 游标的三档判定在升级之前，和 `catchup.go` 一样：三个状态是三个答案，
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
