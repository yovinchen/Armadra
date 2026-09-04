import {
  DefaultStylePanel,
  useEditor,
  useValue,
  type TLUiStylePanelProps,
} from "tldraw";

import { shouldShowStylePanel } from "./tools";

/**
 * 样式面板（§12 第 2 条：复用 tldraw 的实现，换肤已在 `styles/canvas.css`）。
 *
 * 这里只加一层显隐：tldraw 默认只要「选中了任何东西」就把面板亮出来，
 * 而我们的 `aicc` 节点一个 tldraw 样式都没有，于是选中一个终端会得到一个
 * 只有透明度滑块的空面板。判断逻辑是纯函数（`tools.ts`），有单测。
 */
export function CanvasStylePanel(props: TLUiStylePanelProps) {
  const editor = useEditor();
  const visible = useValue(
    "style panel visible",
    () =>
      shouldShowStylePanel(
        editor.getCurrentToolId(),
        editor.getSelectedShapes().map((shape) => shape.type),
      ),
    [editor],
  );

  if (!visible) return null;
  return <DefaultStylePanel {...props} />;
}
