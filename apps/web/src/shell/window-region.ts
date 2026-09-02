import type { CSSProperties } from "react";
import { isTauri } from "../platform";
import { isMacPlatform } from "../keybindings";

/**
 * 标签栏兼作窗口拖拽区（§3.1）。`-webkit-app-region` 不在 React 的
 * `CSSProperties` 里，所以这里集中做一次断言，业务代码不再各自 `as any`。
 */
export const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
export const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** macOS 桌面壳里左上角三颗信号灯占位（86px）。 */
export function trafficLightInset(): number {
  return isTauri() && isMacPlatform() ? 86 : 0;
}
