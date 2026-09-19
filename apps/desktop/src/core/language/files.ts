/**
 * The slice of `apps/runtime/src/files.rs` a `WorkspaceEdit` needs: read one
 * text file with its content version, and write one back against the version
 * the caller read.
 *
 * It lives here rather than in a shared `core/files` because this domain needs
 * exactly two functions and needs them before the file-system domain claims
 * its own routes. Both are ports of the Rust originals, and the properties
 * that matter to an edit are kept:
 *
 *   * **Containment.** A path is a literal workspace-relative one — no
 *     absolute paths, no `..` — resolved against the *canonical* root, and the
 *     resolved path is checked to still be inside it. A symlink that points
 *     out of the workspace is out of the workspace.
 *   * **The version is the content, not the clock.** SHA-256 of the bytes as
 *     they are on disk, byte-order mark included. Size and mtime cannot detect
 *     a same-length edit.
 *   * **The publication is atomic.** A sibling temporary file is written,
 *     fsynced and renamed, and the version is verified once more immediately
 *     before the rename — which detects an external write that landed while
 *     this one was being prepared. It is not an OS-wide lock and does not
 *     pretend to be.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { DomainError, badRequest, conflict, forbidden } from "../workspaces/support";

const MAX_TEXT_FILE_SIZE = 1_048_576;
export const MAX_WRITE_FILE_SIZE = 2 * 1_048_576;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface FileContent {
  readonly path: string;
  readonly content: string;
  /** Absent when the file is not valid UTF-8: it cannot be written safely. */
  readonly sha256: string | undefined;
  readonly size: number;
  readonly bom: boolean;
}

export interface FileWriteResult {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** The canonical absolute form of a directory, or a 400 naming why not. */
export function canonicalRoot(root: string): string {
  try {
    const resolved = realpathSync(resolve(root));
    if (!statSync(resolved).isDirectory()) {
      throw badRequest("Workspace root is not a directory");
    }
    return resolved;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw badRequest("Workspace root is not readable");
  }
}

/**
 * A literal workspace-relative path, joined onto the canonical root.
 *
 * `..`, an absolute path and an empty one are all refused before the
 * filesystem is touched: a path that has to be normalised to be safe is a path
 * whose safety depends on the normaliser.
 */
export function resolveInRoot(root: string, requested: string): string {
  if (
    requested.length === 0 ||
    requested.length > 32_768 ||
    isAbsolute(requested)
  ) {
    throw badRequest("A literal workspace-relative file path is required");
  }
  const parts = requested.split(/[/\\]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw badRequest("A literal workspace-relative file path is required");
  }
  return join(root, ...parts);
}

/** The path relative to `root`, refused when the resolved path escaped it. */
function relativeToRoot(root: string, path: string): string {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) {
    throw badRequest("Path resolves outside the workspace");
  }
  return path.slice(prefix.length).split(sep).join("/");
}

/**
 * The resolved path with every symlink followed, for the containment check.
 *
 * A file that does not exist yet is resolved through its *parent*, which does
 * — otherwise a create could never pass the check at all.
 */
function realPathForCheck(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = realpathSync(dirname(path));
    return join(parent, path.slice(dirname(path).length + 1));
  }
}

export function readTextFile(root: string, requested: string): FileContent {
  const canonical = canonicalRoot(root);
  const path = resolveInRoot(canonical, requested);
  const real = realPathForCheck(path);
  const relative = relativeToRoot(canonical, real);
  let stats;
  try {
    stats = statSync(real);
  } catch {
    throw badRequest("File does not exist");
  }
  if (!stats.isFile()) throw badRequest("Requested path is not a file");
  if (stats.size > MAX_TEXT_FILE_SIZE) {
    throw badRequest("File is larger than the 1 MiB preview limit");
  }
  const bytes = readFileSync(real);
  if (bytes.byteLength > MAX_TEXT_FILE_SIZE) {
    throw badRequest("File exceeds the preview limit");
  }
  if (bytes.subarray(0, 8192).includes(0)) {
    throw badRequest("Binary files cannot be previewed as text");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const bom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const body = bom ? bytes.subarray(3) : bytes;
  const content = body.toString("utf8");
  // A file that is not valid UTF-8 comes back as a lossy reading with no
  // content version, which is exactly what the editor already treats as
  // read-only.
  const roundTrips = Buffer.from(content, "utf8").equals(body);
  return {
    path: relative,
    content,
    sha256: roundTrips ? digest : undefined,
    size: bytes.byteLength,
    bom,
  };
}

/**
 * Writes `content`, refusing unless the file on disk still hashes to
 * `expectedSha256`. An absent expectation means create-only: the file must not
 * already exist.
 */
export function writeTextFile(
  root: string,
  requested: string,
  content: string,
  expectedSha256: string | undefined,
  bom: boolean,
): FileWriteResult {
  const canonical = canonicalRoot(root);
  const payload = bom
    ? Buffer.concat([UTF8_BOM, Buffer.from(content, "utf8")])
    : Buffer.from(content, "utf8");
  if (payload.byteLength > MAX_WRITE_FILE_SIZE) {
    throw badRequest("File is larger than the 2 MiB write limit");
  }
  if (
    expectedSha256 !== undefined &&
    !/^[0-9a-fA-F]{64}$/.test(expectedSha256)
  ) {
    throw badRequest("A valid content version is required");
  }
  const expected = expectedSha256?.toLowerCase();
  const path = resolveInRoot(canonical, requested);
  const real = realPathForCheck(path);
  const relative = relativeToRoot(canonical, real);
  const parent = dirname(real);
  try {
    if (!statSync(parent).isDirectory()) {
      throw badRequest("File parent is not a directory");
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw badRequest("File parent is missing");
  }
  const mode = verifyVersion(real, expected);

  const temporary = join(parent, `.${randomUUID()}.armadra-tmp`);
  let descriptor: number;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
  } catch {
    throw forbidden("File could not be written");
  }
  try {
    writeSync(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    // The last verification detects an external write observed while this one
    // was being prepared. It is not a cross-process lock.
    verifyVersion(real, expected);
    renameSync(temporary, real);
    if (mode !== undefined) {
      // Preserve whatever the file had; a fresh file keeps the 0600 it was
      // created with until the umask-respecting default applies.
      try {
        chmodSync(real, mode);
      } catch {
        // A filesystem without modes (or a Windows one) is not a failure.
      }
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return {
    path: relative,
    size: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

/**
 * The current version of `path`, refused when it is not what the caller read.
 * Returns the file's mode when it exists, so the rename can restore it.
 */
function verifyVersion(
  path: string,
  expected: string | undefined,
): number | undefined {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    if (expected === undefined) return undefined;
    throw conflict(
      "File content changed; reload or compare the disk version before saving",
    );
  }
  if (!stats.isFile()) throw badRequest("Requested path is not a file");
  const current = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (current !== expected) {
    throw conflict(
      "File content changed; reload or compare the disk version before saving",
    );
  }
  return stats.mode & 0o777;
}

/** For tests that need a throwaway root. */
export function temporaryRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
