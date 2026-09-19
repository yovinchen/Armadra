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
import { WorkspaceEventStream } from "./stream";

export { WorkspaceEventStream, MAX_QUEUED_FRAMES } from "./stream";
export type { EventSink } from "./stream";

export const EVENTS_PATH = "/api/workspaces/{workspaceId}/events";

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

  context.server.stream(
    EVENTS_PATH,
    (socket, params) => {
      const workspaceId = params.workspaceId ?? "";
      const release = stream.attachSocket(workspaceId, socket);
      // The stream is read-only; a client frame only matters as a close. A
      // `message` handler that answered would be a second protocol nothing on
      // the other side speaks.
      socket.on("close", release);
      socket.on("error", release);
    },
    (params) => {
      // Before the upgrade, exactly as the Rust route does: a workspace that
      // does not exist is an HTTP 404, not a socket that opens and closes.
      const workspaceId = params.workspaceId ?? "";
      if (workspaceExists(context.db.database, workspaceId)) return undefined;
      return { status: 404, reason: "Not Found" };
    },
  );

  assembled = stream;
  return stream;
}
