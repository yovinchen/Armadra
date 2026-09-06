import type {
  Board,
  BoardDocument,
  CanvasEdge,
  CanvasNode,
} from "@armadra/shared";

/**
 * 连续多少次 409 之后才放弃自动变基、给用户提示。
 *
 * 前两次静默重放（见 `replayLocalEdits`）：两个窗口同开一块板时，两边的
 * 自动保存本来就会互相撞上一两次，弹条「保存失败」只会让人以为坏了。
 */
export const MAX_CONFLICT_REPLAYS = 3;

/**
 * 保存冲突（409）后的变基：把本地这一轮还没落库的改动重放到最新文档上。
 *
 * 没有三方合并的基线，只有一个可靠的分界点——`local.board.updatedAt`，
 * 也就是本地这份文档最后一次与 Runtime 对齐时的 CAS 时间戳。任何
 * `createdAt` 晚于它的节点/边都不可能在服务端出现过，所以一定是本地新建的。
 *
 * 规则（旧画布契约 §6.1 的收尾项）：
 *
 * | 情况 | 结果 |
 * | --- | --- |
 * | 两边都有的节点 | **本地为准**（位置 / 尺寸 / 数据 / 标题都是用户刚拖出来的） |
 * | 只有远端有 | 保留（别的窗口或 Agent 新开的节点） |
 * | 只有本地有，且 `createdAt` 晚于本地 CAS 戳 | 保留（本地新建，还没存上） |
 * | 只有本地有，且 `createdAt` 早于本地 CAS 戳 | 丢弃（远端删掉了，不复活） |
 *
 * 边同理，另外再剔掉两端节点不齐的悬空边（Runtime 拒收）。画布行取远端的
 * （`updatedAt` 就是下一次 PUT 的 CAS 戳），只有视口 / 画布视图 / 白板快照
 * 用本地的：它们是这个窗口此刻的状态，而且白板快照下一次保存时本来就会
 * 从 editor 重新取一份。
 *
 * **已知局限**：白板原生 shape 不做合并，另一个窗口这段时间画的手绘会被
 * 本地快照盖掉。节点、连线、分组不受影响。
 */
export function replayLocalEdits(
  remote: BoardDocument,
  local: BoardDocument,
): BoardDocument {
  const since = Date.parse(local.board.updatedAt);
  const bornLocally = (createdAt: string) =>
    Number.isNaN(since) || Date.parse(createdAt) > since;

  const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
  const remoteIds = new Set(remote.nodes.map((node) => node.id));

  const nodes: CanvasNode[] = remote.nodes.map(
    (node) => localNodes.get(node.id) ?? node,
  );
  for (const node of local.nodes) {
    if (remoteIds.has(node.id)) continue;
    if (bornLocally(node.createdAt)) nodes.push(node);
  }

  // 组员的父级可能刚被远端删掉：留着 `parentId` 会指向不存在的分组。
  const alive = new Set(nodes.map((node) => node.id));
  const reparented = nodes.map((node) =>
    node.parentId && !alive.has(node.parentId)
      ? { ...node, parentId: undefined }
      : node,
  );

  const localEdges = new Map(local.edges.map((edge) => [edge.id, edge]));
  const remoteEdgeIds = new Set(remote.edges.map((edge) => edge.id));
  const edges: CanvasEdge[] = remote.edges.map(
    (edge) => localEdges.get(edge.id) ?? edge,
  );
  for (const edge of local.edges) {
    if (remoteEdgeIds.has(edge.id)) continue;
    if (bornLocally(edge.createdAt)) edges.push(edge);
  }

  return {
    board: {
      ...remote.board,
      viewport: local.board.viewport,
      whiteboard: local.board.whiteboard,
    },
    nodes: reparented,
    edges: edges.filter(
      (edge) => alive.has(edge.source) && alive.has(edge.target),
    ),
  };
}

/**
 * 画布保存队列 —— 单飞 + CAS 变基。
 *
 * `PUT /document` 是整份文档替换 + `expectedUpdatedAt` 乐观锁，所以两条
 * 保存不能并发：第二条一定会拿着过期的时间戳被拒。这里让每块画布最多留
 * 一份待保存快照，飞行中的编辑折叠成最新的一份。
 */

