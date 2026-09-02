import { useEffect } from "react";
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  type TLDefaultColorStyle,
  type TLDefaultDashStyle,
  type TLDefaultFontStyle,
  type TLDefaultSizeStyle,
} from "tldraw";

import { useEditorHandle } from "../canvas/editor-context";
import type { Locale } from "../i18n";
import {
  usePreferencesStore,
  useResolvedTheme,
  type ResolvedTheme,
  type WhiteboardBackground,
  type WhiteboardGridSize,
  type WhiteboardStyle,
} from "./preferences-store";

/**
 * 画布与应用偏好的同步（tldraw 计划 §5「换肤」+ 2026-09-04 用户反馈
 * 「把 tldraw 原生的配置引入我们的设置」）。
 *
 * 值一律以 `preferences-store` 为准（持久化在 localStorage），挂载与变化时
 * 单向推给 tldraw；反向不读——用户在 tldraw 自己的菜单里改了什么，下次
 * 偏好变化时会被盖掉，这是刻意的：设置页是唯一入口。
 *
 * 壳这一层订阅 `editor-context`（画布外唯一允许的取 editor 途径，§9.1）。
 * 背景那一档不需要 editor：它改的是 `--canvas-bg` / `--canvas-dot` 两个
 * 文档级变量，`styles/canvas.css` 已经把 `--tl-color-background` 与
 * `--tl-color-grid` 指过去了。
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
 * tldraw 的形状调色板跟着 `user.colorScheme` 走：深色主题下的「黑」其实是
 * near-white（`#f2f2f2`）。所以选了固定底色之后，色板要跟**底色的明暗**走
 * 而不是跟应用主题走——否则在深色应用里选「纸色」画出来的线是白的，看不见。
 *
 * 面板与工具栏不受影响：`styles/canvas.css` 把 `--tl-color-*` 整体重定向到
 * 我们的 token，两个 `tl-theme__*` 类都盖不过它。
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

/* --------------------------------- 网格 ----------------------------------- */

/**
 * tldraw 的 `gridSteps` 是 64 / 16 / 4 / 1 四档，最细的 1× 那层由
 * `styles/canvas.css` 关掉，所以屏幕上看到的是 `4 × gridSize`。
 * 用户在设置里选的是**看到的间距**，这里除回去。
 */
export function tldrawGridSize(spacing: WhiteboardGridSize): number {
  return spacing / 4;
}

/* --------------------------------- 风格 ----------------------------------- */

export interface WhiteboardStylePreset {
  dash: TLDefaultDashStyle;
  font: TLDefaultFontStyle;
}

/** 手绘 = 抖动线 + 手写体；整洁 = 实线 + 无衬线。 */
export const WHITEBOARD_STYLE_PRESETS: Record<
  WhiteboardStyle,
  WhiteboardStylePreset
> = {
  sketch: { dash: "draw", font: "draw" },
  clean: { dash: "solid", font: "sans" },
};

/* --------------------------------- 语言 ----------------------------------- */

/** tldraw 界面语言静默跟随应用语言（§14：界面上不写「跟随应用语言」）。 */
export function tldrawLocale(locale: Locale): string {
  return locale === "zh-CN" ? "zh-cn" : "en";
}

/* --------------------------------- Hook ----------------------------------- */

export function useTldrawPreferences(): void {
  const editor = useEditorHandle();
  const theme = useResolvedTheme();
  const locale = usePreferencesStore((state) => state.locale);
  const whiteboard = usePreferencesStore((state) => state.whiteboard);

  const {
    background,
    grid,
    gridSize,
    snap,
    dynamicSize,
    animation,
    style,
    defaultColor,
    defaultSize,
  } = whiteboard;

  useEffect(() => {
    applyCanvasBackground(canvasBackgroundVars(background));
  }, [background]);

  useEffect(() => {
    if (!editor) return;
    // tldraw 自己按 `user.colorScheme` 给容器加 `tl-theme__dark` /
    // `tl-theme__light`，而应用主题是 `<html data-theme>`：两套开关必须一起动。
    editor.user.updateUserPreferences({
      colorScheme: canvasColorScheme(background, theme),
      locale: tldrawLocale(locale),
      isSnapMode: snap,
      isDynamicSizeMode: dynamicSize,
      animationSpeed: animation ? 1 : 0,
    });
  }, [editor, background, theme, locale, snap, dynamicSize, animation]);

  useEffect(() => {
    if (!editor) return;
    const size = tldrawGridSize(gridSize);
    if (editor.getDocumentSettings().gridSize !== size) {
      editor.updateDocumentSettings({ gridSize: size });
    }
    if (editor.getInstanceState().isGridMode !== grid) {
      editor.updateInstanceState({ isGridMode: grid }, { history: "ignore" });
    }
  }, [editor, grid, gridSize]);

  useEffect(() => {
    if (!editor) return;
    const preset = WHITEBOARD_STYLE_PRESETS[style];
    // `history: "ignore"`：改默认风格不是画布上的一步，⌘Z 不该把它撤回来。
    const options = { history: "ignore" } as const;
    editor.setStyleForNextShapes(DefaultDashStyle, preset.dash, options);
    editor.setStyleForNextShapes(DefaultFontStyle, preset.font, options);
    editor.setStyleForNextShapes(
      DefaultColorStyle,
      defaultColor as TLDefaultColorStyle,
      options,
    );
    editor.setStyleForNextShapes(
      DefaultSizeStyle,
      defaultSize as TLDefaultSizeStyle,
      options,
    );
  }, [editor, style, defaultColor, defaultSize]);
}
