/**
 * The authoritative navigation gate for guests, and the popup rule.
 *
 * The renderer has a gate of its own (`apps/web/src/nodes/browser/webview.ts`),
 * and it is not this one. A renderer-side `will-navigate` listener sees only
 * what the guest tells the embedder; this one runs in the main process on the
 * guest's own `webContents`, which is where a navigation is actually decided.
 * The page-side gate is a courtesy, this one is the rule.
 *
 * `file://` is refused outright, including when the current document is a
 * local file. Armadra has no local media nodes requiring an exception, and a remote page that
 * can point a guest at a local file can read anything this user can read.
 */

/** Schemes a guest may ever be on. */
export function allowGuestNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

/**
 * What to do with a window the page tried to open.
 *
 * `setWindowOpenHandler` always returns deny — a guest never gets a real
 * `BrowserWindow`, because a window outside the canvas is a window outside
 * every rule on this page. An http(s) target from a REGISTERED guest is
 * reported to the renderer instead, which turns it into another browser node
 * or another tab on the canvas. Anything else is dropped without a report: an
 * unregistered guest is not something this shell knows how to place, and a
 * non-http(s) target is not something it would open anyway.
 */
export interface PopupDecision {
  readonly action: "deny";
  /** Whether to tell the renderer about it. */
  readonly report: boolean;
  readonly url: string;
}

export function decidePopup(
  url: string,
  fromRegisteredGuest: boolean,
): PopupDecision {
  return {
    action: "deny",
    report:
      fromRegisteredGuest && allowGuestNavigation(url) && url !== "about:blank",
    url,
  };
}
