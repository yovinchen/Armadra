import { type FSWatcher, readFileSync, watch as watchPath } from "node:fs";
import { dirname } from "node:path";
import type { WorkspaceEvent } from "../bus";
import { canonicalDirectory, workspaceRelativePath } from "../workspaces/roots";
import { MAX_WRITE_FILE_SIZE, sha256 } from "./read";
import { join, resolveWritableInRoot } from "./paths";
import { symlinkMetadata } from "./stat";
import { badRequest } from "../workspaces/support";

/**
 * External-change watching for open editor files (E01/M4).
 *
 * The editor already protects a save with a SHA-256 content version, but that
 * only surfaces a conflict *after* the user pressed save. This module watches
 * the files an editor node currently has open and publishes `file.changed` the
 * moment one of them changes underneath.
 *
 * A port of the pre-merge implementation, including the parts that are
 * easy to mistake for incidental:
 *
 *   * The **parent directory** is watched, never the file. An atomic replace
 *     swaps the inode, and a watch on the file itself would follow the old one
 *     on inotify and go silent.
 *   * Our own saves are not external changes. `noteWrite` records the hash a
 *     save is about to publish *before* it publishes it, so the filesystem
 *     event that follows compares equal and is dropped.
 *   * A burst is collected for 120 ms and turned into one event. Editors and
 *     formatters write a file as truncate/write/rename or delete/create, and
 *     without a settle window each step would reach the canvas separately.
 *   * Nothing here is authoritative about permissions. Registration is refused
 *     for a workspace that is not readable, and `releaseWorkspace` drops the
 *     OS watcher when a workspace loses read access or goes away.
 *
 * **Why `fs.watch` and not `chokidar`.** The one thing `fs.watch` does not
 * give on Linux is `recursive: true` — and this design never asks for it: the
 * watch set is the handful of directories that contain a currently-open
 * editor file, each watched non-recursively, which is exactly what the Rust
 * version asks `notify` for (`RecursiveMode::NonRecursive`). What `chokidar`
 * would add on top is a recursive walk, a `stat` cache and a polling fallback
 * — three things this module already does differently, because the truth it
 * publishes is a re-read hash rather than the event itself, and because the
 * fallback here is an explicit `unsupported` answer the client polls with
 * `GET …/file-version` rather than a silent poll nobody can see. A dependency
 * whose features are all either unused or already replaced is a dependency
 * that only adds a second opinion about what a change is. `fs.watch` maps
 * straight onto inotify, FSEvents and ReadDirectoryChangesW, which is what
 * `notify` does too.
 */

/**
 * How long a burst of filesystem events is collected before it becomes one
 * workspace event. The window runs from the first event of the burst and is
 * not extended by later ones, so a file written continuously still reports.
 */
export const SETTLE_MS = 120;

export interface FileVersion {
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly size: number | null;
  /** RFC 3339, or `null` when the platform does not report one. */
  readonly mtime: string | null;
}

/** Device + inode on unix; only used to tell `modified` from `replaced`. */
type Identity = string | undefined;

interface KnownVersion extends FileVersion {
  readonly identity: Identity;
}

export type WatchStatus = "watching" | "unsupported";
export type WatchMode = "events" | "poll";

export interface WatchRegistration {
  readonly status: WatchStatus;
  /** Why watching is unavailable. Absent when `status === "watching"`. */
  readonly reason?: string;
  readonly mode: WatchMode;
  readonly version: FileVersion;
}

/* ------------------------------- version read ---------------------------- */

/**
 * `chrono::DateTime::<Utc>::from(time).to_rfc3339()`.
 *
 * A numeric `+00:00` offset rather than `Z`, which is what `chrono` writes and
 * what the front end's schema accepts. The fraction is milliseconds here and
 * nanoseconds there; nothing compares two of these for equality — the editor
 * shows the value and the change decision is made on the hash.
 */
function timestamp(at: Date): string | null {
  const time = at.getTime();
  if (!Number.isFinite(time)) return null;
  return `${at.toISOString().slice(0, -1)}+00:00`;
}

function identityOf(info: import("node:fs").Stats): Identity {
  // Windows does not hand out a cheap stable file id here, so a replace is
  // reported as `modified` rather than guessed at.
  if (process.platform === "win32") return undefined;
  return `${info.dev}:${info.ino}`;
}

