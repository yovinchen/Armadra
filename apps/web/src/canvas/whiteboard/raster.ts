import { arrowHead, geoPath, itemsBounds } from "./geometry";
import { inkPath } from "./ink";
import {
  colorHex,
  dashArray,
  fillOpacity,
  fontSize,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_SCALE,
  strokeWidth,
  type ColorScheme,
} from "./palette";
import type { Item } from "./model";

/**
 * 白板对象 → PNG（React Flow 计划 §2.4 / F29，归属 whiteboard）。
 *
 * 内容引用要交给 Agent 一张图（`ContextLink.content.pngPath`），旧引擎那边
 * 是编辑器自带的导出，现在得自己画。用 `OffscreenCanvas`（拿不到就退回
 * `<canvas>`），墨迹与几何形走 `Path2D`（与 SVG 节点同一份 `d`，所以导出
 * 的图和屏幕上看到的是同一条线），图片经 `fetch` → `createImageBitmap`
 * 解码——不是 `<img src>` + `drawImage`，那条路会在跨源时污染画布，
 * `toBlob` 直接抛。
 *
 * 输入校验先做完再碰 DOM：空选区、退化的包围盒、超大的画布在这里就被拒，
 * 单测不需要一个能画图的 node 环境也能覆盖这一半。
 */

/** 导出画布的最大边（像素）。再大既没人看，也会把内存打满。 */
export const MAX_RASTER_EDGE = 4096;

export interface RasterOptions {
  /** 像素密度，默认 2（Retina）。 */
  scale?: number;
  /** 四周留白（画布单位），默认 16。 */
  padding?: number;
  /** 底色；null / 省略 = 透明。 */
  background?: string | null;
  /** 取哪一套色值，默认浅色（导出的图多半贴进文档里看）。 */
  scheme?: ColorScheme;
  /** 图片对象的 `assetPath` → 可加载的 URL；拿不到就跳过那张图。 */
  resolveImage?: (assetPath: string) => string | null;
}

export class RasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RasterError";
  }
}

export interface RasterPlan {
  x: number;
  y: number;
  /** 画布单位的宽高（不含像素密度）。 */
  w: number;
  h: number;
  scale: number;
  /** 实际的位图尺寸（已按 `MAX_RASTER_EDGE` 收过）。 */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * 算一次导出计划：包围盒 + 留白 + 密度 → 位图尺寸。
 *
 * 纯函数，所以「空选区拒绝」「超大自动降密度」这两条规则不用开画布就能
 * 测。密度是降下来的而不是把图裁掉：一张 10,000px 宽的白板导出成 4,096px
 * 仍然是完整的一张，只是细节少一点。
 */
export function planRaster(
  items: readonly Item[],
  options: RasterOptions = {},
): RasterPlan {
  if (items.length === 0) {
    throw new RasterError("nothing to rasterize");
  }
  const padding = options.padding ?? 16;
  const bounds = itemsBounds(items);
  if (!bounds) throw new RasterError("nothing to rasterize");
  const w = bounds.w + padding * 2;
  const h = bounds.h + padding * 2;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new RasterError("degenerate bounds");
  }
  const requested = options.scale ?? 2;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new RasterError("invalid scale");
  }
  const fit = Math.min(1, MAX_RASTER_EDGE / Math.max(w, h) / requested);
  const scale = requested * (fit < 1 ? fit : 1);
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w,
    h,
    scale,
    pixelWidth: Math.max(1, Math.round(w * scale)),
    pixelHeight: Math.max(1, Math.round(h * scale)),
  };
}

/* -------------------------------- 画布 ------------------------------------ */

interface Surface {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  toBlob: () => Promise<Blob>;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new RasterError("no 2d context");
    return {
      context,
      toBlob: () => canvas.convertToBlob({ type: "image/png" }),
    };
  }
  if (typeof document === "undefined") {
    throw new RasterError("no canvas available");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new RasterError("no 2d context");
  return {
    context,
    toBlob: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new RasterError("toBlob failed"));
        }, "image/png");
      }),
  };
}

/* -------------------------------- 绘制 ------------------------------------ */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function strokeStyleOf(item: Item, scheme: ColorScheme): string {
  return colorHex(item.style.color, scheme);
}

function drawInk(
  context: Context2D,
  item: Extract<Item, { kind: "ink" }>,
  scheme: ColorScheme,
): void {
  const base = strokeWidth(item.style.size);
  const size = item.highlight ? base * HIGHLIGHT_SCALE : base;
  const d = inkPath(item.points, { size, highlight: item.highlight });
  if (!d) return;
  context.save();
  context.translate(item.x, item.y);
  context.globalAlpha = item.highlight ? HIGHLIGHT_OPACITY : 1;
  context.fillStyle = strokeStyleOf(item, scheme);
  context.fill(new Path2D(d));
  context.restore();
}

