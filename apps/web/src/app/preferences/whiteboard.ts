import { readStored, storedBoolean, storedEnum } from "./storage";

const WB_BACKGROUND_KEY = "armadra.whiteboard.background";
const WB_GRID_KEY = "armadra.whiteboard.grid";
const WB_GRID_SIZE_KEY = "armadra.whiteboard.gridSize";
const WB_SNAP_KEY = "armadra.whiteboard.snap";
const WB_DYNAMIC_SIZE_KEY = "armadra.whiteboard.dynamicSize";
const WB_ANIMATION_KEY = "armadra.whiteboard.animation";
const WB_TOOL_LOCK_KEY = "armadra.whiteboard.toolLock";
const WB_WRAP_KEY = "armadra.whiteboard.wrap";
const WB_FOCUS_KEY = "armadra.whiteboard.focus";
const WB_EDGE_SCROLL_KEY = "armadra.whiteboard.edgeScroll";
const WB_PASTE_AT_CURSOR_KEY = "armadra.whiteboard.pasteAtCursor";
const WB_DEBUG_KEY = "armadra.whiteboard.debug";
const WB_ENHANCED_A11Y_KEY = "armadra.whiteboard.enhancedA11y";
const WB_INPUT_MODE_KEY = "armadra.whiteboard.inputMode";
const WB_ZOOM_INVERTED_KEY = "armadra.whiteboard.zoomInverted";
const WB_STYLE_KEY = "armadra.whiteboard.style";
const WB_COLOR_KEY = "armadra.whiteboard.defaultColor";
const WB_SIZE_KEY = "armadra.whiteboard.defaultSize";

/**
 * 白板背景（用户反馈 2026-09-04：把 tldraw 原生配置引进设置）。
 *
 * `theme` = 跟随应用主题（`tokens.css` 里的 `--canvas-bg`）；其余四档是固定
 * 底色，深浅色下都用同一个值——「纯黑」在浅色主题下也该是纯黑。
 * 色值与点阵色的换算在 `use-tldraw-preferences.ts`（纯函数，有单测）。
 */
export const WHITEBOARD_BACKGROUNDS = [
  "theme",
  "black",
  "white",
  "paper",
  "slate",
] as const;
export type WhiteboardBackground = (typeof WHITEBOARD_BACKGROUNDS)[number];

/** 点阵间距（px）。tldraw 的 `gridSize` 是这个值的 1/4，见 §「网格换算」。 */
export const WHITEBOARD_GRID_SIZES = [12, 24, 48] as const;
export type WhiteboardGridSize = (typeof WHITEBOARD_GRID_SIZES)[number];

/** 新形状的默认风格：手绘（`draw` 线型 + 手写体）/ 整洁（实线 + 无衬线）。 */
export const WHITEBOARD_STYLES = ["sketch", "clean"] as const;
export type WhiteboardStyle = (typeof WHITEBOARD_STYLES)[number];

/** tldraw 的 13 个颜色名（`TLDefaultColorStyle`），顺序即色板顺序。 */
export const WHITEBOARD_COLORS = [
  "black",
  "grey",
  "white",
  "blue",
  "light-blue",
  "green",
  "light-green",
  "yellow",
  "orange",
  "red",
  "light-red",
  "violet",
  "light-violet",
] as const;
export type WhiteboardColor = (typeof WHITEBOARD_COLORS)[number];

/** tldraw 的 `TLDefaultSizeStyle`。 */
export const WHITEBOARD_SIZES = ["s", "m", "l", "xl"] as const;
export type WhiteboardSize = (typeof WHITEBOARD_SIZES)[number];

/**
 * 输入设备（tldraw 的 `inputMode`）。
 *
 * `auto` 就是 tldraw 的 `null`：由它自己按滚轮事件的形状判断鼠标还是触控板。
 * 三档与 tldraw 原生菜单一致，少一档就没法退回自动。
 */
export const WHITEBOARD_INPUT_MODES = ["auto", "mouse", "trackpad"] as const;
export type WhiteboardInputMode = (typeof WHITEBOARD_INPUT_MODES)[number];

/**
 * 白板偏好。
 *
 * 和终端外观一样整块存：`use-tldraw-preferences.ts` 挂载和变化时把它推给
 * tldraw（`updateUserPreferences` / `updateInstanceState` /
 * `updateDocumentSettings` / `setStyleForNextShapes`），这里是唯一真相。
 */
