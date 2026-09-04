import type { CanvasEdgeKind } from "@ai-coding-canvas/shared";
import type { TLBinding, TLBindingId, TLShape, TLShapeId } from "tldraw";

import { isUuid, toNodeId } from "./aicc-shape";

/**
 * 上下文链接的自定义 shape（tldraw 计划 §4.3，Phase 3 归属 link-shape）。
 *
 * 为什么不用 tldraw 原生 `arrow`：原生箭头的两端锚点是**节点矩形内部的一点**
 * （`normalizedAnchor` 默认在中心），画出来是一条被边框裁掉的直线。v3 的连线
 * 是「从两个节点相对的边的中点出发的贝塞尔」，那套几何还在
 * `canvas/geometry.ts`（`facingSides` / `anchorPoint` / `bezierPath`），
 * 所以这里自己画一条 shape，几何直接复用它。
 *
 * 记录形状：
 *
 *  - **`x` / `y` 永远是 0**，路径坐标就是页面坐标。这样节点一动，link 的记录
 *    一个字节都不用改——`getGeometry` / `component` 在读两端 `getShapePageBounds`
 *    时被 tldraw 的响应式系统订阅，节点移动 / resize / 折叠会自动重算重绘。
 *    （`shapes/LinkArrow.ts` 里有一条 before-change 守卫把 `x/y` 钉回 0，
 *    免得用户把线拖离两端。）
 *  - **两端记在 `props.from` / `props.to`**，同时各有一条 `link` binding。
 *    props 负责几何与派生，binding 负责生命周期（节点删了就删线）。link 没有
 *    把手，两端建好之后不会再改，所以两者不会走岔。
 *  - id 是 `shape:link-<边 uuid>`：**故意不是** `shape:<uuid>`，否则
 *    `isDocumentShapeId` 会把它当成一个节点 shape（选中投影、删除分流、
 *    右键菜单三处都按那条规则认节点）。
 */

export interface LinkProps {
  /** 起点节点的 shape id（`shape:<节点 uuid>`）。 */
  from: string;
  /** 终点节点的 shape id。 */
  to: string;
  /** `edges` 行的 uuid。 */
  edgeId: string;
  kind: CanvasEdgeKind;
  createdAt: string;
  updatedAt: string;
}

export interface LinkBindingProps {
  terminal: "start" | "end";
}

/** tldraw 5.4 的自定义 shape / binding 走全局类型注册（Phase 0 结论 4）。 */
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    link: LinkProps;
  }
  interface TLGlobalBindingPropsMap {
    link: LinkBindingProps;
  }
}

export type LinkShape = TLShape<"link">;
export type LinkBinding = TLBinding<"link">;

export const LINK_SHAPE_TYPE = "link";

/* ------------------------------- id 映射 ---------------------------------- */

const LINK_PREFIX = "shape:link-";

export function toLinkShapeId(edgeId: string): TLShapeId {
  return `${LINK_PREFIX}${edgeId}` as TLShapeId;
}

/** 这个 shape id 对应哪条边？不是 link 的 id 时返回 null。 */
export function linkEdgeIdOfShapeId(shapeId: TLShapeId | string): string | null {
  if (!shapeId.startsWith(LINK_PREFIX)) return null;
  const id = shapeId.slice(LINK_PREFIX.length);
  return isUuid(id) ? id : null;
}

/** 一条边的两个 binding id：`binding:link-<边 uuid>-start` / `-end`。 */
export function toLinkBindingId(
  edgeId: string,
  terminal: "start" | "end",
): TLBindingId {
  return `binding:link-${edgeId}-${terminal}` as TLBindingId;
}

/* -------------------------------- 判定 ------------------------------------ */

export function isLinkShape(shape: {
  type: string;
}): shape is LinkShape {
  return shape.type === LINK_SHAPE_TYPE;
}

/** link 的两端节点 id（uuid）。绑到非节点 shape 时那一端是 null。 */
export function linkEnds(shape: LinkShape): {
  source: string | null;
  target: string | null;
} {
  const at = (id: string): string | null => {
    const nodeId = toNodeId(id);
    return isUuid(nodeId) ? nodeId : null;
  };
  return { source: at(shape.props.from), target: at(shape.props.to) };
}
