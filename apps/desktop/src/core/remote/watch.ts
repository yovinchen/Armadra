/**
 * 远端工作空间的文件监听：Worker 那边的平台 watcher 推变化，推不了时控制端轮询。
 *
 * 首选**推送**：登记的文件整组交给 Worker（`files.watch`，按工作空间一组），
 * Worker 看着父目录，内容变了就推一帧 `files.changed`（`watch-worker.ts`），这里
 * 与上次看到的比较后发与本机相同的 `file.changed`。注册的答复写 `mode: events`。
 *
 * **轮询**是退路，两种情况用它：
 *
 *  * Worker 不认 `files.watch`（更旧的构建）——每 {@link POLL_MS} 批量问一次版本，
 *    答复写 `mode: poll`，编辑器显示「轮询」徽标；
 *  * 连接断了——推送的前提是连接活着，而连接只在有请求时重建。断线后先退回轮询，
 *    轮询的请求把连接拉起来，握手成功时（`connected`）整组重登并比对一次版本，
 *    补上断线期间错过的变化，然后停掉轮询。
 *
 * 一次读取失败（主机断开、Worker 重启）不算文件被删：什么都不发，等下一次。
 */

import type { WorkspaceEvent } from "../bus";
import type { FileVersion, WatchRegistration } from "../files/watch";
import { workspaceRelativePath } from "../workspaces/roots";
import { badRequest } from "../workspaces/support";
import { type ExecutionTarget, executeOn, listenRemote } from "./execute";

/** 两次询问之间的间隔。 */
export const POLL_MS = 2_000;

type Publisher = (workspaceId: string, event: WorkspaceEvent) => void;

interface WatchedFile {
  readonly viewers: Set<string>;
  known: FileVersion;
}

interface WorkspaceWatch {
  target: ExecutionTarget;
  publish: Publisher;
  readonly files: Map<string, WatchedFile>;
  timer: NodeJS.Timeout | undefined;
  polling: boolean;
  /** `events`：Worker 在推；`poll`：这里在问。 */
  mode: "events" | "poll";
  /** 一次整组重登在路上时，后来的改动只记一笔，等它回来再发一次。 */
  syncing: Promise<void> | undefined;
  resync: boolean;
}

function hostOf(target: ExecutionTarget): string {
  return target.executionHostId ?? "";
}

export class RemoteWatches {
  private readonly watches = new Map<string, WorkspaceWatch>();
  private readonly unlisten: () => void;

  constructor(private readonly intervalMs: number = POLL_MS) {
    this.unlisten = listenRemote({
      event: (hostId, channel, event) => {
        if (channel !== "control" || event.type !== "files.changed") return;
        const workspaceId =
          typeof event.watchId === "string" ? event.watchId : "";
        const entry = this.watches.get(workspaceId);
        if (entry === undefined || hostOf(entry.target) !== hostId) return;
        if (typeof event.path !== "string") return;
        const version = event.version as FileVersion | undefined;
        if (version === undefined) return;
        this.observe(workspaceId, entry, event.path, version);
      },
      connected: (hostId, channel) => {
        if (channel !== "control") return;
        for (const [workspaceId, entry] of this.watches) {
          if (hostOf(entry.target) === hostId) {
            void this.sync(workspaceId, entry);
          }
        }
      },
      disconnected: (hostId, channel) => {
        if (channel !== "control") return;
        for (const [workspaceId, entry] of this.watches) {
          if (hostOf(entry.target) !== hostId) continue;
          entry.mode = "poll";
          this.arm(workspaceId, entry);
        }
      },
    });
  }

  async register(
    target: ExecutionTarget,
    workspaceId: string,
    requested: string,
    nodeId: string,
    publish: Publisher,
  ): Promise<WatchRegistration> {
    if (nodeId === "" || nodeId.length > 128) {
      throw badRequest("A node id is required");
    }
    const relative = workspaceRelativePath(requested);
    const version = (await executeOn(target, "files.version", {
      path: relative,
    })) as FileVersion;
    let entry = this.watches.get(workspaceId);
    if (entry === undefined) {
      entry = {
        target,
        publish,
        files: new Map(),
        timer: undefined,
        polling: false,
        mode: "poll",
        syncing: undefined,
        resync: false,
      };
      this.watches.set(workspaceId, entry);
    }
    // 换了主机或根，之前记下的版本都是另一处的，不能拿来比。
    if (
      entry.target.rootPath !== target.rootPath ||
      hostOf(entry.target) !== hostOf(target)
    ) {
      entry.files.clear();
    }
    entry.target = target;
    entry.publish = publish;
    const file = entry.files.get(relative) ?? {
      viewers: new Set<string>(),
      known: version,
    };
    file.viewers.add(nodeId);
    // 重新打开即重新取基线：此刻磁盘上的就是节点显示的。
    file.known = version;
    entry.files.set(relative, file);
    await this.sync(workspaceId, entry);
    return {
      status: "watching",
      mode: entry.mode,
      version,
    };
  }

