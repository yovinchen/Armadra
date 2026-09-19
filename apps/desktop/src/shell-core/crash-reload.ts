/**
 * What to do when the renderer process dies.
 *
 * A reload is the right first answer: the canvas is recoverable from the
 * Runtime, and a blank window is worse than a reloaded one. A reload LOOP is
 * not — a page that crashes on load would otherwise spin forever, burning CPU
 * and rewriting the same crash report, with no window ever staying up long
 * enough for the user to read an error.
 *
 * So: at most `MAX_RELOADS` reloads inside `WINDOW_MS`, and a `clean-exit`
 * never counts (that reason is the renderer going away on purpose — a quit, a
 * window close — not a crash).
 */

/** How many automatic reloads are allowed inside the window below. */
export const MAX_RELOADS = 2;
/** The sliding window, in milliseconds. */
export const WINDOW_MS = 60_000;

export interface CrashReloadPolicy {
  /**
   * Whether to reload for a `render-process-gone` with this reason, at this
   * moment. Calling it RECORDS the crash, so a caller must ask exactly once
   * per event.
   */
  shouldReload(reason: string, now: number): boolean;
}

/**
 * A fresh policy with its own history. Time is a parameter rather than a read
 * of the clock so the window can be tested without waiting a minute.
 */
export function createCrashReloadPolicy(): CrashReloadPolicy {
  const crashes: number[] = [];
  return {
    shouldReload(reason, now) {
      // A clean exit is not a crash, and must not consume the budget: quitting
      // the app would otherwise leave the next session one reload poorer.
      if (reason === "clean-exit") return false;
      while (crashes.length > 0 && now - crashes[0]! > WINDOW_MS)
        crashes.shift();
      crashes.push(now);
      return crashes.length <= MAX_RELOADS;
    },
  };
}
