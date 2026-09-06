import { isTauri } from "../platform";
import { dragRegionProps } from "./window-region";

/**
 * 全局顶部拖拽条：窗口最上面这 44px 就是标题栏，空白处按住能拖走整个窗口
 * （macOS 上双击还原 / 最大化，由 Tauri 自己接管）。
 *
 * 它是一个**空**的铺满元素——`data-tauri-drag-region` 只认元素自己身上的
 * mousedown，所以这里不能放任何子节点。启动页、画布 + 侧栏展开、侧栏收起
 * 三种状态下都渲染同一条，左上角红绿灯右侧、侧栏顶栏、画布上方那 44px
 * 于是处处可拖。
 *
 * z 轴放在 `--z-pills`：这一带真正的交互控件（侧栏折叠钮 31、右上工具簇 26、
 * 横幅 27）都比它高，点击照常落在按钮上；启动页右上角的设置钮在正常流里，
 * 由 `Launcher` 自己抬到 `--z-dock`。
 *
 * 浏览器里没有无边框窗口这回事，直接不渲染。
 */
export function WindowDragLayer() {
  if (!isTauri()) return null;
  return (
    <div
      aria-hidden
      data-testid="window-drag-layer"
      {...dragRegionProps()}
      className="fixed top-0 right-0 left-0 z-[var(--z-pills)] h-[var(--tabbar-h)]"
    />
  );
}
