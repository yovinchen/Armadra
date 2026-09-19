/**
 * Where a `capture`, an `upload` or an accepted `download` may touch the disk.
 *
 * A screenshot verb is, mechanically, "write bytes of attacker-influenced
 * content to a path the caller chose". Unjailed, that is an arbitrary file
 * write primitive with a friendly name. Three checks, and all three are needed:
 *
 *   1. resolve the requested path against the workspace root and `realpath` its
 *      PARENT, so a `..` segment or a symlinked directory has already been
 *      followed before anything is compared;
 *   2. compare with a SEPARATOR-TERMINATED prefix, because `/proj-evil` starts
 *      with `/proj` and a plain `startsWith` would let it in;
 *   3. `lstat` the final segment, so the last component cannot itself be a
 *      symlink pointing out — the one hop `realpath` of the parent does not
 *      cover.
 *
 * The root is `realpath`ed too. On macOS a workspace under `/tmp` is really
 * under `/private/tmp`, and comparing a resolved child against an unresolved
 * root refuses every legitimate path there.
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep, dirname, basename } from "node:path";

export type JailFailure =
  | "outsideWorkspace"
  | "symlink"
  | "missingParent"
  | "badPath";

export type JailResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: JailFailure };

/**
 * Rule 2 on its own, so it can be tested without a filesystem: is `candidate`
 * the root itself or something strictly inside it?
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * The full check, for a path that is about to be WRITTEN.
 *
 * `requested` may be relative (resolved against the workspace root) or
 * absolute. Either way it ends up inside the root or it is refused.
 */
export function jailWritePath(workspaceRoot: string, requested: string): JailResult {
  if (typeof requested !== "string" || requested.length === 0) {
    return { ok: false, reason: "badPath" };
  }
  // A NUL byte truncates the path at the syscall boundary, so a name carrying
  // one means something different to the check and to the write.
  if (requested.includes("\0")) return { ok: false, reason: "badPath" };

  let root: string;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    return { ok: false, reason: "missingParent" };
  }
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);

  let parent: string;
  try {
    parent = realpathSync(dirname(absolute));
  } catch {
    return { ok: false, reason: "missingParent" };
  }
  if (!isInside(root, parent)) return { ok: false, reason: "outsideWorkspace" };

  const final = resolve(parent, basename(absolute));
  if (!isInside(root, final)) return { ok: false, reason: "outsideWorkspace" };
  // Rule 3: the last segment may already exist as a symlink out of the tree.
  // `lstat` does not follow it, which is exactly why it is the one used.
  try {
    if (lstatSync(final).isSymbolicLink()) return { ok: false, reason: "symlink" };
  } catch {
    // Not existing is the normal case for a file about to be created.
  }
  return { ok: true, path: final };
}

/**
 * The same check for a path that is about to be READ — `upload`'s file list.
 *
 * The final segment must exist, and must not be a symlink: following one would
 * let a workspace-relative name name a file outside the workspace, which is
 * the read-side twin of the write primitive above.
 */
export function jailReadPath(workspaceRoot: string, requested: string): JailResult {
  const jailed = jailWritePath(workspaceRoot, requested);
  if (!jailed.ok) return jailed;
  try {
    if (!lstatSync(jailed.path).isFile()) return { ok: false, reason: "badPath" };
  } catch {
    return { ok: false, reason: "badPath" };
  }
  return jailed;
}

/** What a caller is told. The reason is named; the resolved path is not, so a
 * refusal cannot be used to map the filesystem outside the workspace. */
export function jailMessage(reason: JailFailure): string {
  switch (reason) {
    case "outsideWorkspace":
      return "that path is outside the workspace; browser files stay inside it";
    case "symlink":
      return "that path is a symbolic link; browser files stay inside the workspace";
    case "missingParent":
      return "that directory does not exist inside the workspace";
    default:
      return "that is not a usable path";
  }
}
