import type { WebSocket } from "ws";
import {
  type BackendKind,
  TerminalError,
  type TerminateMode,
  Utf8Decoder,
} from "./backend";
import { DEFAULT_COLS, DEFAULT_ROWS, type TerminalManager } from "./manager";
import { deviceOrLocal, humanActor } from "../drive/lease";

/**
 * `/api/terminals/{id}/ws` — contract §15.5.
 *
 * Connecting is attaching and closing is detaching: the process is never
 * touched by the lifetime of a socket. Several sockets may attach to the same
 * session at once.
 *
 * ## The frames are text JSON, and that is a decision
 *
 * The design (§9, the event-loop row) says terminal bytes should go out as
 * `ws.send(Buffer, { binary: true })`, without JSON and without SQLite. Two of
 * those three hold here verbatim: nothing on this path touches the database,
 * and the payload is assembled into a `Buffer` once and handed to `ws`
 * unchanged.
 *
 * The third cannot hold. `apps/web/src/terminal/transport.ts` — which this
 * batch may not change, and which is the acceptance standard — does
 * `JSON.parse(String(event.data))` on every message and validates the result
 * against `terminalServerMessageSchema`. A binary frame would arrive as a
 * `Blob`, `String()` it to `"[object Blob]"`, fail to parse, and be dropped by
 * rule 4 of that state machine: **silently**. So the frame stays a text frame
 * carrying `{"type":"output","data":"…"}`, exactly as the Rust Runtime sends
 * it, and what this file avoids instead is the *second* copy: the envelope is
 * built with `JSON.stringify` on the decoded string only, and `ws.send` is
 * given the resulting `Buffer` with `{ binary: false }` so it does not
 * re-encode a JavaScript string per frame.
 *
 * If a later batch wants real binary frames it has to change `transport.ts`
 * and the shared schema in the same commit; it is not a change this side can
 * make alone.
 *
 * ## Coalescing
 *
 * One frame per PTY read would be one frame per 8 KiB at best and one per
 * keystroke echo at worst. Output is batched on a 16 ms / 64 KiB budget, the
 * same two numbers the Rust batcher uses (contract §18.3, 输出吞吐), so a
 * full-screen redraw is one frame and an idle prompt still feels immediate.
 */

/** How long a batch may wait, and how large it may get before it is sent. */
export const FLUSH_INTERVAL_MS = 16;
export const FLUSH_BYTES = 64 * 1024;

export interface HelloFrame {
  readonly type: "hello";
  readonly sessionId: string;
  readonly generation: number;
  readonly backend: BackendKind;
  readonly rows: number;
  readonly cols: number;
  readonly alive: boolean;
  readonly acknowledgedInput?: number;
}

export type ServerFrame =
  | HelloFrame
  | { readonly type: "snapshot"; readonly data: string }
  | { readonly type: "output"; readonly data: string }
  | {
      readonly type: "status";
      readonly status: string;
      readonly exitCode: number | null;
    }
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "ack"; readonly inputId: number }
  | { readonly type: "stale"; readonly generation: number };

export type ClientFrame =
  | { readonly type: "input"; readonly data: string; readonly inputId?: number }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "terminate"; readonly mode?: TerminateMode };

/** One frame, ready for the wire. */
export function encodeFrame(frame: ServerFrame): Buffer {
  return Buffer.from(JSON.stringify(frame), "utf8");
}

/**
 * Anything that does not parse is dropped, not answered.
 *
 * A malformed frame is a bug in a client, and the one thing a terminal socket
 * must not do is close over one: the pane is showing a running process, and
 * dropping the connection would look to the user like the process died.
 */
