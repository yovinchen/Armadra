/**
 * Worker 这一侧的文件监听：平台 watcher 看着被打开文件的父目录，变了就推一帧
 * `files.changed` 回控制端。
 *
 * 看父目录而不是文件本身：编辑器与格式化工具多半是「写临时文件再改名」，看着
 * 文件本身的 watcher 在改名那一刻就失效了。事件只当「该去看看」：真正是否变了
 * 以内容哈希为准（与本机 `files/watch.ts` 同一个判据），同一批事件合并成一次
 * 读取。
 *
 * 父目录不存在或 watcher 起不来时，那几个文件在 Worker 自己这里按
 * {@link FALLBACK_MS} 复查——仍是 Worker 推送，控制端不必为此另开轮询。
 */

import { type FSWatcher, watch } from "node:fs";
import { dirname, join } from "node:path";
import { type FileVersion, fileVersion } from "../files/watch";
import { canonicalDirectory, workspaceRelativePath } from "../workspaces/roots";
import type { WorkerSession } from "./session";

/** 同一目录一串事件合并成一次读取。 */
const SETTLE_MS = 75;

/** 看不了的目录里的文件多久复查一次。 */
export const FALLBACK_MS = 2_000;

interface WatchSet {
  readonly root: string;
  readonly known: Map<string, FileVersion | null>;
  readonly directories: Map<string, FSWatcher>;
  /** 父目录没能被看住的文件。 */
  readonly unwatched: Set<string>;
  readonly dirty: Set<string>;
  settle: NodeJS.Timeout | undefined;
  fallback: NodeJS.Timeout | undefined;
}

type Sets = Map<string, WatchSet>;

function sets(session: WorkerSession): Sets {
  return session.slot<Sets>(
    "files.watch",
    () => new Map(),
    (all) => {
      for (const set of all.values()) close(set);
      all.clear();
    },
  );
}

function close(set: WatchSet): void {
  for (const watcher of set.directories.values()) watcher.close();
  set.directories.clear();
  if (set.settle !== undefined) clearTimeout(set.settle);
  if (set.fallback !== undefined) clearInterval(set.fallback);
  set.settle = undefined;
  set.fallback = undefined;
}

function versionOf(root: string, relative: string): FileVersion | null {
  try {
    return fileVersion(root, relative);
  } catch {
    // 读不了不等于删了：这一次不比，等下一次事件。
    return null;
  }
}

function changed(before: FileVersion | null, after: FileVersion): boolean {
  if (before === null) return true;
  return before.exists !== after.exists || before.sha256 !== after.sha256;
}

/** 看一遍 `paths`，变了的推出去。 */
function check(
  session: WorkerSession,
  watchId: string,
  set: WatchSet,
  paths: Iterable<string>,
): void {
  for (const relative of paths) {
    if (!set.known.has(relative)) continue;
    const current = versionOf(set.root, relative);
    if (current === null) continue;
    const before = set.known.get(relative) ?? null;
    set.known.set(relative, current);
    if (!changed(before, current)) continue;
    session.publish({
      type: "files.changed",
      watchId,
      path: relative,
      version: current,
    });
  }
}

/**
 * 把 `watchId` 这一组替换成 `paths`，答每个文件此刻的版本（读不了的是 `null`），
 * 控制端拿它与自己记的比，补上断线期间错过的变化。
 */
export function watchFiles(
  session: WorkerSession,
  root: string,
  watchId: string,
  requested: readonly string[],
): { readonly mode: "events"; readonly versions: (FileVersion | null)[] } {
  const all = sets(session);
  const previous = all.get(watchId);
  if (previous !== undefined) close(previous);
  const base = canonicalDirectory(root);
  const set: WatchSet = {
    root: base,
    known: new Map(),
    directories: new Map(),
    unwatched: new Set(),
    dirty: new Set(),
    settle: undefined,
    fallback: undefined,
  };
  all.set(watchId, set);

  const relatives = requested.map((one) => workspaceRelativePath(one));
  const versions = relatives.map((relative) => {
    const version = versionOf(base, relative);
    set.known.set(relative, version);
    return version;
  });

  const byDirectory = new Map<string, string[]>();
  for (const relative of relatives) {
    const directory = dirname(join(base, relative));
    const list = byDirectory.get(directory) ?? [];
    list.push(relative);
    byDirectory.set(directory, list);
  }
  for (const [directory, files] of byDirectory) {
    try {
      const watcher = watch(directory, { persistent: false }, () => {
        for (const file of files) set.dirty.add(file);
        if (set.settle !== undefined) return;
        set.settle = setTimeout(() => {
          set.settle = undefined;
          const dirty = [...set.dirty];
          set.dirty.clear();
          check(session, watchId, set, dirty);
        }, SETTLE_MS);
        set.settle.unref?.();
      });
      // 目录被删时 watcher 随之报错；其下文件的删除由复查兜住。
      watcher.on("error", () => {
        watcher.close();
        set.directories.delete(directory);
        for (const file of files) set.unwatched.add(file);
      });
      set.directories.set(directory, watcher);
    } catch {
      for (const file of files) set.unwatched.add(file);
    }
  }
  set.fallback = setInterval(() => {
    if (set.unwatched.size > 0) check(session, watchId, set, set.unwatched);
  }, FALLBACK_MS);
  set.fallback.unref?.();
  return { mode: "events", versions };
}

export function unwatchFiles(
  session: WorkerSession,
  watchId: string,
): { readonly released: boolean } {
  const all = sets(session);
  const set = all.get(watchId);
  if (set === undefined) return { released: false };
  close(set);
  all.delete(watchId);
  return { released: true };
}
