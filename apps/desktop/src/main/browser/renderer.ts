import { IPC } from "../../shared/ipc";
import { getMainWindow } from "../window";

/**
 * Main -> renderer, for the two things only the renderer can do.
 *
 * Tabs are React state: a tab is a `<webview>` element the page mounts, so
 * "switch to tab three" is not something the main process can perform — it can
 * only ask. The same is true of the lease badge, which is a component.
 *
 * The channel is `browser:drive`, the same name the Runtime's side carries,
 * because it is the same conversation seen from the other end: a verb arrived,
 * and this is the part of it that has to happen in the page.
 */

export interface RendererCommand {
  readonly kind: "tabs" | "lease" | "popup" | "key" | "download";
  readonly nodeId: string;
  readonly [field: string]: unknown;
}

/**
 * Sends one command and waits for the page to have had a chance to apply it.
 *
 * There is no acknowledgement, and the wait is a settle rather than a
 * handshake. Adding a reply channel would mean a renderer that can stall a
 * verb by not answering; a tab switch that did not take is visible in the
 * re-measured tab list the verb returns anyway, which is the answer that
 * matters.
 */
export async function askRenderer(command: RendererCommand): Promise<void> {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.browserDrive.channel, command);
  await new Promise((done) => setTimeout(done, 200));
}

/** Fire and forget: state the page displays, never something a verb waits on. */
export function tellRenderer(command: RendererCommand): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.browserDrive.channel, command);
}
