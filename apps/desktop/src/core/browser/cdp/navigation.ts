/**
 * Where a browser node may ever be pointed.
 *
 * `file://` is refused outright, including when the current document is a
 * local file: a remote page that can point a guest at a local file can read
 * anything this user can read. The rule lives here rather than beside the
 * shell's `will-navigate` listener because both backends need it — the
 * `<webview>` guest in the desktop shell and the headless Chromium the server
 * shell starts — and a navigation gate that exists in one of two backends is
 * not a gate.
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