/**
 * 保存原因。`viewport` 是平移/缩放触发的静默保存：Dock 上的保存指示灯
 * 不该因为用户拖了一下画布就闪一次（§3.2：平移不是编辑）。
 */
export type SaveReason = "edit" | "viewport";

interface PendingSave {
  workspaceId: string;
  boardId: string;
  document: BoardDocument;
  reason: SaveReason;
}

function keyOf(workspaceId: string, boardId: string): string {
  return `${workspaceId}:${boardId}`;
}

export class CanvasSaveQueue {
  private pending = new Map<string, PendingSave>();
  private running: Promise<void> | null = null;
  private waiters: Array<{
    resolve: () => void;
    reject: (cause: unknown) => void;
  }> = [];

  constructor(
    private readonly save: (
      workspaceId: string,
      boardId: string,
      document: BoardDocument,
    ) => Promise<BoardDocument>,
    private readonly onSaved: (
      workspaceId: string,
      boardId: string,
      source: BoardDocument,
      saved: BoardDocument,
      reason: SaveReason,
    ) => void,
    private readonly onError: (
      workspaceId: string,
      boardId: string,
      cause: unknown,
      reason: SaveReason,
    ) => void,
  ) {}

  enqueue(
    workspaceId: string,
    boardId: string,
    document: BoardDocument,
    reason: SaveReason = "edit",
  ): Promise<void> {
    const key = keyOf(workspaceId, boardId);
    const previous = this.pending.get(key);
    this.pending.set(key, {
      workspaceId,
      boardId,
      document,
      // 编辑压过平移：只要这一轮里有过真实编辑，回调就按编辑处理。
      reason: previous?.reason === "edit" ? "edit" : reason,
    });
    const completion = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (!this.running) this.running = this.drain();
    return completion;
  }

  /** 平移/缩放后的静默保存；PUT 的仍然是整份文档（服务端没有单独的视口路由）。 */
  saveViewport(
    workspaceId: string,
    boardId: string,
    document: BoardDocument,
  ): Promise<void> {
    return this.enqueue(workspaceId, boardId, document, "viewport");
  }

  async flush(): Promise<void> {
    while (this.running) await this.running;
  }

  clear(workspaceId?: string, boardId?: string) {
    if (!workspaceId) {
      this.pending.clear();
      return;
    }
    if (boardId) {
      this.pending.delete(keyOf(workspaceId, boardId));
      return;
    }
    for (const [key, entry] of this.pending) {
      if (entry.workspaceId === workspaceId) this.pending.delete(key);
    }
  }

  /**
   * 保存成功后 Runtime 会给回一个更新过的 `updatedAt`；排队中的快照必须
   * 采纳它，否则下一次 PUT 的 CAS 一定失败。
   */
  rebasePending(workspaceId: string, boardId: string, board: Board) {
    const key = keyOf(workspaceId, boardId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.set(key, {
      ...entry,
      document: { ...entry.document, board },
    });
  }

  private take(): PendingSave | null {
    const next = this.pending.entries().next();
    if (next.done) return null;
    this.pending.delete(next.value[0]);
    return next.value[1];
  }

  private async drain() {
    let failure: unknown;
    try {
      for (let current = this.take(); current; current = this.take()) {
        try {
          const saved = await this.save(
            current.workspaceId,
            current.boardId,
            current.document,
          );
          this.onSaved(
            current.workspaceId,
            current.boardId,
            current.document,
            saved,
            current.reason,
          );
        } catch (cause) {
          failure = cause;
          this.onError(
            current.workspaceId,
            current.boardId,
            cause,
            current.reason,
          );
          break;
        }
      }
    } finally {
      const waiters = this.waiters.splice(0);
      this.running = null;
      if (failure) waiters.forEach(({ reject }) => reject(failure));
      else waiters.forEach(({ resolve }) => resolve());
      if (this.pending.size > 0 && !failure) this.running = this.drain();
    }
  }
}