  unregister(workspaceId: string, requested: string, nodeId: string): void {
    const entry = this.watches.get(workspaceId);
    if (entry === undefined) return;
    let relative: string;
    try {
      relative = workspaceRelativePath(requested);
    } catch {
      return;
    }
    const file = entry.files.get(relative);
    if (file === undefined) return;
    file.viewers.delete(nodeId);
    if (file.viewers.size === 0) entry.files.delete(relative);
    if (entry.files.size === 0) this.releaseWorkspace(workspaceId);
    else if (entry.mode === "events") void this.sync(workspaceId, entry);
  }

  releaseWorkspace(workspaceId: string): void {
    const entry = this.watches.get(workspaceId);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearInterval(entry.timer);
    entry.timer = undefined;
    this.watches.delete(workspaceId);
    if (entry.mode === "events") {
      // 尽力而为：连接已经断了的话，那边的 watcher 已随 Worker 一起没了。
      void executeOn(entry.target, "files.unwatch", {
        watchId: workspaceId,
      }).catch(() => undefined);
    }
  }

  watchedPaths(workspaceId: string): string[] {
    return [...(this.watches.get(workspaceId)?.files.keys() ?? [])];
  }

  /** 这个工作空间现在是推送还是轮询；没有登记是 `undefined`。给测试与诊断。 */
  modeOf(workspaceId: string): "events" | "poll" | undefined {
    return this.watches.get(workspaceId)?.mode;
  }

  shutdown(): void {
    for (const id of [...this.watches.keys()]) this.releaseWorkspace(id);
  }

  /** 停止订阅远端事件；只在测试里造了自己的一份时用。 */
  dispose(): void {
    this.shutdown();
    this.unlisten();
  }

  /**
   * 把整组交给 Worker 并比对它答的当前版本。成功即推送模式、停轮询；Worker 不认
   * 或连接不通就退回轮询。
   */
  private async sync(
    workspaceId: string,
    entry: WorkspaceWatch,
  ): Promise<void> {
    if (entry.syncing !== undefined) {
      entry.resync = true;
      await entry.syncing;
      return;
    }
    entry.syncing = (async () => {
      do {
        entry.resync = false;
        const paths = [...entry.files.keys()];
        if (paths.length === 0) return;
        try {
          const answered = (await executeOn(entry.target, "files.watch", {
            watchId: workspaceId,
            paths,
          })) as { versions?: (FileVersion | null)[] };
          if (this.watches.get(workspaceId) !== entry) return;
          entry.mode = "events";
          if (entry.timer !== undefined) clearInterval(entry.timer);
          entry.timer = undefined;
          paths.forEach((relative, index) => {
            const current = answered.versions?.[index];
            if (current !== undefined && current !== null) {
              this.observe(workspaceId, entry, relative, current);
            }
          });
        } catch {
          if (this.watches.get(workspaceId) !== entry) return;
          entry.mode = "poll";
          this.arm(workspaceId, entry);
          return;
        }
      } while (entry.resync);
    })().finally(() => {
      entry.syncing = undefined;
    });
    await entry.syncing;
  }

  private arm(workspaceId: string, entry: WorkspaceWatch): void {
    if (entry.timer !== undefined) return;
    entry.timer = setInterval(() => {
      void this.poll(workspaceId);
    }, this.intervalMs);
    entry.timer.unref?.();
  }

  /** 与记下的版本比较，变了就发 `file.changed`。 */
  private observe(
    workspaceId: string,
    entry: WorkspaceWatch,
    relative: string,
    current: FileVersion,
  ): void {
    const file = entry.files.get(relative);
    if (file === undefined) return;
    if (
      current.exists === file.known.exists &&
      current.sha256 === file.known.sha256
    ) {
      file.known = current;
      return;
    }
    // 远端答的是版本不是 inode，替换与修改分不开；只有「原来没有」才算替换。
    const kind: "modified" | "removed" | "replaced" = !current.exists
      ? "removed"
      : !file.known.exists
        ? "replaced"
        : "modified";
    file.known = current;
    entry.publish(workspaceId, {
      type: "file.changed",
      workspaceId,
      path: relative,
      kind,
      sha256: current.sha256,
      size: current.size,
      mtime: current.mtime,
    });
  }

  /** 问一轮；上一轮还没回来就跳过，慢主机不会被请求堆满。 */
  async poll(workspaceId: string): Promise<void> {
    const entry = this.watches.get(workspaceId);
    if (entry === undefined || entry.polling) return;
    entry.polling = true;
    try {
      const paths = [...entry.files.keys()];
      if (paths.length === 0) return;
      let versions: (FileVersion | null)[];
      try {
        versions = (await executeOn(entry.target, "files.versions", {
          paths,
        })) as (FileVersion | null)[];
      } catch {
        return;
      }
      if (this.watches.get(workspaceId) !== entry) return;
      paths.forEach((relative, index) => {
        const current = versions[index];
        if (current === undefined || current === null) return;
        this.observe(workspaceId, entry, relative, current);
      });
    } finally {
      entry.polling = false;
    }
  }
}

/** core 里唯一的一份。 */
export const remoteWatches = new RemoteWatches();
