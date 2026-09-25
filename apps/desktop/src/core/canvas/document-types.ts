import type { Board, Viewport } from "./boards";

/**
 * The document shapes, in the spelling that goes on the wire.
 *
 * Kept apart from the queries so `validation.ts` can be read — and tested —
 * without a database. The optional keys are optional on the wire too: serde
 * skips `size`, `collapsed`, `expandedHeight` and `parentId` when they are
 * absent, and the shared zod schema expects them missing rather than `null`.
 */

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Canvas node v3 — `title` and `color` live on the node, not inside `data`;
 * `status` is the `agent_status` table's and `zoom` is gone entirely.
 */
export interface CanvasNode {
  readonly id: string;
  readonly boardId: string;
  readonly type: string;
  readonly title: string;
  readonly color: string;
  readonly position: Position;
  readonly size?: Size;
  readonly collapsed?: boolean;
  readonly expandedHeight?: number;
  /** Id of the `group` node this node belongs to. */
  readonly parentId?: string;
  /**
   * `+ Label` chips. Always serialised — the shared schema defaults it, but a
   * client that reads `node.labels.length` should not have to guard against
   * the key being missing.
   */
  readonly labels: readonly string[];
  /** Header comment. Empty string, never null, for the same reason. */
  readonly note: string;
  readonly data: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Only context links are persisted; rope and subagent edges are derived per
 * frame by the canvas and never stored.
 */
export interface CanvasEdge {
  readonly id: string;
  readonly boardId: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  /**
   * 对等还是主从（迁移 0024）。
   *
   *   * `peer` —— 两端对等。人在画布上拉一条线的默认，也是 `canvas link` 的
   *     默认，以及**所有 0024 之前已经存在的边**的含义。
   *   * `supervises` —— 有方向：`source` 是主，`target` 是从。
   *
   * 授权读这个字段：主可以把文字打进从的终端（`send` / `interrupt`），从对主
   * 默认只能 `post`（`UPWARD_SEND_REFUSED`）。缺省当 `peer` 读。
   */
  readonly role?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BoardDocument {
  readonly board: Board;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

export interface SaveBoardRequest {
  readonly expectedUpdatedAt: string;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly viewport: Viewport;
  /** Omitting the snapshot preserves the stored whiteboard. */
  readonly whiteboard?: string | undefined;
  /**
   * 写者的 `clientId`（契约 §9.3）。只有 HTTP 那条路会带：core 自己的写者
   * （控制动词、调度、依赖编排）不经过编辑租约。
   */
  readonly clientId?: string | undefined;
}