export function decodeFrame(text: string): ClientFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const frame = parsed as Record<string, unknown>;
  if (frame.type === "input" && typeof frame.data === "string") {
    const inputId = frame.inputId;
    return {
      type: "input",
      data: frame.data,
      ...(typeof inputId === "number" && Number.isFinite(inputId)
        ? { inputId }
        : {}),
    };
  }
  if (
    frame.type === "resize" &&
    typeof frame.cols === "number" &&
    typeof frame.rows === "number"
  ) {
    return { type: "resize", cols: frame.cols, rows: frame.rows };
  }
  if (frame.type === "terminate") {
    const mode = frame.mode;
    return {
      type: "terminate",
      ...(mode === "interrupt" || mode === "process" || mode === "session"
        ? { mode }
        : {}),
    };
  }
  return undefined;
}

/**
 * `?writer=` names the client's own input stream so a reconnect can be told
 * what it already applied. It is a label, not a credential: the socket is
 * already authorised, and the only thing this id decides is whether *this*
 * client resends *its own* unacknowledged keystrokes.
 */
export function validWriter(value: string | null): string | undefined {
  if (value === null || value === "") return "";
  if (value.length > 64) return undefined;
  // ASCII graphic only: the id is echoed into log lines.
  return /^[\x21-\x7e]+$/.test(value) ? value : undefined;
}