export interface WhiteboardPreferences {
  background: WhiteboardBackground;
  /** 点阵开关，映射 `isGridMode`。 */
  grid: boolean;
  gridSize: WhiteboardGridSize;
  /** 吸附，映射 `isSnapMode`。 */
  snap: boolean;
  /** 缩放时新形状字号跟随，映射 `isDynamicSizeMode`。 */
  dynamicSize: boolean;
  /** 动画，映射 `animationSpeed` 1 / 0。 */
  animation: boolean;
  /** 画完一个形状后工具不退回选择，映射 instance 的 `isToolLocked`。 */
  toolLock: boolean;
  /** 框选时整体包住才算选中，映射 `isWrapMode`。 */
  wrap: boolean;
  /** 专注模式：tldraw 自己的面板全部收起，映射 instance 的 `isFocusMode`。 */
  focus: boolean;
  /** 拖到视口边缘时自动平移，映射 `edgeScrollSpeed` 1 / 0。 */
  edgeScroll: boolean;
  /** 粘贴到光标处而不是视口中心，映射 `isPasteAtCursorMode`。 */
  pasteAtCursor: boolean;
  /** tldraw 的调试面板，映射 instance 的 `isDebugMode`。 */
  debug: boolean;
  /** 增强辅助模式，映射 `enhancedA11yMode`。 */
  enhancedA11y: boolean;
  /** 输入设备，映射 `inputMode`（`auto` → `null`）。 */
  inputMode: WhiteboardInputMode;
  /** 缩放方向反转，映射 `isZoomDirectionInverted`；只在鼠标模式下有意义。 */
  zoomInverted: boolean;
  style: WhiteboardStyle;
  defaultColor: WhiteboardColor;
  defaultSize: WhiteboardSize;
}

export const WHITEBOARD_KEYS: Record<keyof WhiteboardPreferences, string> = {
  background: WB_BACKGROUND_KEY,
  grid: WB_GRID_KEY,
  gridSize: WB_GRID_SIZE_KEY,
  snap: WB_SNAP_KEY,
  dynamicSize: WB_DYNAMIC_SIZE_KEY,
  animation: WB_ANIMATION_KEY,
  toolLock: WB_TOOL_LOCK_KEY,
  wrap: WB_WRAP_KEY,
  focus: WB_FOCUS_KEY,
  edgeScroll: WB_EDGE_SCROLL_KEY,
  pasteAtCursor: WB_PASTE_AT_CURSOR_KEY,
  debug: WB_DEBUG_KEY,
  enhancedA11y: WB_ENHANCED_A11Y_KEY,
  inputMode: WB_INPUT_MODE_KEY,
  zoomInverted: WB_ZOOM_INVERTED_KEY,
  style: WB_STYLE_KEY,
  defaultColor: WB_COLOR_KEY,
  defaultSize: WB_SIZE_KEY,
};

/** 数字枚举没法走 `storedEnum`（存进去是字符串），单独收一个。 */
function storedWhiteboardGridSize(): WhiteboardGridSize {
  const raw = readStored(WB_GRID_SIZE_KEY);
  const value = Number(raw);
  return (WHITEBOARD_GRID_SIZES as readonly number[]).includes(value)
    ? (value as WhiteboardGridSize)
    : 24;
}

export function storedWhiteboardPreferences(): WhiteboardPreferences {
  return {
    background: storedEnum(WB_BACKGROUND_KEY, WHITEBOARD_BACKGROUNDS, "theme"),
    grid: storedBoolean(WB_GRID_KEY, true),
    gridSize: storedWhiteboardGridSize(),
    snap: storedBoolean(WB_SNAP_KEY, false),
    dynamicSize: storedBoolean(WB_DYNAMIC_SIZE_KEY, false),
    animation: storedBoolean(WB_ANIMATION_KEY, true),
    toolLock: storedBoolean(WB_TOOL_LOCK_KEY, false),
    wrap: storedBoolean(WB_WRAP_KEY, false),
    focus: storedBoolean(WB_FOCUS_KEY, false),
    edgeScroll: storedBoolean(WB_EDGE_SCROLL_KEY, true),
    pasteAtCursor: storedBoolean(WB_PASTE_AT_CURSOR_KEY, false),
    debug: storedBoolean(WB_DEBUG_KEY, false),
    enhancedA11y: storedBoolean(WB_ENHANCED_A11Y_KEY, false),
    inputMode: storedEnum(WB_INPUT_MODE_KEY, WHITEBOARD_INPUT_MODES, "auto"),
    zoomInverted: storedBoolean(WB_ZOOM_INVERTED_KEY, false),
    style: storedEnum(WB_STYLE_KEY, WHITEBOARD_STYLES, "sketch"),
    defaultColor: storedEnum(WB_COLOR_KEY, WHITEBOARD_COLORS, "black"),
    defaultSize: storedEnum(WB_SIZE_KEY, WHITEBOARD_SIZES, "m"),
  };
}
