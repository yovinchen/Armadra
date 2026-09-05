import type { Viewport } from "@ai-coding-canvas/shared";

/**
 * 缩放（§21）。
 *
 * 手势分工：触控板捏合与 ⌘/Ctrl + 滚轮缩放，普通滚轮平移（Shift 横向），
 * 空格 + 拖拽平移。所以画布把 React Flow 的 `zoomOnScroll` 关掉，只留
 * `zoomOnPinch` + `panOnScroll`，⌘ 滚轮这一路自己在捕获阶段算。
 *
 * 这里只有数学，没有 React：视口变换要能单测，不能只在浏览器里试。
 */

/** 缩放范围（§21）。 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;

/** ⌘= / ⌘- 每次的倍率，以及缩放动画时长。 */
export const ZOOM_STEP = 1.2;
export const ZOOM_DURATION = 120;

/**
 * 单个滚轮事件计入缩放的最大增量。
 *
 * 触控板捏合一次给的是几十个 `deltaY: ±2~8` 的事件，而鼠标滚轮一格
 * 直接给 ±100——同一个公式下前者细腻、后者一格就 2.7 倍。夹住增量，
 * 一次事件最多 e^0.4 ≈ 1.49 倍，触控板那一路完全不受影响。
 */
export const MAX_WHEEL_DELTA = 40;

/**
 * 滚轮增量 → 缩放倍率。
 *
 * 指数而不是线性：这样「上滚 3 格再下滚 3 格」能回到原来的缩放，
 * 而线性步进会一路漂移。系数 0.01 是 macOS 触控板一档（约 ±4）大致
 * 对应 4% 的缩放，够细但不迟钝。
 */
export function wheelZoomFactor(deltaY: number, sensitivity = 0.01): number {
  if (!Number.isFinite(deltaY)) return 1;
  const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, deltaY));
  return Math.exp(-delta * sensitivity);
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * 以 `point`（画布容器内的屏幕坐标）为不动点缩放到 `zoom`。
 *
 * 推导：光标下的画布坐标 `f = (p - v) / z` 在缩放前后必须相同，
 * 于是新的平移量就是 `p - f * z'`。夹在 [0.1, 3] 之后再算，
 * 所以到边界时画面不会继续飘。
 */
export function zoomAroundPoint(
  viewport: Viewport,
  zoom: number,
  point: { x: number; y: number },
): Viewport {
  const next = clampZoom(zoom);
  const scale = viewport.zoom || 1;
  const flowX = (point.x - viewport.x) / scale;
  const flowY = (point.y - viewport.y) / scale;
  return {
    x: point.x - flowX * next,
    y: point.y - flowY * next,
    zoom: next,
  };
}

/** 以容器中心为不动点缩放（⌘0 / ⌘= / ⌘- 用）。 */
export function zoomAroundCentre(
  viewport: Viewport,
  zoom: number,
  size: { width: number; height: number },
): Viewport {
  return zoomAroundPoint(viewport, zoom, {
    x: size.width / 2,
    y: size.height / 2,
  });
}

/**
 * 这个滚轮事件应该由画布来处理吗？
 *
 * 终端体（`nowheel`）里的滚轮是 tmux 的滚屏桥，浏览器节点里的滚轮是网页
 * 自己的滚动——两者都不该缩放画布。React Flow 只认 `nowheel`，而 iframe
 * 的滚轮事件根本不冒泡出来，所以这里只要挡住 `nowheel` 子树即可。
 */
export function wheelBelongsToCanvas(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (!element) return true;
  return !element.closest(".nowheel");
}
