import type { NodeTypes } from "@xyflow/react";

import ArmadraNode from "./ArmadraNode";
import GroupNode from "./GroupNode";
import ImageNode from "../../whiteboard/nodes/ImageNode";
import InkNode from "../../whiteboard/nodes/InkNode";
import LineNode from "../../whiteboard/nodes/LineNode";
import ShapeNode from "../../whiteboard/nodes/ShapeNode";
import TextNode from "../../whiteboard/nodes/TextNode";

/**
 * React Flow 的节点类型表（React Flow 计划 §5.3 的挂载点，归属 canvas）。
 *
 * 这是 B1 / B2 接进画布的唯一入口：`FlowWorkspace` 只 import 这一个常量，
 * 新增一种节点就在这里加一行，不用碰 B0 的装配文件。
 *
 * 白板对象（`wb.ink` / `wb.text` / `wb.shape` / `wb.image` / `wb.line`）
 * 的节点体在 `whiteboard/nodes/`，键名与 `Item["kind"]` 一一对应
 * （`sync/project.ts` 直接拼 `wb.${item.kind}`）。
 *
 * 必须是模块级常量：每渲染一次就换一个新对象会让 React Flow 把所有节点
 * 全部卸载重建，终端与编辑器的实例会跟着一起没。
 */
export const nodeTypes: NodeTypes = {
  armadra: ArmadraNode,
  group: GroupNode,
  "wb.ink": InkNode,
  "wb.text": TextNode,
  "wb.shape": ShapeNode,
  "wb.image": ImageNode,
  "wb.line": LineNode,
};
