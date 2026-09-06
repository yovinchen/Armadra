// B2 重建：白板样式面板（React Flow 计划 F28）。
//
// 没有现成的样式面板可复用了，要自己写：shadcn 的
// `Popover` / `ToggleGroup` / `Tooltip`，改「下一个对象的样式」
// （`interaction/tool-store.nextStyle`）或选中对象的样式
// （`whiteboard.updateItem`）。色板在 `whiteboard/palette.ts`。
//
// 显隐规则（`tools.shouldShowStylePanel`）是纯函数，已经改好并有单测；
// B0 只是还没有面板可以显示，所以这里恒为 null。
import { useCanvasStore } from "@/store/canvas-store";
import { useTool } from "./interaction/tool-store";
import { shouldShowStylePanel } from "./tools";

export function CanvasStylePanel() {
  const tool = useTool();
  const selected = useCanvasStore((state) => state.selectedItemIds);
  if (!shouldShowStylePanel(tool, selected)) return null;
  return null;
}
