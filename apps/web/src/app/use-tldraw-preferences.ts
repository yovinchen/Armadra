import { useEffect } from "react";
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  react,
  type Editor,
  type TLDefaultColorStyle,
  type TLDefaultDashStyle,
  type TLDefaultFontStyle,
  type TLDefaultSizeStyle,
  type TLUserPreferences,
} from "tldraw";

import { useEditorHandle } from "../canvas/editor-context";
import type { Locale } from "../i18n";
import {
  usePreferencesStore,
  useResolvedTheme,
  type ResolvedTheme,
  type WhiteboardBackground,
  type WhiteboardGridSize,
  type WhiteboardInputMode,
  type WhiteboardPreferences,
  type WhiteboardStyle,
} from "./preferences-store";

/**
 * 画布与应用偏好的同步（tldraw 计划 §5「换肤」+ 2026-09-04 用户反馈
 * 「把 tldraw 原生的配置引入我们的设置」）。
 *
 * 值一律以 `preferences-store` 为准（持久化在 localStorage），挂载与变化时
 * 推给 tldraw。2026-09-05 起**加了一条反向通道**：快捷键（Q / ⌘\' / ⌘.）与
 * tldraw 自己写 instance state 的路径都会被 `react()` 观察到，值不同才写回
 * store，于是偏好菜单、设置页、画布三处永远是同一个值。
 *
 * 不成环靠两层：`whiteboardChanges` 只吐真正不同的键，
 * `setWhiteboardPreference` 再挡一次相同值——推给 tldraw 引起的那次反应
 * 读到的就是刚写进去的值，diff 为空，链条到此为止。
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

/* ------------------------------ 偏好 ⇄ tldraw ------------------------------ */

/**
 * 推给 `editor.user.updateUserPreferences` 的那一份。
 *
 * 只列我们管的字段：`id` / `name` / `color` 归 tldraw 自己（协作用），
 * 这里不碰。`inputMode` 的 `auto` 就是 tldraw 的 `null`。
 */
export type TldrawUserPatch = Pick<
  TLUserPreferences,
  | "colorScheme"
  | "locale"
  | "animationSpeed"
  | "edgeScrollSpeed"
  | "enhancedA11yMode"
  | "inputMode"
  | "isDynamicSizeMode"
  | "isPasteAtCursorMode"
  | "isSnapMode"
  | "isWrapMode"
  | "isZoomDirectionInverted"
>;

/** 推给 `editor.updateInstanceState` 的那一份（instance 级的四个开关）。 */
export interface TldrawInstancePatch {
  isGridMode: boolean;
  isToolLocked: boolean;
  isFocusMode: boolean;
  isDebugMode: boolean;
}

/** `auto` ⇄ `null`：tldraw 用 `null` 表示「自己判断输入设备」。 */
export function tldrawInputMode(
  mode: WhiteboardInputMode,
): "mouse" | "trackpad" | null {
  return mode === "auto" ? null : mode;
}

export function whiteboardInputMode(
  mode: TLUserPreferences["inputMode"],
): WhiteboardInputMode {
  return mode === "mouse" || mode === "trackpad" ? mode : "auto";
}

export function tldrawUserPatch(
  whiteboard: WhiteboardPreferences,
  theme: ResolvedTheme,
  locale: Locale,
): TldrawUserPatch {
  return {
    colorScheme: canvasColorScheme(whiteboard.background, theme),
    locale: tldrawLocale(locale),
    animationSpeed: whiteboard.animation ? 1 : 0,
    edgeScrollSpeed: whiteboard.edgeScroll ? 1 : 0,
    enhancedA11yMode: whiteboard.enhancedA11y,
    inputMode: tldrawInputMode(whiteboard.inputMode),
    isDynamicSizeMode: whiteboard.dynamicSize,
    isPasteAtCursorMode: whiteboard.pasteAtCursor,
    isSnapMode: whiteboard.snap,
    isWrapMode: whiteboard.wrap,
    isZoomDirectionInverted: whiteboard.zoomInverted,
  };
}

