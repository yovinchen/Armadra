import type { Position } from "@armadra/shared";

/**
 * 「始终吸附」偏好的落点换算（React Flow 计划 §2.10 的 `snap`）。
 *
 * 节点拖动的吸附归 React Flow（`flow-options.snapToGrid` / `snapGrid`），
 * 但工具层自己算落点——画笔的每一个采样点、双击建出来的文字——所以那一份
 * 换算在这里，两条路读的是同一个偏好、同一个间距。
 */
export function snapToGrid(
  point: Position,
  grid: number,
  snap: boolean,
): Position {
  if (!snap || grid <= 0) return point;
  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid,
  };
}
