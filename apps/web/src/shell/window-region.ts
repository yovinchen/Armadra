import { isDesktop } from "../platform";
import { isMacPlatform } from "../keybindings";

/**
 * 无边框窗口的拖拽区（§3.1）。
 *
 * 两个壳用的是两套机制，而且**互不认识对方的**：
 *
 * - **Electron**：`-webkit-app-region: drag`。Chromium 自己实现，按住这块
 *   就能拖走窗口；macOS 上双击还原 / 最大化也由它接管。关键在于这个属性是
 *   **继承**的——子元素会跟着变成拖拽区，按钮按下去就成了拖窗口，所以交互
 *   元素必须显式写回 `no-drag`（这就是 `noDragProps()` 在 Electron 下有内容
 *   的原因）。声明写成 `data-app-region` 而不是内联 style：`-webkit-app-region`
 *   是 Electron 那一份 Chromium 才认的属性，CSSOM 不一定暴露它，走样式表里
 *   的一条规则（`styles/tokens.css`）才是两边都算数的写法。
 * - **Tauri**：WKWebView 根本不认 `-webkit-app-region`，早先这里用它，桌面端
 *   哪儿都拖不动。Tauri 2 的做法是给元素挂 `data-tauri-drag-region`：注入的
 *   脚本在 mousedown 时沿 `composedPath()` 往上走，遇到带这个属性的元素就
 *   `start_dragging`。**不带值的属性只对元素自己生效**，子元素上的 mousedown
 *   不算——所以拖拽区必须是一个空的、铺满的元素（见 `WindowDragLayer`）。
 *   `core:window:allow-start-dragging` 不在 `core:default` 里，桌面壳的
 *   capabilities 单独列了它。
 *
 * 两条规则的交集就是今天的写法：一个空的铺满元素，两种属性各挂各的。
 */
export type DragRegionProps = {
  "data-tauri-drag-region"?: true;
  "data-app-region"?: "drag" | "no-drag";
};

function isElectronShell(): boolean {
  return typeof window !== "undefined" && window.armadra !== undefined;
}

/** 挂在**空**元素上：这一块可以拖动整个窗口（浏览器里什么也不加）。 */
export function dragRegionProps(): DragRegionProps {
  if (isElectronShell()) return { "data-app-region": "drag" };
  return isDesktop() ? { "data-tauri-drag-region": true } : {};
}

/**
 * 拖拽区里的例外。
 *
 * Electron 下是**必须**的：`-webkit-app-region` 会往下继承，一个落在拖拽区
 * 里的按钮如果不写回 `no-drag`，按下去就是拖窗口而不是点按钮。Tauri 是逐
 * 元素 opt-in 的，按钮本来就不会被当成拖拽区，所以那边返回空。
 */
export function noDragProps(): DragRegionProps {
  if (isElectronShell()) return { "data-app-region": "no-drag" };
  return {};
}

/** macOS 桌面壳里左上角三颗信号灯占位（86px）。 */
export function trafficLightInset(): number {
  return isDesktop() && isMacPlatform() ? 86 : 0;
}