export function tldrawInstancePatch(
  whiteboard: WhiteboardPreferences,
): TldrawInstancePatch {
  return {
    isGridMode: whiteboard.grid,
    isToolLocked: whiteboard.toolLock,
    isFocusMode: whiteboard.focus,
    isDebugMode: whiteboard.debug,
  };
}

/** 反向映射的定义域：只有这些键归 tldraw 管，其余（背景 / 风格 / 色）不回写。 */
export type WhiteboardMirrored = Pick<
  WhiteboardPreferences,
  | "animation"
  | "debug"
  | "dynamicSize"
  | "edgeScroll"
  | "enhancedA11y"
  | "focus"
  | "grid"
  | "inputMode"
  | "pasteAtCursor"
  | "snap"
  | "toolLock"
  | "wrap"
  | "zoomInverted"
>;

/**
 * 反向通道读到的那一份，**已经解析过默认值**。
 *
 * 不能拿 `editor.user.getUserPreferences()` 当输入：它返回的是一个另一种
 * 形状的派生对象——`isDynamicSizeMode` 在那里叫 `isDynamicResizeMode`，
 * `edgeScrollSpeed` 与 `isPasteAtCursorMode` 干脆不在里面。照着它读会把
 * 这三项当成「关」写回 store，用户刚打开的开关下一帧就自己弹回去。
 * 逐个 getter 取才是对的（每个 getter 自己 `?? 默认值`）。
 */
export interface TldrawPreferenceSnapshot {
  animationSpeed: number;
  edgeScrollSpeed: number;
  enhancedA11yMode: boolean;
  inputMode: "mouse" | "trackpad" | null;
  isDynamicSizeMode: boolean;
  isPasteAtCursorMode: boolean;
  isSnapMode: boolean;
  isWrapMode: boolean;
  isZoomDirectionInverted: boolean;
  isGridMode: boolean;
  isToolLocked: boolean;
  isFocusMode: boolean;
  isDebugMode: boolean;
}

/** 从 editor 上取一份快照；`react()` 的依赖就是这里读到的那些 atom。 */
export function readTldrawPreferences(
  editor: Editor,
): TldrawPreferenceSnapshot {
  const user = editor.user;
  const instance = editor.getInstanceState();
  return {
    animationSpeed: user.getAnimationSpeed(),
    edgeScrollSpeed: user.getEdgeScrollSpeed(),
    enhancedA11yMode: user.getEnhancedA11yMode(),
    inputMode: user.getInputMode(),
    // tldraw 的 getter 名字里是 Resize，存的字段是 isDynamicSizeMode。
    isDynamicSizeMode: user.getIsDynamicResizeMode(),
    isPasteAtCursorMode: user.getIsPasteAtCursorMode(),
    isSnapMode: user.getIsSnapMode(),
    isWrapMode: user.getIsWrapMode(),
    isZoomDirectionInverted: user.getIsZoomDirectionInverted(),
    isGridMode: Boolean(instance.isGridMode),
    isToolLocked: Boolean(instance.isToolLocked),
    isFocusMode: Boolean(instance.isFocusMode),
    isDebugMode: Boolean(instance.isDebugMode),
  };
}

/** tldraw → 偏好。 */
export function whiteboardFromTldraw(
  snapshot: TldrawPreferenceSnapshot,
): WhiteboardMirrored {
  return {
    animation: snapshot.animationSpeed !== 0,
    debug: snapshot.isDebugMode,
    dynamicSize: snapshot.isDynamicSizeMode,
    edgeScroll: snapshot.edgeScrollSpeed !== 0,
    enhancedA11y: snapshot.enhancedA11yMode,
    focus: snapshot.isFocusMode,
    grid: snapshot.isGridMode,
    inputMode: whiteboardInputMode(snapshot.inputMode),
    pasteAtCursor: snapshot.isPasteAtCursorMode,
    snap: snapshot.isSnapMode,
    toolLock: snapshot.isToolLocked,
    wrap: snapshot.isWrapMode,
    zoomInverted: snapshot.isZoomDirectionInverted,
  };
}

