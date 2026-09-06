import * as React from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import type { Position } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { canEditCanvas, useCanvasOwnership } from "@/canvas-ownership";
import { isCanvasLocked } from "../../canvas-lock";
import { getTool } from "../../interaction/tool-store";
import { snapToGrid } from "./grid";
import { addItems, createItemId, select } from "../store";
import { textItemAt } from "./draft";

/**
 * 空白处双击 = 新建一条文字对象并直接进编辑（2026-09-06 用户反馈）。
 *
 * 双击那一下本来归 React Flow 的 `zoomOnDoubleClick`；`flow/flow-options.ts`
 * 把它关掉之后这一下就空着，而「双击空白开始打字」是白板上最常用的一条
 * 路径，所以在这里接回来。偏好里不再暴露「双击缩放」——一下只能干一件事。
 *
 * 只认**画布空白**：`event.target` 必须正好是 `.react-flow__pane` 本身。
 * 节点、白板对象、连线、浮层、节点体里的输入框都不是它，所以它们各自的
 * 双击（`InlineText` 的进入编辑、编辑器里的选词）一个都不受影响。
 *
 * 只在选择工具下生效：绘图工具的双击是两笔各自的起手，不该再多出一条
 * 文字；手形工具的双击是两次平移。
 */
export function useDoubleClickText(): void {
  const flow = useReactFlow();
  const store = useStoreApi();
  const preferences = usePreferencesStore((state) => state.whiteboard);
  const ownership = useCanvasOwnership((state) => state.status);
  const editable = canEditCanvas(ownership);

  // 回调里要读最新的值，但 effect 不该因为改了一次网格间距就重挂。
  const latest = React.useRef({ preferences, editable });
  latest.current = { preferences, editable };

  React.useEffect(() => {
    const dom = store.getState().domNode;
    if (!dom) return;

    const onDoubleClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.classList.contains("react-flow__pane")) return;
      const active = latest.current;
      if (getTool() !== "select") return;
      if (isCanvasLocked() || !active.editable) return;
      event.preventDefault();
      const at: Position = snapToGrid(
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        active.preferences.gridSize,
        active.preferences.snap,
      );
      const item = textItemAt(at, createItemId());
      addItems([item]);
      // 选中 + 空文本 = `TextNode` 的 `autoEdit`，光标直接落在里面。
      select([item.id]);
    };

    dom.addEventListener("dblclick", onDoubleClick);
    return () => dom.removeEventListener("dblclick", onDoubleClick);
  }, [flow, store]);
}
