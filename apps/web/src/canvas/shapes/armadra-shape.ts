import type { CanvasNode, CanvasNodeData } from "@armadra/shared";
import type { TLShape, TLShapeId } from "tldraw";

/**
 * 节点 shape 的记录形状（tldraw 计划 §4.1，归属 nodes）。
 *
 * `props` 直接镜像 `CanvasNode`，只是 `position` / `size` 换成了 shape 自己的
 * `x / y / w / h`。`data` 与 shared 的 discriminatedUnion 完全一致，节点体
 * 代码读到的东西和 React Flow 时代一模一样。
 *
 * 分组不在这里：分组是 tldraw 原生 `frame`（§4.2），所以 `nodeType` 是七种
 * 节点类型里除分组以外的六种。
 */
export type ArmadraNodeType = Exclude<CanvasNode["type"], "group">;

export interface ArmadraProps {
  w: number;
  h: number;
  nodeType: ArmadraNodeType;
  title: string;
  color: string;
  collapsed: boolean;
  /** 折叠前的高度；展开时还原。0 表示没记过。 */
  expandedHeight: number;
  labels: string[];
  note: string;
  data: CanvasNodeData;
  /** ISO 时间戳，落库时原样写回 `nodes` 行。 */
  createdAt: string;
}

/** tldraw 5.4 的自定义 shape 走全局类型注册（Phase 0 结论 4）。 */
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    armadra: ArmadraProps;
  }
}

export type ArmadraShape = TLShape<"armadra">;

/* ------------------------------- id 映射 ---------------------------------- */

/**
 * shape id 与节点 id 的双向映射（§4.1）：`shape:<节点 uuid>`。
 * 边同理：arrow 的 id 是 `shape:<边 uuid>`。不查表，纯字符串。
 */
export function toShapeId(nodeId: string): TLShapeId {
  return `shape:${nodeId}` as TLShapeId;
}

export function toNodeId(shapeId: TLShapeId | string): string {
  return shapeId.startsWith("shape:") ? shapeId.slice("shape:".length) : shapeId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `nodes` / `edges` 行的 id 一律是 uuid（zod 在 shared 里就这么定的）。 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** 只有 uuid 形状的 shape id 才可能对应一条 `nodes` / `edges` 行。 */
export function isDocumentShapeId(shapeId: TLShapeId | string): boolean {
  return isUuid(toNodeId(shapeId));
}