/**
 * 只留下真正不同的键。反向同步全靠它收敛：推下去之后再读回来，
 * diff 是空的，于是不会再写 store，也就不会再推一次。
 */
export function whiteboardChanges(
  current: WhiteboardPreferences,
  incoming: WhiteboardMirrored,
): Partial<WhiteboardMirrored> {
  const changes: Partial<WhiteboardMirrored> = {};
  for (const key of Object.keys(incoming) as (keyof WhiteboardMirrored)[]) {
    if (current[key] !== incoming[key]) {
      // 键与值的类型是一一对应的，但 TS 在同态映射上留不住这层关系。
      (changes as Record<string, unknown>)[key] = incoming[key];
    }
  }
  return changes;
}

/* --------------------------------- Hook ----------------------------------- */

export function useTldrawPreferences(): void {
  const editor = useEditorHandle();
  const theme = useResolvedTheme();
  const locale = usePreferencesStore((state) => state.locale);
  const whiteboard = usePreferencesStore((state) => state.whiteboard);

  const { background, gridSize, style, defaultColor, defaultSize } = whiteboard;

  useEffect(() => {
    applyCanvasBackground(canvasBackgroundVars(background));
  }, [background]);

  useEffect(() => {
    if (!editor) return;
    // tldraw 自己按 `user.colorScheme` 给容器加 `tl-theme__dark` /
    // `tl-theme__light`，而应用主题是 `<html data-theme>`：两套开关必须一起动。
    editor.user.updateUserPreferences(
      tldrawUserPatch(whiteboard, theme, locale),
    );
  }, [editor, whiteboard, theme, locale]);

  useEffect(() => {
    if (!editor) return;
    const patch = tldrawInstancePatch(whiteboard);
    const state = editor.getInstanceState();
    // 逐字段比对再写：`updateInstanceState` 每次都会推一条新记录进 store，
    // 而反向的 `react()` 正盯着它——无条件写就是一个自激的环。
    const diff: Partial<TldrawInstancePatch> = {};
    for (const key of Object.keys(patch) as (keyof TldrawInstancePatch)[]) {
      if (state[key] !== patch[key]) diff[key] = patch[key];
    }
    if (Object.keys(diff).length === 0) return;
    // `history: "ignore"`：切网格 / 工具锁不是画布上的一步，⌘Z 不该撤回它。
    editor.updateInstanceState(diff, { history: "ignore" });
  }, [editor, whiteboard]);

  useEffect(() => {
    if (!editor) return;
    const size = tldrawGridSize(gridSize);
    if (editor.getDocumentSettings().gridSize !== size) {
      editor.updateDocumentSettings({ gridSize: size });
    }
  }, [editor, gridSize]);

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

  /* ------------------------------ 反向通道 -------------------------------- */

  /**
   * tldraw → 偏好。
   *
   * 这个 effect 必须排在上面几个「推下去」的后面：挂载时 effect 按声明顺序
   * 跑，先推再订阅，`react()` 第一次求值读到的就已经是 store 的值。
   * 反过来的话，tldraw 的默认值会在第一帧把用户存的偏好冲掉。
   */
  useEffect(() => {
    if (!editor) return;
    return react("whiteboard preferences", () => {
      const incoming = whiteboardFromTldraw(readTldrawPreferences(editor));
      const state = usePreferencesStore.getState();
      const changes = whiteboardChanges(state.whiteboard, incoming);
      for (const [key, value] of Object.entries(changes)) {
        state.setWhiteboardPreference(
          key as keyof WhiteboardPreferences,
          value as WhiteboardPreferences[keyof WhiteboardPreferences],
        );
      }
    });
  }, [editor]);
}
