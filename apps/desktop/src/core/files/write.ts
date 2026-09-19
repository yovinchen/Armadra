import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  chmodSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { canonicalDirectory, resolveInRoot } from "../workspaces/roots";
import { badRequest, conflict, forbidden } from "../workspaces/support";
import { MAX_WRITE_FILE_SIZE, UTF8_BOM, sha256 } from "./read";
import { isDirectory, join, relativeToRoot } from "./paths";
import { isReadonly, symlinkMetadata } from "./stat";
import { noteWrite } from "./watch";

/**
 * `PUT /api/workspaces/{id}/file` — the editor node's save.
 *
 * A port of the write half of `apps/runtime/src/files.rs`. The contract the
 * editor depends on, unchanged:
 *
 *   * A **missing** content version means create-only; an existing file
 *     requires the SHA-256 `readTextFile` returned. Size alone cannot detect a
 *     same-length edit, which is why the legacy `expectedSize` field is
 *     refused rather than honoured.
 *   * The bytes land in a sibling temporary file, opened exclusively and
 *     fsynced, and are published with one rename (or one `link`, for a create,
 *     so a second creator loses rather than overwrites).
 *   * The version is verified **again** just before publication. That detects
 *     an external write observed in the meantime; it is not an OS-wide lock,
 *     and no filesystem offers one.
 *   * `bom` re-emits the byte order mark `readTextFile` stripped. Line endings
 *     are never rewritten: the editor holds whatever the file contained and
 *     hands it back unchanged (E01/M4).
 *
 * The Rust version keeps a process-global map of per-path mutexes because two
 * request threads could reach the same file at once. Nothing here needs one:
 * this function is synchronous from the first `lstat` to the final rename, so
 * the event loop cannot interleave a second save of the same path into the
 * middle of it. The CAS check is still what makes the outcome correct — the
 * gate only ever narrowed the window it covers.
 */

export interface FileWriteResult {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export function writeTextFile(
  root: string,
  requested: string,
  content: string,
  expectedSha256: string | undefined,
  bom: boolean,
): FileWriteResult {
  const base = canonicalDirectory(root);
  const body = Buffer.from(content, "utf8");
  const bytes = bom ? Buffer.concat([UTF8_BOM, body]) : body;
  if (bytes.length > MAX_WRITE_FILE_SIZE) {
    throw badRequest("File is larger than the 2 MiB write limit");
  }
  if (
    expectedSha256 !== undefined &&
    !/^[0-9a-fA-F]{64}$/.test(expectedSha256)
  ) {
    throw badRequest("A valid content version is required");
  }
  const expected = expectedSha256?.toLowerCase();
  const path = writablePath(base, requested);
  const permissions = verifyVersion(path, expected);
  if (permissions !== undefined && isReadonly(permissions)) {
    throw forbidden("File is read-only");
  }
  const parent = dirname(path);
  if (parent === path) throw badRequest("File parent is missing");
  const temporary = join(parent, `.${randomUUID()}.armadra-tmp`);
  const handle = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    closeSync(handle);
  };
  try {
    writeSync(handle, bytes);
    fsyncSync(handle);
    close();
    if (permissions !== undefined) {
      chmodSync(temporary, permissions.mode & 0o7777);
    }
    if (writablePath(base, requested) !== path) {
      throw conflict("File parent changed during save");
    }
    verifyVersion(path, expected);
    // Claim the hash *before* it is on disk: the filesystem event of our own
    // save must never race ahead of the record that identifies it (E01/M4). A
    // write that fails after this only leaves a hash nothing matches, which
    // the next real change still differs from.
    const version = sha256(bytes);
    noteWrite(path, version);
    if (expected === undefined) {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw conflict("File was created by another writer");
        }
        throw error;
      }
    } else {
      renameSync(temporary, path);
    }
    syncDirectory(parent);
    return {
      path: relativeToRoot(base, path),
      size: bytes.length,
      sha256: version,
    };
  } finally {
    // A descriptor is closed exactly once: closing a number twice can close
    // whatever the runtime handed that number to in between.
    close();
    rmSync(temporary, { force: true });
  }
}

/**
 * `files::writable_path`: the absolute path a save may publish to.
 *
 * Stricter than `workspaceRelativePath` in one way and looser in another: it
 * takes the path **literally** — ` note ` is a different file from `note`, and
 * neither is trimmed — but it also allows a much longer one, because the
 * ceiling that matters for a save is the filesystem's.
 */
function writablePath(root: string, requested: string): string {
  const segments = requested.split(/[/\\]/);
  if (
    requested === "" ||
    requested.length > 32_768 ||
    isAbsolute(requested) ||
    /^[A-Za-z]:/.test(requested) ||
    segments.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw badRequest("A literal workspace-relative file path is required");
  }
  const name = segments[segments.length - 1] as string;
  const parent = segments.slice(0, -1).join("/");
  const directory = resolveInRoot(root, parent === "" ? "." : parent);
  if (!isDirectory(directory)) {
    throw badRequest("File parent is not a directory");
  }
  return join(directory, name);
}

/**
 * The hash and permissions of what is on disk now, or `undefined` for a file
 * that is not there.
 *
 * Opened with `O_NOFOLLOW` where the platform has it, and the open handle is
 * re-checked: between the `lstat` and the `open` the entry could have become
 * something else, and the second check is asked of the file that was actually
 * opened.
 */
function currentVersion(
  path: string,
):
  | { readonly hash: string; readonly permissions: import("node:fs").Stats }
  | undefined {
  const info = symlinkMetadata(path);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink()) {
    throw forbidden("Writing through a symbolic link is not allowed");
  }
  if (!info.isFile()) throw badRequest("Only regular files can be replaced");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = openSync(path, constants.O_RDONLY | noFollow);
  try {
    if (!fstatSync(handle).isFile()) {
      throw badRequest("Only regular files can be replaced");
    }
    const bytes = readFileSync(handle);
    if (bytes.length > MAX_WRITE_FILE_SIZE) {
      throw badRequest("Existing file exceeds the write limit");
    }
    return { hash: sha256(bytes), permissions: info };
  } finally {
    closeSync(handle);
  }
}

function verifyVersion(
  path: string,
  expected: string | undefined,
): import("node:fs").Stats | undefined {
  const current = currentVersion(path);
  if (current?.hash !== expected) {
    throw conflict(
      "File content changed; reload or compare the disk version before saving",
    );
  }
  return current?.permissions;
}

/**
 * Fsync the directory so the rename itself is durable, not just the bytes.
 * Best effort: some platforms refuse to open a directory for this, and a
 * failure here does not make the published file any less published.
 */
function syncDirectory(path: string): void {
  try {
    const handle = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    // Windows, and any filesystem that will not fsync a directory.
  }
}
