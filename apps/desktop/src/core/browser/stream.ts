import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";

import { loadNode } from "../collab/nodes";
import { workspaceExists } from "../events/workspaces";
import type { StreamRefusal } from "../http/server";
import { DRIVE_CODES } from "./cdp/codes";
import type { HeadlessBackend } from "./headless";

/**
 * `GET /api/workspaces/{workspaceId}/browser/{nodeId}/stream` — what a remote
 * browser node looks like.
 *
 * The desktop shell has no route like this and never will: there the page is a
 * `<webview>` in the window the person is already looking at, and a stream
 * would be a second copy of a page they can see. This exists because a server
 * shell has no window at all.
 *
 * The frames are binary JPEG messages, each preceded by one JSON text message
 * saying what it is (sequence, size, the viewport it was rendered at). Two
 * messages rather than a header inside the binary because the decoder on the
 * other end is `createImageBitmap`, which wants the bytes and nothing else.
 *
 * **One viewer.** A second upgrade is refused with 409 before any socket
 * exists. The reasons are with {@link HeadlessNode}: two people typing into
 * one page with one lease cannot tell whose keystroke did what, and a fan-out
 * multiplies the encoder, which is the expensive part.
 */

export const BROWSER_STREAM_PATH =
  "/api/workspaces/{workspaceId}/browser/{nodeId}/stream";

export interface StreamDeps {
  readonly database: DatabaseSync;
  /** `undefined` when this core's backend is the desktop shell's. */
  readonly backend: HeadlessBackend | undefined;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Before the upgrade, as the rest of the core's streams do: a node that is not
 * there is an HTTP answer, not a socket that opens and closes.
 */
export function streamGuard(
  deps: StreamDeps,
  params: Readonly<Record<string, string>>,
): StreamRefusal | undefined {
  const workspaceId = params.workspaceId ?? "";
  const nodeId = params.nodeId ?? "";
  if (!workspaceExists(deps.database, workspaceId)) {
    return { status: 404, reason: "Not Found" };
  }
  const node = loadNode(deps.database, nodeId);
  // A node in another workspace, a node that is not a browser and a node that
  // does not exist get the SAME answer. A refusal that told them apart would
  // make this route a probe for what is on somebody else's canvas.
  if (
    node === undefined ||
    node.workspaceId !== workspaceId ||
    node.nodeType !== "browser"
  ) {
    return { status: 404, reason: "Not Found" };
  }
  if (deps.backend === undefined) {
    return { status: 501, reason: "Not Implemented" };
  }
  if (deps.backend.hasViewer(nodeId)) {
    return { status: 409, reason: "VIEWER_PRESENT" };
  }
  return undefined;
}

/**
 * Attaches the one viewer.
 *
 * Starting the browser is part of attaching: on a server shell nobody has
 * looked at this node since the core started, so the first person to open it
 * is also the reason there is a browser at all.
 */
export function attachStream(
  deps: StreamDeps,
  socket: WebSocket,
  params: Readonly<Record<string, string>>,
): void {
  const nodeId = params.nodeId ?? "";
  const backend = deps.backend;
  if (backend === undefined) {
    closeWith(socket, DRIVE_CODES.unavailable, "no headless browser backend");
    return;
  }
  const node = loadNode(deps.database, nodeId);
  const url = typeof node?.data.url === "string" ? node.data.url : "";

  let attached: { detach: () => void } | undefined;
  let closed = false;
  socket.on("close", () => {
    closed = true;
    attached?.detach();
  });
  socket.on("error", () => {
    closed = true;
    attached?.detach();
  });

  void backend
    .ensure(nodeId, url)
    .then((running) => {
      if (closed) return;
      if (running.hasViewer()) {
        // Lost a race with another tab between the guard and here. The same
        // answer, said on the socket because the upgrade already happened.
        closeWith(
          socket,
          "browser_viewer_present",
          "somebody else is watching this node",
        );
        return;
      }
      const viewer = {
        send: (data: string | Buffer) => socket.send(data),
        close: (code?: number, reason?: string) => socket.close(code, reason),
      };
      running.attachViewer(viewer);
      attached = { detach: () => running.detachViewer(viewer) };
      socket.on("message", (data: unknown, isBinary?: boolean) => {
        // Text only. A viewer has nothing binary to say, and a binary frame
        // here is something that is not the front end.
        if (isBinary === true) return;
        running.onViewerMessage(String(data));
      });
    })
    .catch((error: unknown) => {
      if (closed) return;
      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : DRIVE_CODES.unavailable;
      closeWith(
        socket,
        code,
        error instanceof Error ? error.message : "no browser",
      );
    });
}

/**
 * Says why, then goes.
 *
 * The reason travels as a message rather than only as a close code: the front
 * end draws an empty state from the CODE, and a close code has four digits and
 * no room for one.
 */
function closeWith(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: "error", code, message }));
  } catch {
    // The socket went first. Nothing to say and nobody to say it to.
  }
  socket.close(1011, code);
}
