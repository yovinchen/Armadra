import { isDesktop } from "../platform";
import { isMacPlatform } from "../keybindings";

/**
 * 无边框窗口的拖拽区（§3.1）。
 *
 * 机制是 `-webkit-app-region: drag`：Chromium 自己实现，按住这块就能拖走窗口，
 * macOS 上双击还原 / 最大化也由它接管。关键在于这个属性是**继承**的——子元素
 * 会跟着变成拖拽区，按钮按下去就成了拖窗口，所以交互元素必须显式写回
 * `no-drag`（这就是 `noDragProps()` 存在的原因），拖拽区本身则做成一个空的、
 * 铺满的元素（见 `WindowDragLayer`）。
 *
 * 声明写成 `data-app-region` 而不是内联 style：`-webkit-app-region` 是壳那一份
 * Chromium 才认的属性，CSSOM 不一定暴露它，走样式表里的一条规则
 * （`styles/tokens.css`）才是算数的写法。
 */
export type DragRegionProps = {
  "data-app-region"?: "drag" | "no-drag";
};

function isShell(): boolean {
  return typeof window !== "undefined" && window.armadra !== undefined;
}

/** 挂在**空**元素上：这一块可以拖动整个窗口（浏览器里什么也不加）。 */
export function dragRegionProps(): DragRegionProps {
  return isShell() ? { "data-app-region": "drag" } : {};
}

/**
 * 拖拽区里的例外：`-webkit-app-region` 会往下继承，一个落在拖拽区里的按钮如果
 * 不写回 `no-drag`，按下去就是拖窗口而不是点按钮。
 */
export function noDragProps(): DragRegionProps {
  return isShell() ? { "data-app-region": "no-drag" } : {};
}

/** macOS 桌面壳里左上角三颗信号灯占位（86px）。 */
export function trafficLightInset(): number {
  return isDesktop() && isMacPlatform() ? 86 : 0;
}
