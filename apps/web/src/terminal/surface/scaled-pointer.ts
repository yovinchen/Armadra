import type { Terminal } from "@xterm/xterm";

/**
 * xterm 在被 CSS `transform: scale()` 缩放的容器里选区会偏：它用
 * `getBoundingClientRect()`（已缩放）减去 `clientX`，再除以**未缩放**的
 * 单元格宽度，所以 62% 缩放下点第 100 列会落到第 62 列（2026-09-16 用户
 * 反馈「不能指哪复制哪」）。React Flow 的视口就是这样缩放节点的。
 *
 * xterm 没有公开入口，这里包一层它内部 `MouseService` 的两个坐标函数：把
 * 事件坐标先按容器的实际缩放比折回未缩放空间，其余逻辑不动。私有 API，
 * 所以找不到时**什么都不做**而不是抛错——那样最多是老样子的偏移。
 */

interface PointerLike {
  clientX: number;
  clientY: number;
}

interface MouseServiceLike {
  getCoords: (
    event: PointerLike,
    element: HTMLElement,
    ...rest: unknown[]
  ) => unknown;
  getMouseReportCoords: (event: PointerLike, element: HTMLElement) => unknown;
}

/** 容器当前的视觉缩放比：布局宽度不随 transform 变，rect 会。 */
export function scaleOf(element: HTMLElement): number {
  const width = element.offsetWidth;
  const rect = element.getBoundingClientRect();
  if (!(width > 0) || !(rect.width > 0)) return 1;
  return rect.width / width;
}

/**
 * 同一个点在「容器没有被缩放」时的 client 坐标。缩放比接近 1 时原样返回，
 * 避免每次事件都分配对象。
 */
export function unscaledPoint<T extends PointerLike>(
  event: T,
  element: HTMLElement,
): T | PointerLike {
  const scale = scaleOf(element);
  if (Math.abs(scale - 1) < 0.001) return event;
  const rect = element.getBoundingClientRect();
  return {
    clientX: rect.left + (event.clientX - rect.left) / scale,
    clientY: rect.top + (event.clientY - rect.top) / scale,
  };
}

function mouseServiceOf(terminal: Terminal): MouseServiceLike | null {
  const core = (terminal as unknown as { _core?: { _mouseService?: unknown } })
    ._core;
  const service = core?._mouseService as Partial<MouseServiceLike> | undefined;
  if (
    !service ||
    typeof service.getCoords !== "function" ||
    typeof service.getMouseReportCoords !== "function"
  ) {
    return null;
  }
  return service as MouseServiceLike;
}

/**
 * 在 `terminal.open()` 之后调用。返回的函数把两个方法恢复原样。
 */
export function compensateScaledPointer(terminal: Terminal): () => void {
  const service = mouseServiceOf(terminal);
  if (!service) return () => undefined;
  const getCoords = service.getCoords;
  const getMouseReportCoords = service.getMouseReportCoords;
  service.getCoords = function (this: unknown, event, element, ...rest) {
    return getCoords.call(
      this,
      unscaledPoint(event, element),
      element,
      ...rest,
    );
  };
  service.getMouseReportCoords = function (this: unknown, event, element) {
    return getMouseReportCoords.call(
      this,
      unscaledPoint(event, element),
      element,
    );
  };
  return () => {
    service.getCoords = getCoords;
    service.getMouseReportCoords = getMouseReportCoords;
  };
}
