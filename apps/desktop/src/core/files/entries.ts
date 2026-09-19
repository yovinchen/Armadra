import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join as pathJoin } from "node:path";
import { canonicalDirectory } from "../workspaces/roots";
import { badRequest, conflict, notFound } from "../workspaces/support";
import {
  type EntryKind,
  baseName,
  join,
  refuseReserved,
  resolveExisting,
  resolveTarget,
  validEntryName,
} from "./paths";
import { symlinkMetadata } from "./stat";

/**
 * File management for the editor and the file tree (E01/M4).
 *
 * A port of `apps/runtime/src/file_ops.rs`. Create, rename/move and delete,
 * all inside one workspace and all behind the workspace's write permission
 * (checked by the route).
 *
 * Deleting never removes bytes. The entry is **moved** into
 * `<workspace>/.armadra/trash/<id>/` next to a small `entry.json` describing
 * where it came from, and `restoreTrash` puts it back. A permanent delete is
 * deliberately not offered: a canvas node must not be able to destroy work
 * that nothing else in the product can recover.
 */

/** Where deleted entries wait to be restored. */
export const TRASH_DIRECTORY = ".armadra/trash";
const MANIFEST = "entry.json";
/**
 * The moved file or folder keeps its own name under this sub-directory, so a
 * restore is a plain rename and the manifest can never collide with it.
 */
const PAYLOAD = "payload";
/**
 * How many trashed entries `listTrash` reports. Enough for an undo panel,
 * bounded so a long-running workspace cannot produce an unbounded response.
 */
const MAX_TRASH_ENTRIES = 200;

export interface EntryResult {
  readonly path: string;
  readonly kind: EntryKind;
}

export interface TrashEntry {
  readonly id: string;
  /** Where it was when it was deleted, relative to the workspace root. */
  readonly originalPath: string;
  readonly name: string;
  readonly kind: EntryKind;
  /** RFC 3339. */
  readonly deletedAt: string;
}

/** 新建文件 / 新建文件夹. An existing name is a 409, never an overwrite. */
export function createEntry(
  root: string,
  requested: string,
  kind: EntryKind,
): EntryResult {
  const base = canonicalDirectory(root);
  const { relative, path } = resolveTarget(base, requested);
  refuseReserved(relative);
  validEntryName(baseName(relative));
  if (symlinkMetadata(path) !== undefined) {
    throw conflict("A file or folder with that name already exists");
  }
  if (kind === "directory") {
    mkdirSync(path);
  } else {
    let handle: number;
    try {
      handle = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw conflict("A file with that name already exists");
      }
      throw error;
    }
    closeSync(handle);
  }
  return { path: relative, kind };
}

/**
 * 重命名 / 移动. Both are the same operation; only the destination differs.
 *
 * The destination must be free — a rename never overwrites — and a directory
 * may not be moved inside itself.
 */
export function renameEntry(
  root: string,
  from: string,
  to: string,
): EntryResult {
  const base = canonicalDirectory(root);
  const source = resolveExisting(base, from);
  const target = resolveTarget(base, to);
  refuseReserved(source.relative);
  refuseReserved(target.relative);
  validEntryName(baseName(target.relative));
  // Renaming a path onto itself is a no-op, not a conflict: the editor may
  // submit the unchanged name when a rename dialog is confirmed untouched.
  if (source.relative === target.relative) {
    return { path: target.relative, kind: source.kind };
  }
  if (target.relative.startsWith(`${source.relative}/`)) {
    throw badRequest("A folder cannot be moved inside itself");
  }
  if (symlinkMetadata(target.path) !== undefined) {
    throw conflict("A file or folder with that name already exists");
  }
  renameSync(source.path, target.path);
  return { path: target.relative, kind: source.kind };
}

/**
 * 删除到回收站. The entry is moved, never unlinked, and the manifest records
 * where it came from so `restoreTrash` can put it back.
 */
export function trashEntry(root: string, requested: string): TrashEntry {
  const base = canonicalDirectory(root);
  const { relative, path, kind } = resolveExisting(base, requested);
  refuseReserved(relative);
  const name = baseName(relative);
  if (name === "") throw badRequest("Requested path is invalid");
  const id = randomUUID();
  const slot = pathJoin(base, TRASH_DIRECTORY, id);
  mkdirSync(pathJoin(slot, PAYLOAD), { recursive: true });
  const entry: TrashEntry = {
    id,
    originalPath: relative,
    name,
    kind,
    deletedAt: new Date().toISOString().replace("Z", "+00:00"),
  };
  // Move first: a manifest describing something still in place would be a lie
  // if the rename then failed.
  try {
    renameSync(path, join(pathJoin(slot, PAYLOAD), name));
  } catch (error) {
    rmSync(slot, { recursive: true, force: true });
    throw error;
  }
  writeFileSync(pathJoin(slot, MANIFEST), JSON.stringify(entry, null, 2));
  return entry;
}

/** What is currently recoverable, newest first. */
export function listTrash(root: string): TrashEntry[] {
  const base = canonicalDirectory(root);
  const directory = pathJoin(base, TRASH_DIRECTORY);
  let slots: string[];
  try {
    slots = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: TrashEntry[] = [];
  for (const slot of slots) {
    const parsed = readManifest(pathJoin(directory, slot, MANIFEST));
    if (parsed !== undefined) entries.push(parsed);
  }
  entries.sort((left, right) =>
    left.deletedAt === right.deletedAt
      ? 0
      : left.deletedAt < right.deletedAt
        ? 1
        : -1,
  );
  return entries.slice(0, MAX_TRASH_ENTRIES);
}

/**
 * Put a trashed entry back where it came from.
 *
 * The original location must be free again and its parent must still exist; a
 * restore never overwrites and never recreates a directory tree the user has
 * since removed.
 */
export function restoreTrash(root: string, id: string): EntryResult {
  const base = canonicalDirectory(root);
  if (id === "" || id.length > 64 || !/^[0-9A-Za-z-]+$/.test(id)) {
    throw badRequest("Unknown deleted entry");
  }
  const slot = pathJoin(base, TRASH_DIRECTORY, id);
  const entry = readManifest(pathJoin(slot, MANIFEST));
  if (entry === undefined) throw notFound("Unknown deleted entry");
  const { relative, path } = resolveTarget(base, entry.originalPath);
  refuseReserved(relative);
  if (symlinkMetadata(path) !== undefined) {
    throw conflict("Something else already occupies the original location");
  }
  renameSync(join(pathJoin(slot, PAYLOAD), entry.name), path);
  rmSync(slot, { recursive: true, force: true });
  return { path: relative, kind: entry.kind };
}

/** A manifest that is missing, unreadable or not a manifest is simply not one. */
function readManifest(path: string): TrashEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (
    typeof record.id !== "string" ||
    typeof record.originalPath !== "string" ||
    typeof record.name !== "string" ||
    typeof record.deletedAt !== "string" ||
    (kind !== "file" && kind !== "directory")
  ) {
    return undefined;
  }
  return {
    id: record.id,
    originalPath: record.originalPath,
    name: record.name,
    kind,
    deletedAt: record.deletedAt,
  };
}
