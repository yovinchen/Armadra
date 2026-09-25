/**
 * 远端工作空间的文件监听：控制端按间隔向 Worker 问版本。
 *
 * 本机监听靠平台 watcher；另一台机器上的文件没有 watcher 能伸过去，而让
 * Worker 主动推事件需要连接上的订阅协议（设计 §3.4），这个构建还没有。所以
 * 这里是基线方案：登记的文件每 {@link POLL_MS} 批量问一次版本，和上次看到的
 * 比较，变了就发与本机相同的 `file.changed` 帧。注册的答复写明 `mode: poll`，
 * 编辑器据此显示「轮询」徽标。
 *
 * 一次轮询失败（主机断开、Worker 重启）不算文件被删：什么都不发，等下一次。
 */

import type { WorkspaceEvent } from "../bus";
import type { FileVersion, WatchRegistration } from "../files/watch";
import { workspaceRelativePath } from "../workspaces/roots";
import { badRequest } from "../workspaces/support";
import { type ExecutionTarget, executeOn } from "./execute";

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
}

export class RemoteWatches {
  private readonly watches = new Map<string, WorkspaceWatch>();

  constructor(private readonly intervalMs: number = POLL_MS) {}

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
      };
      this.watches.set(workspaceId, entry);
    }
    // 换了主机或根，之前记下的版本都是另一处的，不能拿来比。
    if (
      entry.target.rootPath !== target.rootPath ||
      (entry.target.executionHostId ?? "") !== (target.executionHostId ?? "")
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
    this.arm(workspaceId, entry);
    return {
      status: "watching",
      mode: "poll",
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
  }

  releaseWorkspace(workspaceId: string): void {
    const entry = this.watches.get(workspaceId);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearInterval(entry.timer);
    this.watches.delete(workspaceId);
  }

  watchedPaths(workspaceId: string): string[] {
    return [...(this.watches.get(workspaceId)?.files.keys() ?? [])];
  }

  shutdown(): void {
    for (const id of [...this.watches.keys()]) this.releaseWorkspace(id);
  }

  private arm(workspaceId: string, entry: WorkspaceWatch): void {
    if (entry.timer !== undefined) return;
    entry.timer = setInterval(() => {
      void this.poll(workspaceId);
    }, this.intervalMs);
    entry.timer.unref?.();
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
        const file = entry.files.get(relative);
        if (current === undefined || current === null || file === undefined) {
          return;
        }
        if (
          current.exists === file.known.exists &&
          current.sha256 === file.known.sha256
        ) {
          file.known = current;
          return;
        }
        // 轮询看不到 inode，替换与修改分不开；只有「原来没有」才算替换。
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
      });
    } finally {
      entry.polling = false;
    }
  }
}

/** core 里唯一的一份。 */
export const remoteWatches = new RemoteWatches();
