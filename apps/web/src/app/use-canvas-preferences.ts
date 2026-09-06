import { useEffect } from "react";

import { setNextStyle } from "../canvas/interaction/tool-store";
import {
  usePreferencesStore,
  type ResolvedTheme,
  type WhiteboardBackground,
} from "./preferences-store";

/**
 * 画布偏好（React Flow 计划 §2.10）。
 *
 * **单向**：`preferences-store`（持久化在 localStorage）是唯一真相，挂载与
 * 变化时推给画布。旧引擎那条反向通道（编辑器写回偏好）连同它的防环
 * 逻辑一起删掉了——React Flow 不持有偏好，没有人会在背后改它们。
 *
 * 这个 hook 只做两件事：写背景变量、把默认颜色 / 粗细推给工具 store。
 * 其余偏好由 `canvas/flow/flow-options.ts` 算成 `<ReactFlow>` 的 props，
 * 那是纯函数，`FlowWorkspace` 直接读。
 */

/* --------------------------------- 背景 ----------------------------------- */

/**
 * 四档固定底色。深浅色下都用同一个值——用户选「纯黑」就是纯黑。
 * `theme` 不在表里：那一档什么都不设，落回 `tokens.css` 的 token。
 */
export const WHITEBOARD_BACKGROUND_COLORS: Record<
  Exclude<WhiteboardBackground, "theme">,
  string
> = {
  black: "#000000",
  white: "#ffffff",
  paper: "#f6f2ea",
  slate: "#1b2430",
};

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function toHex(channel: number): string {
  return Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, "0");
}

/** 感知明度（Rec. 709 权重），0–1。 */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 点阵色按背景明度自动取对比：亮底往黑里压 20%，暗底往白里提 30%。
 *
 * 两个比例不对称是因为点阵在暗底上更容易糊掉——同样的对比度，浅色的点
 * 在黑底上看着比深色的点在白底上更弱。
 */
export function canvasDotColor(background: string): string {
  const [r, g, b] = channels(background);
  const light = luminance(background) > 0.55;
  const target = light ? 0 : 255;
  const ratio = light ? 0.2 : 0.3;
  const mix = (channel: number) => channel + (target - channel) * ratio;
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

export interface CanvasBackgroundVars {
  "--canvas-bg": string;
  "--canvas-dot": string;
}

/**
 * 白板对象的墨色跟着**底色的明暗**走，而不是跟应用主题走——否则在深色
 * 应用里选「纸色」画出来的线是白的，看不见。React Flow 自己的
 * `colorMode` 也吃这个值（它只影响 RF 的 CSS 变量，面板不受影响）。
 */
export function canvasColorScheme(
  background: WhiteboardBackground,
  theme: ResolvedTheme,
): ResolvedTheme {
  if (background === "theme") return theme;
  return luminance(WHITEBOARD_BACKGROUND_COLORS[background]) > 0.55
    ? "light"
    : "dark";
}

/** `theme` → `null`（用主题 token）；其余 → 一对写到 `<html>` 上的变量。 */
export function canvasBackgroundVars(
  background: WhiteboardBackground,
): CanvasBackgroundVars | null {
  if (background === "theme") return null;
  const color = WHITEBOARD_BACKGROUND_COLORS[background];
  return { "--canvas-bg": color, "--canvas-dot": canvasDotColor(color) };
}

/** 内联样式的优先级高于 `tokens.css` 的 `:root` 规则，所以直接写根元素。 */
export function applyCanvasBackground(vars: CanvasBackgroundVars | null): void {
  const root = document.documentElement;
  if (!vars) {
    root.style.removeProperty("--canvas-bg");
    root.style.removeProperty("--canvas-dot");
    return;
  }
  root.style.setProperty("--canvas-bg", vars["--canvas-bg"]);
  root.style.setProperty("--canvas-dot", vars["--canvas-dot"]);
}

/* --------------------------------- Hook ----------------------------------- */

export function useCanvasPreferences(): void {
  const background = usePreferencesStore(
    (state) => state.whiteboard.background,
  );
  const defaultColor = usePreferencesStore(
    (state) => state.whiteboard.defaultColor,
  );
  const defaultSize = usePreferencesStore(
    (state) => state.whiteboard.defaultSize,
  );

  useEffect(() => {
    applyCanvasBackground(canvasBackgroundVars(background));
  }, [background]);

  useEffect(() => {
    setNextStyle({ color: defaultColor, size: defaultSize });
  }, [defaultColor, defaultSize]);
}
