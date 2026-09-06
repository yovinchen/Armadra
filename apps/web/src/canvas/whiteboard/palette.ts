import type {
  WhiteboardColor,
  WhiteboardSize,
} from "@/app/preferences/whiteboard";

import type { Dash, Fill } from "./model";

/**
 * 白板色板与线宽表（React Flow 计划 §2.4，归属 whiteboard）。
 *
 * 13 个颜色名两套十六进制：浅色主题用 `light`，深色主题用 `dark`。
 * 同一个名字在两套里是「同一支笔」，切主题时墨迹不会变成另一个颜色，
 * 只是亮度换一档——深色底上的深蓝看不清，浅色底上的亮黄同样看不清。
 *
 * 全是纯数据 + 纯函数：`raster.ts` 要在没有 DOM 的地方算颜色，所以这里
 * 不能用 CSS 变量。设置页的色板（`WhiteboardPage`）也从这里读，一份表。
 */

export interface Swatch {
  light: string;
  dark: string;
}

/** 顺序即色板顺序（`WHITEBOARD_COLORS`）。 */
export const WHITEBOARD_PALETTE: Record<WhiteboardColor, Swatch> = {
  black: { light: "#1d1d1d", dark: "#e8e8e8" },
  grey: { light: "#9fa8b2", dark: "#adb5bd" },
  white: { light: "#ffffff", dark: "#ffffff" },
  blue: { light: "#4465e9", dark: "#6b8afd" },
  "light-blue": { light: "#4ba1f1", dark: "#6fbaf7" },
  green: { light: "#099268", dark: "#2bb98a" },
  "light-green": { light: "#4cb05e", dark: "#6ecb7f" },
  yellow: { light: "#f1ac4b", dark: "#f5c26b" },
  orange: { light: "#e16919", dark: "#f08b3c" },
  red: { light: "#e03131", dark: "#f06565" },
  "light-red": { light: "#f87777", dark: "#fa9a9a" },
  violet: { light: "#ae3ec9", dark: "#c96ade" },
  "light-violet": { light: "#e085f4", dark: "#eaa6f8" },
};

export type ColorScheme = "light" | "dark";

/** 一个颜色名在当前主题下的十六进制值；未知名字退回黑色那一支。 */
export function colorHex(
  color: WhiteboardColor | string,
  scheme: ColorScheme,
): string {
  const swatch =
    WHITEBOARD_PALETTE[color as WhiteboardColor] ?? WHITEBOARD_PALETTE.black;
  return swatch[scheme];
}

/* -------------------------------- 线宽 ------------------------------------ */

/** s/m/l/xl → 线宽（§2.4）。墨迹、几何形、直线共用。 */
export const STROKE_WIDTHS: Record<WhiteboardSize, number> = {
  s: 2,
  m: 3.5,
  l: 5,
  xl: 10,
};

export function strokeWidth(size: WhiteboardSize | string): number {
  return STROKE_WIDTHS[size as WhiteboardSize] ?? STROKE_WIDTHS.m;
}

/**
 * 「动态尺寸」偏好（§2.10 `dynamicSize`）：缩得很小的时候新对象用粗一档
 * 的笔，放得很大的时候用细一档，这样画出来的东西在屏幕上粗细一致。
 *
 * 我们的 `size` 是四档枚举而不是像素值，所以做法是「按 `1/zoom` 算出想要
 * 的线宽，再挑最接近的那一档」——四档之外没有别的选择，也不该有。
 */
export function scaledSize(size: WhiteboardSize, zoom: number): WhiteboardSize {
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom === 1) return size;
  const wanted = strokeWidth(size) / zoom;
  let best: WhiteboardSize = size;
  let distance = Infinity;
  for (const [name, width] of Object.entries(STROKE_WIDTHS)) {
    const gap = Math.abs(width - wanted);
    if (gap < distance) {
      distance = gap;
      best = name as WhiteboardSize;
    }
  }
  return best;
}

/** 文字字号：与线宽同一档位，但值域按可读性另定。 */
export const FONT_SIZES: Record<WhiteboardSize, number> = {
  s: 14,
  m: 20,
  l: 28,
  xl: 44,
};

export function fontSize(size: WhiteboardSize | string): number {
  return FONT_SIZES[size as WhiteboardSize] ?? FONT_SIZES.m;
}

/** 高亮笔比同档墨迹粗一倍，并且半透明（`mix-blend-mode: multiply`）。 */
export const HIGHLIGHT_SCALE = 4;
export const HIGHLIGHT_OPACITY = 0.35;

/* ------------------------------ 虚实与填充 --------------------------------- */

/**
 * SVG `stroke-dasharray`。实线返回 `undefined`——写成 `"none"` 在部分
 * 浏览器里会被当成无效值，干脆不设这个属性。
 */
export function dashArray(
  dash: Dash | undefined,
  width: number,
): string | undefined {
  if (dash === "dashed") return `${width * 2.2} ${width * 1.8}`;
  if (dash === "dotted") return `${width * 0.1} ${width * 1.9}`;
  return undefined;
}

/** 填充透明度：无 / 半透明 / 实心。 */
export function fillOpacity(fill: Fill | undefined): number {
  if (fill === "solid") return 1;
  if (fill === "semi") return 0.22;
  return 0;
}