function drawShape(
  context: Context2D,
  item: Extract<Item, { kind: "shape" }>,
  scheme: ColorScheme,
): void {
  const d = geoPath(item.geo, item.w, item.h);
  if (!d) return;
  const width = strokeWidth(item.style.size);
  const color = strokeStyleOf(item, scheme);
  const path = new Path2D(d);
  context.save();
  context.translate(item.x, item.y);
  const opacity = fillOpacity(item.style.fill);
  if (opacity > 0) {
    context.globalAlpha = opacity;
    context.fillStyle = color;
    context.fill(path);
    context.globalAlpha = 1;
  }
  context.lineWidth = width;
  context.strokeStyle = color;
  context.lineJoin = "round";
  const dash = dashArray(item.style.dash, width);
  context.setLineDash(dash ? dash.split(" ").map(Number) : []);
  context.stroke(path);
  context.restore();
  if (item.label) {
    drawText(
      context,
      { ...item, text: item.label, kind: "text" } as never,
      scheme,
      "middle",
    );
  }
}

function drawLine(
  context: Context2D,
  item: Extract<Item, { kind: "line" }>,
  scheme: ColorScheme,
): void {
  if (item.points.length < 2) return;
  const width = strokeWidth(item.style.size);
  context.save();
  context.translate(item.x, item.y);
  context.lineWidth = width;
  context.strokeStyle = strokeStyleOf(item, scheme);
  context.lineCap = "round";
  context.lineJoin = "round";
  const dash = dashArray(item.style.dash, width);
  context.setLineDash(dash ? dash.split(" ").map(Number) : []);
  context.beginPath();
  const [first, ...rest] = item.points;
  context.moveTo(first![0], first![1]);
  for (const [x, y] of rest) context.lineTo(x, y);
  context.stroke();
  context.setLineDash([]);
  const head = width * 3 + 4;
  if (item.arrowEnd) {
    const tip = item.points[item.points.length - 1]!;
    const from = item.points[item.points.length - 2]!;
    context.stroke(new Path2D(arrowHead(tip, from, head)));
  }
  if (item.arrowStart) {
    context.stroke(
      new Path2D(arrowHead(item.points[0]!, item.points[1]!, head)),
    );
  }
  context.restore();
}

/** 极简折行：按字符宽度切，够用——引用里的文字本来就是短句。 */
function wrapText(
  context: Context2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const character of paragraph) {
      const candidate = current + character;
      if (current && context.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = character;
      } else current = candidate;
    }
    lines.push(current);
  }
  return lines;
}

function drawText(
  context: Context2D,
  item: Extract<Item, { kind: "text" }>,
  scheme: ColorScheme,
  align: "start" | "middle" | "end" = item.style.align ?? "start",
): void {
  if (!item.text) return;
  const size = fontSize(item.style.size);
  context.save();
  context.translate(item.x, item.y);
  context.fillStyle = strokeStyleOf(item, scheme);
  context.font = `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textBaseline = "top";
  const lineHeight = size * 1.35;
  const lines = wrapText(context, item.text, Math.max(item.w, 1));
  const startY =
    align === "middle"
      ? Math.max(0, (item.h - lines.length * lineHeight) / 2)
      : 0;
  lines.forEach((line, index) => {
    const width = context.measureText(line).width;
    const x =
      align === "middle"
        ? (item.w - width) / 2
        : align === "end"
          ? item.w - width
          : 0;
    context.fillText(line, x, startY + index * lineHeight);
  });
  context.restore();
}

async function drawImage(
  context: Context2D,
  item: Extract<Item, { kind: "image" }>,
  resolve: RasterOptions["resolveImage"],
): Promise<void> {
  const url = resolve?.(item.assetPath);
  if (!url || typeof createImageBitmap !== "function") return;
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const bitmap = await createImageBitmap(await response.blob());
    context.drawImage(bitmap, item.x, item.y, item.w, item.h);
    bitmap.close?.();
  } catch {
    // 一张取不回来的图不该让整次导出失败：其余对象照画。
  }
}

/* -------------------------------- 入口 ------------------------------------ */

/**
 * 把一组白板对象画成 PNG。B5 的内容引用与图片粘贴的 SVG 栅格化都用它。
 *
 * 顺序按 `z` 升序（与画布上的压盖关系一致）。图片是异步的，所以整个
 * 函数是异步的——但同步的那些对象先画完，图片再补上去，避免为一张
 * 慢图把整张纸挂起。
 */
export async function rasterizeItems(
  items: readonly Item[],
  options: RasterOptions = {},
): Promise<Blob> {
  const plan = planRaster(items, options);
  const scheme = options.scheme ?? "light";
  const surface = createSurface(plan.pixelWidth, plan.pixelHeight);
  const context = surface.context;
  context.scale(plan.scale, plan.scale);
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, plan.w, plan.h);
  }
  context.translate(-plan.x, -plan.y);
  const ordered = [...items].sort((a, b) => a.z - b.z);
  const images: Promise<void>[] = [];
  for (const item of ordered) {
    switch (item.kind) {
      case "ink":
        drawInk(context, item, scheme);
        break;
      case "shape":
        drawShape(context, item, scheme);
        break;
      case "line":
        drawLine(context, item, scheme);
        break;
      case "text":
        drawText(context, item, scheme);
        break;
      case "image":
        images.push(drawImage(context, item, options.resolveImage));
        break;
    }
  }
  await Promise.all(images);
  return surface.toBlob();
}
