import type { Board, BoardDocument } from "@ai-coding-canvas/shared";

interface PendingSave {
  workspaceId: string;
  boardId: string;
  document: BoardDocument;
}

function keyOf(workspaceId: string, boardId: string): string {
  return `${workspaceId}:${boardId}`;
}

/**
 * Serializes board saves. Each board keeps at most one pending document, so a
 * burst of edits collapses to the latest snapshot while a save is in flight,
 * and two open boards never overwrite each other's pending state.
 */
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
    ) => void,
    private readonly onError: (
      workspaceId: string,
      boardId: string,
      cause: unknown,
    ) => void,
  ) {}

  enqueue(
    workspaceId: string,
    boardId: string,
    document: BoardDocument,
  ): Promise<void> {
    this.pending.set(keyOf(workspaceId, boardId), {
      workspaceId,
      boardId,
      document,
    });
    const completion = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (!this.running) this.running = this.drain();
    return completion;
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
   * After a successful save the runtime hands back a bumped `updatedAt`; the
   * queued snapshot must adopt it or the next PUT loses the CAS check.
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
          );
        } catch (cause) {
          failure = cause;
          this.onError(current.workspaceId, current.boardId, cause);
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
