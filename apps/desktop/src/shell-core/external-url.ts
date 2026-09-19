/**
 * Which URLs the shell will hand to the operating system.
 *
 * `shell.openExternal` is the one call in the whole surface that leaves the
 * sandbox entirely: the OS resolves the scheme against its own handler table,
 * so `file://` opens Finder on a path the page chose, and a registered custom
 * scheme can start another application with an argument the page chose. The
 * page is not the author of those URLs either — a Markdown link in an agent's
 * answer, a redirect in a browser node, a remote announcement feed all reach
 * here — so the list is an allow-list rather than a deny-list.
 *
 * `http` and `https` only, per the migration design §2.2. Armadra excludes
 * `mailto:` because nothing in the product produces one and
 * an allow-list should hold exactly what is used.
 */

/** The `{ code }` a refusal carries. The page shows its own wording for it. */
export const SCHEME_NOT_ALLOWED = "scheme_not_allowed";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Parses as a URL AND carries an allowed scheme.
 *
 * Parsing is what decides the scheme — a string test would be fooled by
 * `javascript:void(0)//http://x` and friends, and by the whitespace and
 * control characters `new URL` strips before it reports a protocol.
 */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
