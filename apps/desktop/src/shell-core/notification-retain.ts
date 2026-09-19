/**
 * Keeping a shown `Notification` alive long enough for its click to work.
 *
 * Electron garbage-collects `Notification` objects nothing references
 * (electron/electron#16922): the notification still shows, but once the
 * wrapper is collected its `click` handler is gone — clicking then only
 * activates the app (the macOS default) instead of running the shell's own
 * focus logic.
 *
 * So every shown notification is retained here until the OS reports it
 * dismissed. The structural `NotificationLike` keeps the rule Electron-free
 * and therefore testable.
 */

export interface NotificationLike {
  on(event: "click" | "close" | "failed", listener: () => void): void;
}

/**
 * Backstop for notifications macOS parks in Notification Center without ever
 * emitting `close`. Beyond this, the OLDEST retained one is dropped: its click
 * stops working, which is only the pre-fix behaviour, while anything recent —
 * the ones a user is plausibly about to click — keeps its handler alive.
 */
export const MAX_RETAINED = 50;

const live = new Set<NotificationLike>();

export function retainUntilDismissed(notification: NotificationLike): void {
  live.add(notification);
  const release = () => live.delete(notification);
  notification.on("click", release);
  notification.on("close", release);
  notification.on("failed", release);
  while (live.size > MAX_RETAINED) {
    const oldest = live.values().next().value;
    if (!oldest) break;
    live.delete(oldest);
  }
}

export function retainedCount(): number {
  return live.size;
}

export function clearRetained(): void {
  live.clear();
}
