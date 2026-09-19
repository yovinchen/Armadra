import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { badRequest, conflict, forbidden, notFound } from "./support";

/**
 * Where a workspace's files may be, and which of them a request may name.
 *
 * A direct port of `apps/runtime/src/security.rs`: same checks, same order,
 * same refusals. The order matters more than it looks — `resolveImportSource`
 * canonicalises *before* it asks what kind of file it found, so every later
 * question is asked about the file that would actually be read rather than
 * about the symlink pointing at it.
 */

/**
 * Directories nothing may be created inside. The picker is a system dialog,
 * but the path also arrives as a plain string from the web build, so the
 * refusal has to live here rather than in whatever produced it.
 */
const PROTECTED_PREFIXES =
  process.platform === "win32"
    ? ["C:\\Windows", "C:\\Program Files"]
    : [
        "/System",
        "/Library",
        "/Applications",
        "/bin",
        "/sbin",
        "/usr",
        "/etc",
        "/private/etc",
        "/dev",
        "/proc",
        "/sys",
        "/boot",
      ];

/**
 * Whether `path` is one of the protected locations or lives inside one.
 *
 * Compared segment by segment rather than as text: `/usrX` is not inside
 * `/usr`, and a `startsWith` on the string says it is.
 */
export function isProtected(path: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => contains(prefix, path));
}

/** `true` when `path` is `parent` itself or sits underneath it. */
function contains(parent: string, path: string): boolean {
  if (path === parent) return true;
  const step = relative(parent, path);
  return (
    step !== "" && !step.startsWith("..") && !isAbsolute(step) && step !== path
  );
}

/** `realpath`, without the `\\?\` prefix Windows answers with. */
export function canonicalize(path: string): string {
  const real = realpathSync.native(path);
  const plain = plainWin32Spelling(real);
  return plain ?? real;
}

/**
 * `\\?\C:\Users\dev` → `C:\Users\dev`, or `undefined` when the verbatim form
 * is the only one that can name this path. Exported so it can be tested off
 * Windows, which is where it is never used.
 */
export function plainWin32Spelling(text: string): string | undefined {
  if (!text.startsWith("\\\\?\\")) return undefined;
  const rest = text.slice(4);
  // `\\?\UNC\…` and the device namespaces do not start with a drive letter.
  if (!/^[A-Za-z]:\\/.test(rest)) return undefined;
  return rest;
}

/** An existing directory, canonicalised, or the 400 the Runtime answers. */
export function canonicalDirectory(path: string): string {
  let real: string;
  try {
    real = canonicalize(path);
  } catch {
    throw badRequest("Workspace root does not exist or cannot be accessed");
  }
  if (!statSync(real, { throwIfNoEntry: false })?.isDirectory()) {
    throw badRequest("Workspace root must be a directory");
  }
  return real;
}

/**
 * A single path segment that may be created: no separators, no traversal and
 * no leading dash, which `git` would read as an option.
 */
export function validDirectoryName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    [...trimmed].length > 120 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.startsWith("-") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw badRequest("Folder name is invalid");
  }
  return trimmed;
}

/** Somewhere a new directory may appear: not the root, not a system location. */
export function ensureCreatableParent(parent: string): void {
  if (parse(parent).root === parent) {
    throw forbidden("The filesystem root is not a valid parent directory");
  }
  if (isProtected(parent)) {
    throw forbidden("That location is protected by the system");
  }
}

/**
 * Resolve `<parent>/<name>` for a directory that must **not** exist yet.
 *
 * The parent is canonicalised first, so the answer is always inside a real,
 * non-protected directory. An existing leaf is a 409 rather than a silent
 * reuse: the caller asked for a new folder.
 */
export function prepareNewDirectory(parent: string, name: string): string {
  const root = canonicalDirectory(parent);
  ensureCreatableParent(root);
  const target = join(root, validDirectoryName(name));
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw conflict("A file or folder with that name already exists");
  }
  return target;
}

/**
 * Reject absolute paths, `.`/`..` traversal and empty segments, and return the
 * path normalised to forward slashes.
 */
export function workspaceRelativePath(requested: string): string {
  const trimmed = requested.trim();
  if (trimmed === "" || trimmed.length > 4_096) {
    throw badRequest("Requested path is invalid");
  }
  if (isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw badRequest("Requested path must be relative to the workspace root");
  }
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw badRequest("Requested path must be relative to the workspace root");
  }
  return segments.join("/");
}

/** A path inside `root`, proven so after its symlinks have been followed. */
export function resolveInRoot(root: string, requested: string): string {
  const base = canonicalDirectory(root);
  const candidate =
    requested === "" || requested === "."
      ? base
      : isAbsolute(requested)
        ? requested
        : resolve(base, requested);
  let real: string;
  try {
    real = canonicalize(candidate);
  } catch {
    throw notFound("Requested path does not exist");
  }
  if (real !== base && !contains(base, real)) {
    throw forbidden("Requested path is outside the authorized workspace");
  }
  return real;
}

/**
 * Resolve the source of an asset import (`POST …/assets/import`).
 *
 * This is the one resolver that lets an **absolute** path point outside the
 * workspace: the desktop shell drags pictures in from `~/Downloads`, and the
 * bytes are copied into the asset store rather than exposed where they lie —
 * so the workspace boundary buys nothing here that the copy does not. A
 * **relative** path stays workspace-relative and goes through the usual
 * traversal and symlink checks.
 *
 * Enforced either way: the path resolves, after following symlinks, to a
 * regular file, and never into a system location such as `/dev`.
 */
export function resolveImportSource(root: string, requested: string): string {
  const trimmed = requested.trim();
  if (trimmed === "" || trimmed.length > 4_096) {
    throw badRequest("Requested path is invalid");
  }
  let resolved: string;
  if (isAbsolute(trimmed)) {
    try {
      resolved = canonicalize(trimmed);
    } catch {
      throw notFound("Requested path does not exist");
    }
    if (isProtected(resolved)) {
      throw forbidden("That location is protected by the system");
    }
  } else {
    resolved = resolveInRoot(root, workspaceRelativePath(trimmed));
  }
  const info = statSync(resolved, { throwIfNoEntry: false });
  if (info === undefined) throw notFound("Requested path does not exist");
  if (!info.isFile()) throw badRequest("Only regular files can be imported");
  return resolved;
}

/** The platform separator, exported so tests can build paths without guessing. */
export const SEPARATOR = sep;
