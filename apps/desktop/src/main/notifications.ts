import { Notification } from "electron";
import { revealWindow, sendToWindow } from "./window";
import { IPC } from "../shared/ipc";
import { retainUntilDismissed } from "../shell-core/notification-retain";

/**
 * System notifications the MAIN process sends.
 *
 * **The page does not use this.** `apps/web/src/platform/index.ts` sends its
 * own notifications through the Web `Notification` API — a renderer in a
 * packaged Electron app has the same access a browser does, and routing them
 * through IPC would only add a shell-specific branch of a thing that already
 * works, plus a second path for "was the window focused?" to disagree on
 * (inventory §2, item 23: delete the shell-only branch). This module exists
 * for the notifications the main process itself will need — the update flow is
 * the one W2.2 owns — which the page cannot send because it may not be running.
 *
 * What it does carry is the click behaviour worth keeping: bring the window
 * back to the front, and hand the page the `nodeId` so it can select the node
 * the notification was about.
 */

export interface ShellNotification {
  readonly title: string;
  readonly body: string;
  /** The canvas node this is about, forwarded to the page on click. */
  readonly nodeId?: string;
}

/** Sends one, or does nothing where the OS has no notification service. */
export function notify(notification: ShellNotification): void {
  if (!Notification.isSupported()) return;
  const shown = new Notification({
    title: notification.title,
    body: notification.body,
  });
  shown.on("click", () => {
    revealWindow();
    if (notification.nodeId !== undefined)
      // The page learns which node to select; the shell has no idea what a
      // node is and must not try to act on one itself.
      sendToWindow(IPC.windowNotificationClick.channel, {
        nodeId: notification.nodeId,
      });
  });
  // Without this the wrapper is collected and the handler above is silently
  // gone (electron/electron#16922). See `shell-core/notification-retain.ts`.
  retainUntilDismissed(shown);
  shown.show();
}