export interface SocketOptions {
  readonly manager: TerminalManager;
  readonly sessionId: string;
  readonly writer: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Drives one socket for its whole life. Resolves when the socket is closed and
 * the attachment has been released.
 */
export async function serveTerminalSocket(
  connection: WebSocket,
  options: SocketOptions,
): Promise<void> {
  const { manager, sessionId, writer } = options;
  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  const send = (frame: ServerFrame): void => {
    try {
      connection.send(encodeFrame(frame), { binary: false });
    } catch (error) {
      options.onError?.(error);
    }
  };

  // 挂上 `close` 要早于 attach：attach 要等后端（tmux 起一个客户端），页面在
  // 这期间关掉的话，`close` 发在我们监听之前，从此没人 `detached`，core 一直
  // 以为有人看着这个会话（节能休眠永远被 `attached` 挡住）。
  let closedWhileAttaching = false;
  connection.on("close", () => {
    closedWhileAttaching = true;
  });

  let attached;
  try {
    attached = await manager.attach(sessionId, { cols, rows });
  } catch (error) {
    // Nothing live behind the row: the socket still gets a `hello` and the
    // final `status`, so the page can show the exit instead of a blank pane.
    //
    // Reported before it is answered. `alive: false` is a legitimate reply for
    // a session that really has ended, which is exactly why a *failure* to
    // attach must not arrive at the operator wearing the same clothes: without
    // this line the only symptom of a broken backend is a terminal that opens
    // grey, and nothing anywhere says why.
    options.onError?.(error);
    const row = manager.session(sessionId);
    send({
      type: "hello",
      sessionId,
      generation: row.generation,
      backend: (row.backend as BackendKind) ?? "tmux",
      rows,
      cols,
      alive: false,
    });
    send({ type: "status", status: row.status, exitCode: row.exitCode });
    connection.close();
    void error;
    return;
  }

  const { attachment, record, snapshot } = attached;
  if (closedWhileAttaching) {
    try {
      await manager.detached(sessionId, attachment.attachmentId);
    } catch (error) {
      options.onError?.(error);
    }
    return;
  }
  const generation = attachment.generation;
  send({
    type: "hello",
    sessionId,
    generation,
    backend: record.kind,
    rows,
    cols,
    alive: true,
    // A reconnecting client is told what its own writer already reached, so it
    // resends only what never landed instead of replaying keystrokes. The
    // ledger outlives the connection, which is the whole point: the socket
    // that sent those keystrokes is the one that is gone.
    ...(writer === ""
      ? {}
      : { acknowledgedInput: manager.acknowledgedInput(sessionId, writer) }),
  });
  // A tmux client redraws the real screen and the session host replays down
  // its own attach connection, so neither is owed a `snapshot`. The direct
  // backend, which has no screen to re-read, is the one that sends one.
  if (snapshot !== undefined && snapshot !== "") {
    send({ type: "snapshot", data: snapshot });
  }

  /* ------------------------------- output ------------------------------- */

  const decoder = new Utf8Decoder("utf8");
  let pending = "";
  let pendingBytes = 0;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending === "" || closed) return;
    send({ type: "output", data: pending });
    pending = "";
    pendingBytes = 0;
    // `last_output_at` is a row update, not a row per frame — and the
    // throttling lives in the manager rather than here, because a session with
    // two sockets open would otherwise write twice as often as one with one.
    try {
      manager.noteOutput(sessionId);
    } catch (error) {
      options.onError?.(error);
    }
  };

  attachment.onData((chunk) => {
    // Decoded across chunk boundaries: a PTY read can end mid-character, and
    // decoding each chunk alone would put a permanent U+FFFD on the screen.
    const text = decoder.write(chunk);
    if (text === "") return;
    pending += text;
    pendingBytes += chunk.byteLength;
    if (pendingBytes >= FLUSH_BYTES) {
      flush();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
  });

  const done = new Promise<void>((resolve) => {
    attachment.onExit((exitCode) => {
      // The last words before the exit status: flush, then report.
      flush();
      // The stream ended — but *why* decides what this socket is owed, and
      // getting it wrong is visible twice over.
      //
      // A recycle destroys the old session, which ends exactly this stream
      // while the row is already running again at the next generation. Sending
      // `status: exited` there would tell the page its terminal died, and
      // `markExited` would bury the row of the session that just replaced it.
      // So a generation that has moved is a `stale`, not an exit.
      if (announceStale(connection, manager, sessionId, generation, send)) {
        return;
      }
      try {
        manager.markExited(sessionId, exitCode ?? null);
      } catch (error) {
        options.onError?.(error);
      }
      send({ type: "status", status: "exited", exitCode: exitCode ?? null });
      connection.close();
    });

    connection.on("message", (data) => {
      void (async () => {
        const frame = decodeFrame(
          Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
        );
        if (frame === undefined) return;
        try {
          if (frame.type === "input") {
            // 键盘上来的字节就是「人在驱动」（设计 `agent-delivery.md`
            // §6.1）：它抢占 Agent 的租约，而 Agent 的下一次投递会被告知
            // `LEASE_HELD_BY_HUMAN`。人停手十秒，租约自己过期。
            await manager.input(
              sessionId,
              generation,
              frame.data,
              undefined,
              humanActor(deviceOrLocal(writer), ""),
            );
            // The mark moves only after the bytes reached the pty: an
            // acknowledged input is one this session will never accept again
            // from the same writer.
            if (frame.inputId !== undefined && frame.inputId > 0) {
              manager.noteInputApplied(sessionId, writer, frame.inputId);
              send({ type: "ack", inputId: frame.inputId });
            }
            return;
          }
          if (frame.type === "resize") {
            await manager.resize(sessionId, generation, {
              cols: frame.cols,
              rows: frame.rows,
            });
            return;
          }
          await manager.terminate(sessionId, frame.mode ?? "process");
        } catch (error) {
          // A write against an old generation is not a protocol error: the
          // client is simply behind a recycle, and is told so instead of
          // having its socket dropped.
          if (announceStale(connection, manager, sessionId, generation, send)) {
            return;
          }
          if (error instanceof TerminalError && error.status < 500) {
            send({ type: "warning", message: error.message });
            return;
          }
          options.onError?.(error);
          send({
            type: "warning",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });

    connection.on("close", () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      void manager
        .detached(sessionId, attachment.attachmentId)
        .catch((error: unknown) => options.onError?.(error))
        .then(() => resolve());
    });
  });

  await done;
}

/**
 * Sends `stale` when the session has moved on to a newer generation (contract
 * §15.5). Returns whether this socket is now obsolete.
 */
function announceStale(
  connection: WebSocket,
  manager: TerminalManager,
  sessionId: string,
  generation: number,
  send: (frame: ServerFrame) => void,
): boolean {
  const current = manager.generation(sessionId);
  if (current === undefined || current === generation) return false;
  send({ type: "stale", generation: current });
  connection.close();
  return true;
}
