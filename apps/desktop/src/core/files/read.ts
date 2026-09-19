import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { canonicalDirectory, resolveInRoot } from "../workspaces/roots";
import { badRequest } from "../workspaces/support";
import { MAX_FILE_BYTES } from "../imports/limits";
import { mimeOrTextPlain } from "./mime";
import { isDirectory, join, relativeToRoot } from "./paths";
import { isReadonly, metadata } from "./stat";

/**
 * Reading: the file tree, the editor's text read, and the raw download.
 *
 * A port of the read half of `apps/runtime/src/files.rs`. The three readers
 * are deliberately separate rather than one reader with flags: the editor's
 * reader refuses binary and stops at the preview limit, both of which are
 * right for an editor and wrong for a picture, and the tree's reader never
 * opens a file at all.
 */

const MAX_ENTRIES = 500;
const MAX_TEXT_FILE_SIZE = 1_048_576;
/**
 * `PUT /api/workspaces/{id}/file` ceiling. The editor node refuses to open
 * anything above the 1 MiB preview limit, so this is only a backstop.
 */
export const MAX_WRITE_FILE_SIZE = 2 * 1_048_576;
const IGNORED_NAMES = [".git", "node_modules", "target", "dist", "coverage"];

/** UTF-8 byte order mark, stripped from `content` and reported separately. */
export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly readonly: boolean;
}

export interface FileList {
  readonly path: string;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
}

export interface FileContent {
  readonly path: string;
  readonly mimeType: string;
  readonly content: string;
  readonly size: number;
  /**
   * The content version for the next save. Absent when the file is not valid
   * UTF-8: what the editor shows is a lossy reading, and writing it back would
   * silently rewrite bytes it never saw (E01/M4).
   */
  readonly sha256?: string;
  /** `utf-8` or `unknown`; `unknown` means read-only. */
  readonly encoding: "utf-8" | "unknown";
  /** The file starts with a UTF-8 BOM, stripped from `content`. */
  readonly bom: boolean;
  /** `lf`, `crlf`, `mixed`, or `none` for a file without a line break. */
  readonly eol: "lf" | "crlf" | "mixed" | "none";
  /** The file cannot be written where it is, whatever the workspace allows. */
  readonly readonly: boolean;
}

/** The SHA-256 of `bytes`, lower-case hex — the spelling `format!("{:x}")` gives. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Which line ending the file uses.
 *
 * `mixed` is reported rather than guessed: the editor says so instead of
 * quietly normalising a file on the next save.
 */
export function detectEol(bytes: Buffer): FileContent["eol"] {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1;
    else lf += 1;
  }
  if (crlf === 0 && lf === 0) return "none";
  if (crlf === 0) return "lf";
  if (lf === 0) return "crlf";
  return "mixed";
}

/**
 * Rust compares `String`s byte by byte, and the file tree is sorted before it
 * is truncated at 500 entries — so which entries survive depends on the
 * comparison. `localeCompare` would put `Z` after `a`; this does not.
 */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function listDirectory(root: string, requested: string): FileList {
  const base = canonicalDirectory(root);
  const directory = resolveInRoot(base, requested);
  if (!isDirectory(directory)) {
    throw badRequest("Requested path is not a directory");
  }
  const entries: FileEntry[] = [];
  for (const name of readdirSync(directory)) {
    if (IGNORED_NAMES.includes(name)) continue;
    const path = join(directory, name);
    // Resolve scope before exposing target metadata. A symlink inside the
    // workspace must not disclose the type or size of outside files.
    let info;
    try {
      info = metadata(resolveInRoot(base, path));
    } catch {
      continue;
    }
    if (info === undefined || (!info.isFile() && !info.isDirectory())) continue;
    entries.push({
      name,
      path: relativeToRoot(base, path),
      kind: info.isDirectory() ? "directory" : "file",
      size: info.size,
      readonly: isReadonly(info),
    });
  }
  entries.sort((left, right) => {
    const kinds =
      Number(left.kind !== "directory") - Number(right.kind !== "directory");
    return kinds !== 0 ? kinds : byteOrder(left.name, right.name);
  });
  const truncated = entries.length > MAX_ENTRIES;
  return {
    path: relativeToRoot(base, directory),
    entries: entries.slice(0, MAX_ENTRIES),
    truncated,
  };
}

/**
 * Read a file as bytes, for a download or a whiteboard asset.
 *
 * The content type is always opaque and never sniffed: an uploaded HTML or SVG
 * file must not be able to execute in the core's origin on the way back out.
 */
export function readRawFile(
  root: string,
  requested: string,
): {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Buffer;
} {
  const base = canonicalDirectory(root);
  const path = resolveInRoot(base, requested);
  const info = metadata(path);
  if (info === undefined || !info.isFile()) {
    throw badRequest("Requested path is not a file");
  }
  const bytes = readFileSync(path);
  if (bytes.length > MAX_FILE_BYTES) {
    throw badRequest("File exceeds the 16 MiB download limit");
  }
  return {
    path: relativeToRoot(base, path),
    contentType: "application/octet-stream",
    bytes,
  };
}

export function readTextFile(root: string, requested: string): FileContent {
  const base = canonicalDirectory(root);
  const path = resolveInRoot(base, requested);
  const info = metadata(path);
  if (info === undefined || !info.isFile()) {
    throw badRequest("Requested path is not a file");
  }
  if (info.size > MAX_TEXT_FILE_SIZE) {
    throw badRequest("File is larger than the 1 MiB preview limit");
  }
  const bytes = readFileSync(path);
  if (bytes.length > MAX_TEXT_FILE_SIZE) {
    throw badRequest("File exceeds the preview limit");
  }
  const size = bytes.length;
  const version = sha256(bytes);
  if (bytes.subarray(0, 8_192).includes(0)) {
    throw badRequest("Binary files cannot be previewed as text");
  }
  const eol = detectEol(bytes);
  const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const body = bom ? bytes.subarray(UTF8_BOM.length) : bytes;
  // A file that is not valid UTF-8 is still worth showing. It comes back as a
  // lossy reading with no content version, which is exactly what the editor
  // already treats as read-only (E01/M4).
  const utf8 = isUtf8(body);
  return {
    path: relativeToRoot(base, path),
    mimeType: mimeOrTextPlain(path),
    content: body.toString("utf8"),
    size,
    ...(utf8 ? { sha256: version } : {}),
    encoding: utf8 ? "utf-8" : "unknown",
    bom,
    eol,
    readonly: isReadonly(info),
  };
}

/** `std::str::from_utf8(..).is_ok()`. */
function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
