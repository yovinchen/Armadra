import { writeFileSync } from "node:fs";
import { relative as relativePath, resolve, sep } from "node:path";
import { metadata, symlinkMetadata } from "./stat";
import {
  canonicalDirectory,
  resolveInRoot,
  workspaceRelativePath,
} from "../workspaces/roots";
import { badRequest, forbidden, notFound } from "../workspaces/support";

/**
 * The path rules every filesystem surface shares.
 *
 * A port of the half of the pre-merge implementation's security module that
 * files, file-ops and file-watch lean on, plus the two resolvers it keeps to
 * itself. `core/workspaces/roots.ts` already carries
 * the other half (`canonicalDirectory`, `resolveInRoot`,
 * `workspaceRelativePath`, `resolveImportSource`) and is not duplicated here.
 *
 * The shape of every rule is the same and it is worth saying once: the
 * **parent** is canonicalised — so a symlinked directory anywhere above the
 * target cannot lead outside the workspace — and the **target** is then
 * examined with `lstat`, never `stat`, so a link at the leaf is refused rather
 * than followed. Resolving the leaf too would mean a link inside the workspace
 * could rename, trash or overwrite whatever it points at.
 */

/**
 * `relative_to_root`: `path` spelled relative to `root`, with forward slashes.
 *
 * `.` for the root itself, which is the answer `GET …/files?path=.` echoes
 * back. A path that is not under the root at all is a refusal rather than a
 * `../…` answer: by the time this is called the boundary has been proven, so
 * reaching the error means a caller skipped a check.
 */
export function relativeToRoot(root: string, path: string): string {
  const step = relativePath(root, path);
  if (step === "") return ".";
  if (step.startsWith("..") || resolve(path) !== resolve(root, step)) {
    throw forbidden("Requested path is outside the authorized workspace");
  }
  return step.split(sep).join("/");
}

/**
 * `resolve_writable_in_root`: a workspace-relative path that does **not** have
 * to exist yet, with its parent canonicalised inside the root.
 *
 * An existing leaf must be a regular file. Symlinks, directories, FIFOs and
 * devices are refused, so a write can never follow a link out of the workspace
 * or clobber a special file.
 */
export function resolveWritableInRoot(root: string, requested: string): string {
  const base = canonicalDirectory(root);
  const relative = workspaceRelativePath(requested);
  const { parent, name } = split(relative);
  if (name === "") throw badRequest("Requested path is invalid");
  const directory = resolveInRoot(base, parent);
  if (!isDirectory(directory)) {
    throw badRequest("The parent directory does not exist");
  }
  const candidate = join(directory, name);
  const info = symlinkMetadata(candidate);
  if (info !== undefined && (info.isSymbolicLink() || !info.isFile())) {
    throw forbidden("Only regular files inside the workspace can be written");
  }
  return candidate;
}

/**
 * `file_ops::resolve_target`: (normalised relative, absolute) with the parent
 * canonicalised. The target does not have to exist.
 *
 * The relative half is recomputed from the canonical parent, so a symlinked
 * directory on the way down is reported at the place the bytes actually live
 * rather than at the path that was typed.
 */
export function resolveTarget(
  root: string,
  requested: string,
): { readonly relative: string; readonly path: string } {
  const relative = workspaceRelativePath(requested);
  const { parent, name } = split(relative);
  if (name === "" || name === "." || name === "..") {
    throw badRequest("Requested path is invalid");
  }
  const directory = resolveInRoot(root, parent);
  if (!isDirectory(directory)) {
    throw badRequest("The parent directory does not exist");
  }
  const path = join(directory, name);
  return { relative: relativeToRoot(root, path), path };
}

export type EntryKind = "file" | "directory";

/**
 * `file_ops::resolve_existing`: as `resolveTarget`, but the entry must already
 * be there as a regular file or a directory. A symbolic link is refused.
 */
export function resolveExisting(
  root: string,
  requested: string,
): {
  readonly relative: string;
  readonly path: string;
  readonly kind: EntryKind;
} {
  const { relative, path } = resolveTarget(root, requested);
  const info = symlinkMetadata(path);
  if (info === undefined) throw notFound("Requested path does not exist");
  if (info.isSymbolicLink()) {
    throw forbidden("Symbolic links cannot be renamed or deleted from here");
  }
  if (info.isDirectory()) return { relative, path, kind: "directory" };
  if (info.isFile()) return { relative, path, kind: "file" };
  throw badRequest("Only regular files and folders can be managed");
}

/**
 * `file_ops::valid_entry_name`: one path segment that may be created.
 *
 * Mirrors `validDirectoryName` in `workspaces/roots.ts` but also refuses the
 * names our own bookkeeping uses, so a node cannot create a file that a
 * half-finished save would later be mistaken for.
 */
export function validEntryName(name: string): void {
  if (
    name === "" ||
    [...name].length > 200 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.endsWith(".armadra-tmp") ||
    // `char::is_control`: C0, DEL and the C1 range.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/.test(name)
  ) {
    throw badRequest("That name is not allowed");
  }
}

/** The directory our own bookkeeping lives in. */
export const MANAGED_DIRECTORY = ".armadra";

/**
 * Keep `.armadra` out of the workspace's Git status.
 *
 * The trash, the imports and the assets all land inside the user's working
 * tree, so deleting one file in the file tree used to add three untracked
 * entries to `git status` — noise the Git tool window shows and a commit can
 * pick up by accident. A self-ignoring `.gitignore` (`*` also matches the
 * `.gitignore` itself) is the one marker that works for every repository
 * shape: the workspace being the repository root, a sub-directory of one, or
 * no repository at all. Nothing outside `.armadra` is touched — neither the
 * user's own `.gitignore` nor `.git/info/exclude`.
 *
 * Best effort: a read-only workspace must not fail an import or a delete just
 * because the marker could not be written.
 */
export function markManagedDirectory(directory: string): void {
  const marker = join(directory, ".gitignore");
  if (symlinkMetadata(marker) !== undefined) return;
  try {
    writeFileSync(marker, "*\n", { flag: "wx" });
  } catch {
    // Already there, or the workspace is not writable. Either way the caller's
    // own work is what matters.
  }
}

/**
 * `file_ops::refuse_reserved`: the `.armadra` folder is ours.
 *
 * Refusing to create, rename or delete inside it keeps the trash, the imports
 * and the assets from being edited through the same surface that produced them.
 */
export function refuseReserved(relative: string): void {
  if (
    relative === MANAGED_DIRECTORY ||
    relative.startsWith(`${MANAGED_DIRECTORY}/`)
  ) {
    throw forbidden("The .armadra folder is managed by Armadra");
  }
}

/** `(parent, name)` of a forward-slash relative path; `"."` for no parent. */
export function split(relative: string): {
  readonly parent: string;
  readonly name: string;
} {
  const cut = relative.lastIndexOf("/");
  return cut === -1
    ? { parent: ".", name: relative }
    : { parent: relative.slice(0, cut), name: relative.slice(cut + 1) };
}

/** The last segment of a workspace-relative path. */
export function baseName(relative: string): string {
  return split(relative).name;
}

/** Joins with the platform separator without re-normalising `name`. */
export function join(directory: string, name: string): string {
  return directory.endsWith(sep) ? directory + name : directory + sep + name;
}

/** Whether `path` is a directory, following links, without throwing. */
export function isDirectory(path: string): boolean {
  return metadata(path)?.isDirectory() === true;
}
