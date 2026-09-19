/**
 * Which paths the shell will show to the user in their file manager.
 *
 * `shell.showItemInFolder` is a second way out of the sandbox, next to
 * `shell.openExternal`: it opens a native file manager window on a path the
 * PAGE named. That is much narrower than `openExternal` — no scheme handler
 * table, no other application started with an argument — but it is still the
 * page choosing what a privileged process reveals, so it gets an allow-list
 * for the same reason the scheme check has one.
 *
 * The rule is an allow-list of ROOTS rather than of schemes: a path is shown
 * only if it is the shell's own data directory, the system downloads
 * directory, or something inside one of them. Those are the two places this
 * product writes files the user is invited to go look at (settings → data,
 * and the downloads a browser node saved). A workspace root is deliberately
 * NOT here: the shell does not know which directories are workspaces — the
 * Runtime tells it one per verb call (`main/browser/verbs.ts`) — and the page
 * naming its own root would make the allow-list say whatever the caller
 * wanted it to say.
 */

import { isAbsolute, resolve, sep } from "node:path";

/** The `{ code }` a refusal carries. The page shows its own wording for it. */
export const PATH_NOT_ALLOWED = "path_not_allowed";

/**
 * PURE. `candidate` is `root` itself or something strictly inside it.
 *
 * The prefix is SEPARATOR-TERMINATED, because `/data-evil` starts with
 * `/data` and a plain `startsWith` would let it in.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * PURE. The path to reveal, or `null` when it may not be revealed.
 *
 * Returns the NORMALIZED path rather than a boolean so the caller cannot
 * check one string and hand a different one to Electron: `resolve` is what
 * collapses the `..` segments the check is about, so the checked form and the
 * used form have to be the same value.
 *
 * Relative paths are refused rather than resolved against a root — the page's
 * idea of a working directory is not this process's, and "relative to which
 * root?" has no answer when there is more than one.
 */
export function revealablePath(
  requested: unknown,
  roots: readonly string[],
): string | null {
  if (typeof requested !== "string" || requested.length === 0) return null;
  // A NUL byte truncates the path at the syscall boundary, so a name carrying
  // one means something different to the check and to the open.
  if (requested.includes("\0")) return null;
  if (!isAbsolute(requested)) return null;
  const absolute = resolve(requested);
  for (const root of roots) {
    if (root.length === 0 || !isAbsolute(root)) continue;
    if (isInsideRoot(resolve(root), absolute)) return absolute;
  }
  return null;
}
