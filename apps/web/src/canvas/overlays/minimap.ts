import type { AgentGlow } from "@/agent/status-store";

/**
 * 缩略图的几何与配色（tldraw 计划 §3.2 / Phase 2「overlays」）。
 *
 * 为什么不用 tldraw 的 `DefaultMinimap`：`MinimapManager` 把整页 shape 合成
 * **两条** `Path2D`（选中 / 未选中），再各刷一次颜色，颜色来自容器上的 4 个
 * 全局变量（`--tl-color-text-3 / -selected / -muted-1 / -low`）。也就是说
 * 「按 shape 上色」在它的渲染模型里没有位置——要么给库打补丁，要么自己画。
 * 我们自己画：一屏 200×150 的 canvas，节点矩形按 Agent 状态描边。
 *
 * 这个文件只有纯函数（几何 + 颜色），组件在 `StatusMinimap.tsx`。
 */

export interface MinimapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinimapPoint {
  x: number;
  y: number;
}

/** 画布上要画的一块矩形；`glow` 只有节点有。 */
export interface MinimapItem {
  /** 节点 id（`armadra` shape）或 shape id（白板内容）。 */
  id: string;
  rect: MinimapRect;
  /** Legacy input only; custom node colours are no longer rendered. */
  color?: string;
  glow?: AgentGlow;
  selected?: boolean;
  /** 白板原生 shape：只画一块低对比的底，不描边。 */
  plain?: boolean;
}

/** 画笔用的颜色，全部由 `styles/tokens.css` 解析出来的实色/带透明度的 rgb。 */
export interface MinimapPalette {
  /** working：陶土色 `--agent-working`。 */
  working: string;
  /** needs-you：`--danger`。 */
  attention: string;
  /** 未读：`--brand`。 */
  unread: string;
  /** 白板 shape 的底色：`--muted-foreground`。 */
  shape: string;
  /** 视口框：`--active`。 */
  viewport: string;
  /** 视口框的描边：`--muted-foreground`。 */
  viewportStroke: string;
  /** 缩略图底：`--surface-deep`。 */
  background: string;
}

/**
 * 状态 → 描边色（§3.2）。
 *
 * 三种状态的优先级由 `agentHeaderState()` 定好了（一个节点同一时刻只会有
 * 一种光晕），这里只做映射；没有状态的节点使用中性描边。
 */
export function minimapStroke(
  item: Pick<MinimapItem, "glow" | "color" | "plain">,
  palette: MinimapPalette,
): string {
  if (item.plain) return palette.shape;
  switch (item.glow) {
    case "working":
      return palette.working;
    case "attention":
      return palette.attention;
    case "unread":
      return palette.unread;
    default:
      return palette.shape;
  }
}

/** 有状态的节点画粗一点：缩略图上 1px 的色差不够，粗细才看得见。 */
export function minimapStrokeWidth(item: Pick<MinimapItem, "glow">): number {
  return item.glow ? 2 : 1;
}

/** 矩形填充的透明度：选中的节点实一点，白板内容淡一点。 */
export function minimapFillAlpha(
  item: Pick<MinimapItem, "plain" | "selected">,
): number {
  if (item.plain) return 0.35;
  return item.selected ? 0.55 : 0.28;
}

/** 两个矩形的并集；两个都缺就返回 `undefined`。 */
export function unionRect(
  a: MinimapRect | undefined,
  b: MinimapRect | undefined,
): MinimapRect | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * 内容包围盒 → 缩略图实际显示的那块页面区域。
 *
 * 按 canvas 的宽高比往外扩（只扩不裁），这样内容永远完整可见，且不变形。
 * 与 `MinimapManager.getCanvasPageBounds` 同一套算法，换掉是为了能单测。
 */
export function fitPageBounds(
  content: MinimapRect,
  aspect: number,
): MinimapRect {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  let width = Math.max(content.width, 1);
  let height = width / safeAspect;
  const contentHeight = Math.max(content.height, 1);
  if (height < contentHeight) {
    height = contentHeight;
    width = height * safeAspect;
  }
  return {
    x: content.x + content.width / 2 - width / 2,
    y: content.y + content.height / 2 - height / 2,
    width,
    height,
  };
}

/** 缩略图 CSS 像素 / 页面单位。 */
export function minimapZoom(view: MinimapRect, canvasWidth: number): number {
  return view.width > 0 ? canvasWidth / view.width : 1;
}

/** 缩略图内的坐标（相对 canvas 左上角）→ 页面坐标。 */
export function minimapPointToPage(
  point: MinimapPoint,
  view: MinimapRect,
  canvas: { width: number; height: number },
): MinimapPoint {
  const width = canvas.width || 1;
  const height = canvas.height || 1;
  return {
    x: view.x + (point.x / width) * view.width,
    y: view.y + (point.y / height) * view.height,
  };
}

/** 页面坐标落在哪个节点上（后画的在上面，所以倒着找）。 */
export function itemAtPoint(
  point: MinimapPoint,
  items: readonly MinimapItem[],
): MinimapItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.plain) continue;
    const { x, y, width, height } = item.rect;
    if (
      point.x >= x &&
      point.x <= x + width &&
      point.y >= y &&
      point.y <= y + height
    ) {
      return item;
    }
  }
  return undefined;
}

/** 矩形中心，点缩略图定位到节点时用。 */
export function rectCenter(rect: MinimapRect): MinimapPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
