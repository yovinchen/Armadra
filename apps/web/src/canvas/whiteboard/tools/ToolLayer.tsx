import * as React from "react";
import { useStoreApi } from "@xyflow/react";

import { usePreferencesStore } from "@/app/preferences-store";
import { setDefaultStyle, useTool } from "../../interaction/tool-store";
import { trackPointer } from "../../interaction/pointer";
import { DraftPreview } from "./DraftPreview";
import { useClipboardCommands } from "./use-clipboard";
import { useDoubleClickText } from "./use-double-click-text";
import { useItemDrag } from "./use-item-drag";
import { useToolPointer } from "./use-tool-pointer";

/**
 * 白板工具层（React Flow 计划 §5.3 的 `<ToolLayer />` 插槽，归属 whiteboard）。
 *
 * `FlowWorkspace` 只 import 这一个组件；工具、剪贴板、拖动桥接、光标全在
 * 这棵子树里，B0 的装配文件不用为白板层改任何东西。
 *
 * 它渲染的东西只有一样：进行中的图形（`<DraftPreview>`）。其余几件事都是
 * 副作用——指针通道、拖动落位、剪贴板命令、空白处双击建文字、粘贴落点的
 * 指针记录。
 */

/**
 * 工具 → 画布上的光标。
 *
 * 手形不在表里：它的平移归 React Flow（`flow-options.panOnDrag` 含 0），
 * 抓 / 攥的两态由 React Flow 自己的 `.react-flow__pane.draggable`
 * 与 `.dragging` 给，容器上再压一层反而会盖掉「按住时攥紧」那一半。
 */
const CURSORS: Record<string, string> = {
  select: "",
  draw: "crosshair",
  highlight: "crosshair",
  geo: "crosshair",
  line: "crosshair",
  arrow: "crosshair",
  text: "text",
  frame: "crosshair",
};

export function ToolLayer() {
  const tool = useTool();
  const store = useStoreApi();
  const { draft } = useToolPointer();

  useItemDrag();
  useClipboardCommands();
  useDoubleClickText();
  useDefaultStyle();

  // 光标写在 React Flow 的容器上：铺一层透明覆盖层只为了换光标，会顺带
  // 把滚轮缩放和节点的 hover 一起挡掉。
  React.useEffect(() => {
    const dom = store.getState().domNode;
    if (!dom) return;
    dom.style.cursor = CURSORS[tool] ?? "";
    return () => {
      dom.style.cursor = "";
    };
  }, [store, tool]);

  // 「粘贴到光标处」要知道鼠标最后停在哪（§2.8）。
  React.useEffect(() => {
    const dom = store.getState().domNode;
    return dom ? trackPointer(dom) : undefined;
  }, [store]);

  return <DraftPreview draft={draft} />;
}

/**
 * 「默认颜色 / 粗细」偏好 → 下一个对象的样式（§2.10）。
 *
 * 单向：偏好改了就推一次。样式面板改的是 `nextStyle`，不写回偏好——
 * 否则「这一笔想画红的」会永久改掉默认值。
 */
function useDefaultStyle(): void {
  const color = usePreferencesStore((state) => state.whiteboard.defaultColor);
  const size = usePreferencesStore((state) => state.whiteboard.defaultSize);
  React.useEffect(() => {
    setDefaultStyle({ color, size });
  }, [color, size]);
}

export default ToolLayer;
