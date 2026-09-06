import * as React from "react";
import {
  experimental_useOnNodesChangeMiddleware,
  type NodeChange,
} from "@xyflow/react";

import { isItemId } from "../model";
import { beginGesture, endGesture, moveItems } from "../store";
import type { CanvasFlowNode } from "../../sync/project";

/**
 * 拖动白板对象（React Flow 计划 §2.1 规则 2，归属 whiteboard）。
 *
 * 节点的拖动由 `flow/use-flow-nodes.ts` 接：进行中写 `flow/drafts.ts`，
 * 松手调 `moveNodes`。白板对象走不了那条路——投影 `wb.*` 时不读草稿——
 * 所以这里挂 React Flow 的**节点变更中间件**（`updateNodePositions` 唯一
 * 的扩展点），把 `wb:` 开头的位置变更直接写进白板文档。
 *
 * 受控画布里位置变更**不会**改 React Flow 自己的 `nodeLookup`，所以每一帧
 * 都得真的写文档，否则对象根本不动。写一帧记一条历史显然不行，于是整段
 * 拖动包在一个合并会话里（`beginGesture` / `endGesture`），松手按一下 ⌘Z
 * 整块回原位。
 *
 * 中间件原样把 `changes` 传下去：B0 的 `onNodesChange` 只认「选中」，位置
 * 变更到它那里会被忽略，两边不打架。
 */

interface PositionChange {
  id: string;
  position?: { x: number; y: number };
  dragging?: boolean;
}

export function useItemDrag(): void {
  const open = React.useRef(false);

  const middleware = React.useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      let dragging = false;
      for (const change of changes) {
        if (change.type !== "position") continue;
        const move = change as PositionChange;
        if (!isItemId(move.id) || !move.position) continue;
        if (move.dragging) dragging = true;
        moves.push({ id: move.id, position: move.position });
      }
      if (moves.length === 0) return changes;
      if (dragging && !open.current) {
        open.current = true;
        beginGesture("whiteboard.move");
      }
      moveItems(moves);
      if (!dragging && open.current) {
        open.current = false;
        endGesture();
      }
      return changes;
    },
    [],
  );

  experimental_useOnNodesChangeMiddleware(middleware);

  // 拖到一半卸载（换画布、关窗口）时把合并会话关掉，否则下一次编辑会被
  // 并进这一条里。
  React.useEffect(
    () => () => {
      if (open.current) {
        open.current = false;
        endGesture();
      }
    },
    [],
  );
}