/** Read the current version of an already-resolved absolute path. */
function readVersion(relative: string, path: string): KnownVersion {
  const gone: KnownVersion = {
    path: relative,
    exists: false,
    sha256: null,
    size: null,
    mtime: null,
    identity: undefined,
  };
  const info = symlinkMetadata(path);
  if (info === undefined) return gone;
  // A regular file that turned into a link or a directory is not the file the
  // editor opened. Reporting it as gone is both true and safe.
  if (info.isSymbolicLink() || !info.isFile()) return gone;
  // A read that fails is not a removal: the Rust version drops the event and
  // lets the next one answer, and so does `publishBurst` below.
  const bytes = readFileSync(path);
  // `sha256` is null for a file above the write limit: the editor refuses to
  // open those anyway, and hashing an arbitrarily large file on a watcher
  // callback is not something a canvas node should be able to ask for.
  const oversized = bytes.length > MAX_WRITE_FILE_SIZE;
  return {
    path: relative,
    exists: true,
    sha256: oversized ? null : sha256(bytes),
    size: info.size,
    mtime: timestamp(info.mtime),
    identity: identityOf(info),
  };
}

/** Strips the field the wire never carries. */
function published(version: KnownVersion): FileVersion {
  const { identity: _identity, ...rest } = version;
  return rest;
}

/**
 * `GET /api/workspaces/{id}/file-version` — the on-demand fallback when no
 * watcher is available, and what registration answers with.
 */
export function fileVersion(root: string, requested: string): FileVersion {
  const relative = workspaceRelativePath(requested);
  // Resolves the *parent* inside the root; the file itself may be gone.
  const path = resolveWritableInRoot(root, relative);
  return published(readVersion(relative, path));
}

/* --------------------------------- registry ------------------------------ */

interface WatchedFile {
  /** Editor node ids showing this file. The last one to leave unregisters it. */
  readonly viewers: Set<string>;
  readonly absolute: string;
  known: KnownVersion;
}

interface WatchedDirectory {
  readonly watcher: FSWatcher;
  count: number;
}

interface WorkspaceWatch {
  root: string;
  publish: (event: WorkspaceEvent) => void;
  /** Set once a backend failed; the workspace stays registered so the client
   * keeps getting an explicit `unsupported` answer. */
  reason?: string;
  watching: boolean;
  readonly directories: Map<string, WatchedDirectory>;
  readonly files: Map<string, WatchedFile>;
  touched: Set<string>;
  timer?: NodeJS.Timeout;
}

const WATCHES = new Map<string, WorkspaceWatch>();

/** What a domain hands in so a change can reach the workspace's subscribers. */
export type Publisher = (workspaceId: string, event: WorkspaceEvent) => void;

export interface RegisterOptions {
  /**
   * `false` simulates a platform without a usable watcher, so the degraded
   * answer is covered by a test instead of by hope.
   */
  readonly backendAvailable?: boolean;
}

/** Register `requested` as open in `nodeId`. Idempotent per viewer. */
export function register(
  workspaceId: string,
  root: string,
  requested: string,
  nodeId: string,
  publish: Publisher,
  options: RegisterOptions = {},
): WatchRegistration {
  if (nodeId === "" || nodeId.length > 128) {
    throw badRequest("A node id is required");
  }
  const base = canonicalDirectory(root);
  const relative = workspaceRelativePath(requested);
  const absolute = resolveWritableInRoot(base, relative);
  const parent = dirname(absolute);
  const version = readVersion(relative, absolute);

  let entry = WATCHES.get(workspaceId);
  if (entry === undefined) {
    entry = {
      root: base,
      publish: (event) => publish(workspaceId, event),
      watching: true,
      directories: new Map(),
      files: new Map(),
      touched: new Set(),
    };
    WATCHES.set(workspaceId, entry);
  }
  // A workspace root cannot move under an id; if it somehow did, the old watch
  // is worthless.
  if (entry.root !== base) {
    closeDirectories(entry);
    entry.root = base;
    entry.reason = undefined;
    entry.watching = true;
    entry.files.clear();
  }
  entry.publish = (event) => publish(workspaceId, event);

  if (options.backendAvailable === false && entry.reason === undefined) {
    entry.watching = false;
    entry.reason = "This platform has no filesystem watcher available";
  }

  const existing = entry.files.get(relative);
  const file: WatchedFile = existing ?? {
    viewers: new Set<string>(),
    absolute,
    known: version,
  };
  const firstViewer = file.viewers.size === 0;
  file.viewers.add(nodeId);
  // A re-open re-baselines: whatever is on disk now is what the node shows.
  file.known = version;
  entry.files.set(relative, file);

  if (firstViewer && entry.watching) {
    const directory = entry.directories.get(parent);
    if (directory !== undefined) {
      directory.count += 1;
    } else {
      try {
        const watcher = watchPath(parent, (_event, name) => {
          collect(
            workspaceId,
            name === null ? parent : join(parent, name.toString()),
          );
        });
        watcher.on("error", () => {
          // A directory that goes away takes its watcher with it. The files
          // under it still answer `file-version`, and the removal itself
          // arrives as an event from whichever watcher is still live.
        });
        watcher.unref();
        entry.directories.set(parent, { watcher, count: 1 });
      } catch (error) {
        entry.reason = `The filesystem watcher rejected this folder: ${
          error instanceof Error ? error.message : String(error)
        }`;
        entry.watching = false;
        closeDirectories(entry);
      }
    }
  }

  return entry.watching
    ? {
        status: "watching",
        // Local files are always watched by the platform when they are watched
        // at all; there is no polling mode on this side.
        mode: "events",
        version: published(version),
      }
    : {
        status: "unsupported",
        reason:
          entry.reason ?? "This platform has no filesystem watcher available",
        mode: "events",
        version: published(version),
      };
}

