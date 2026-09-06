import { isTauri } from "../platform";
import { isMacPlatform } from "../keybindings";

/**
 * 无边框窗口的拖拽区（§3.1）。
 *
 * 早先这里用的是 `-webkit-app-region: drag`——那是 Electron 的机制，
 * Tauri 的 WKWebView 根本不认，所以桌面端哪儿都拖不动。Tauri 2 的做法是
 * 给元素挂 `data-tauri-drag-region`：它注入的脚本在 mousedown 时沿
 * `composedPath()` 往上走，遇到带这个属性的元素就 `start_dragging`
 * （macOS 上双击走 mouseup 触发 `internal_toggle_maximize`）。
 *
 * 关键约束：**不带值的属性只对元素自己生效**，子元素上的 mousedown 不算。
 * 所以拖拽区必须是一个空的、铺满的元素（见 `WindowDragLayer`），
 * 而不是把属性挂在装着按钮的容器上。
 *
 * `core:window:allow-start-dragging` 不在 `core:default` 里，
 * 桌面壳的 capabilities 单独列了它。
 */
export type DragRegionProps = {
  "data-tauri-drag-region"?: true;
};

/** 挂在**空**元素上：这一块可以拖动整个窗口（浏览器里什么也不加）。 */
export function dragRegionProps(): DragRegionProps {
  return isTauri() ? { "data-tauri-drag-region": true } : {};
}

/**
 * 拖拽区里的例外。Tauri 是逐元素 opt-in 的，按钮、输入框这些本来就不会
 * 被当成拖拽区，所以这里返回空——留着这个名字是为了让「这块故意不拖」
 * 在调用处写得出来，而不是靠读者猜。
 */
export function noDragProps(): DragRegionProps {
  return {};
}

/** macOS 桌面壳里左上角三颗信号灯占位（86px）。 */
export function trafficLightInset(): number {
  return isTauri() && isMacPlatform() ? 86 : 0;
}
