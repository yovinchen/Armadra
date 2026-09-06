import { BezierEdge, type EdgeTypes } from "@xyflow/react";

import LinkEdge from "./LinkEdge";

/**
 * React Flow 的边类型表（React Flow 计划 §5.3 的挂载点）。
 *
 * `link` 是上下文连线（`edges` 表的一行，B1）；`reference` 是内容引用
 * （`whiteboard.references` 的一行，B5）。后者暂时指向 React Flow 自带的
 * 贝塞尔边：画得出来、选得中、删得掉，只是还没有单箭头与静音配色。
 * 留空会让 RF 对每条边报一次 unknown edge type，那比一条朴素的曲线难看。
 *
 * 必须是模块级常量：每渲染一次就换一个新对象会让 React Flow 把所有边
 * 卸载重建。
 */
export const edgeTypes: EdgeTypes = {
  link: LinkEdge,
  reference: BezierEdge,
};