/**
 * Drop one viewer. The file stops being watched when the last one is gone, and
 * the workspace's watcher is released with its last file.
 */
export function unregister(
  workspaceId: string,
  requested: string,
  nodeId: string,
): void {
  const relative = workspaceRelativePath(requested);
  const entry = WATCHES.get(workspaceId);
  if (entry === undefined) return;
  const file = entry.files.get(relative);
  if (file === undefined) return;
  file.viewers.delete(nodeId);
  if (file.viewers.size > 0) return;
  const parent = dirname(file.absolute);
  entry.files.delete(relative);
  const directory = entry.directories.get(parent);
  if (directory !== undefined) {
    directory.count -= 1;
    if (directory.count === 0) {
      entry.directories.delete(parent);
      directory.watcher.close();
    }
  }
  if (entry.files.size === 0) release(workspaceId);
}

/**
 * Which files a workspace currently has open, for the execution-host switch:
 * an editor holding an unsaved view of a path on the old machine is exactly
 * the kind of thing that must be closed before the workspace moves.
 */
export function watchedPaths(workspaceId: string): string[] {
  return [...(WATCHES.get(workspaceId)?.files.keys() ?? [])].sort();
}

/**
 * Stop watching a whole workspace: read access revoked, workspace removed, or
 * the core shutting down.
 */
export function releaseWorkspace(workspaceId: string): void {
  release(workspaceId);
}

/** Release every watcher. Called on core shutdown. */
export function shutdown(): void {
  for (const id of [...WATCHES.keys()]) release(id);
}

function release(workspaceId: string): void {
  const entry = WATCHES.get(workspaceId);
  if (entry === undefined) return;
  closeDirectories(entry);
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  WATCHES.delete(workspaceId);
}

function closeDirectories(entry: WorkspaceWatch): void {
  for (const directory of entry.directories.values()) directory.watcher.close();
  entry.directories.clear();
}

/**
 * Record the hash a local write is about to publish. Called from
 * `writeTextFile` *before* the atomic replace, so the filesystem event that
 * follows can never be mistaken for an external edit.
 */
export function noteWrite(absolute: string, hash: string): void {
  for (const workspace of WATCHES.values()) {
    for (const file of workspace.files.values()) {
      if (file.absolute !== absolute) continue;
      file.known = {
        ...file.known,
        exists: true,
        sha256: hash.toLowerCase(),
        // The identity is unknown until the replace lands; leaving it stale
        // would only ever downgrade `replaced` to `modified`, and the hash
        // comparison already suppresses the event.
        identity: undefined,
      };
    }
  }
}

/* ------------------------------- watcher loop ---------------------------- */

function collect(workspaceId: string, path: string): void {
  const entry = WATCHES.get(workspaceId);
  if (entry === undefined) return;
  entry.touched.add(path);
  if (entry.timer !== undefined) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    const touched = entry.touched;
    entry.touched = new Set();
    publishBurst(workspaceId, touched);
  }, SETTLE_MS);
  entry.timer.unref();
}

/**
 * Compare every registered file the burst could have touched against what the
 * canvas last saw, and publish the difference.
 */
function publishBurst(workspaceId: string, touched: ReadonlySet<string>): void {
  const entry = WATCHES.get(workspaceId);
  if (entry === undefined) return;
  const changes: WorkspaceEvent[] = [];
  for (const [relative, file] of entry.files) {
    // Backends report either the file or the folder that contains it.
    if (!touched.has(file.absolute) && !touched.has(dirname(file.absolute))) {
      continue;
    }
    let current: KnownVersion;
    try {
      current = readVersion(relative, file.absolute);
    } catch {
      continue;
    }
    // Content is what the editor holds; an identical rewrite is not a change
    // the user has to answer for.
    if (
      current.exists === file.known.exists &&
      current.sha256 === file.known.sha256
    ) {
      file.known = current;
      continue;
    }
    const kind: "modified" | "removed" | "replaced" = !current.exists
      ? "removed"
      : !file.known.exists
        ? "replaced"
        : current.identity !== undefined &&
            file.known.identity !== undefined &&
            current.identity !== file.known.identity
          ? "replaced"
          : "modified";
    changes.push({
      type: "file.changed",
      workspaceId,
      path: relative,
      kind,
      sha256: current.sha256,
      size: current.size,
      mtime: current.mtime,
    });
    file.known = current;
  }
  for (const change of changes) entry.publish(change);
}
