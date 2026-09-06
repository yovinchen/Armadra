import { BezierEdge, type EdgeTypes } from "@xyflow/react";

/**
 * React Flow 的边类型表（React Flow 计划 §5.3 的挂载点）。
 *
 * **B1 重建。** 上下文连线的贴边贝塞尔、箭头方向、中点标签在
 * `flow/edges/LinkEdge.tsx`（几何已经在 `flow/edges/link-path.ts`，
 * 从 从旧引擎原样搬过来的纯函数）；内容引用的 `reference` 由 B5 追加。
 *
 * B0 先把两种类型指向 React Flow 自带的贝塞尔边：连线画得出来、选得中、
 * 删得掉，只是还没有箭头与标签。留空会让 RF 对每条边报一次 unknown edge
 * type，那比一条朴素的曲线难看得多。
 *
 * 必须是模块级常量，理由同 `nodes/node-types.ts`。
 */
export const edgeTypes: EdgeTypes = {
  link: BezierEdge,
  reference: BezierEdge,
};
