import type { CSSProperties } from "react";
import { Handle, Position, useConnection } from "@xyflow/react";

import { useT } from "@/app/preferences-store";

/**
 * 节点的连线端口（React Flow 计划 §2.5 / F06，归属 B1）。
 *
 * 两件事：
 *
 *  1. **起笔**：左右两侧各一个 `type="source"` 的把手，尺寸与命中区沿用
 *     平台设计 §4.1（圆点 14 / 命中 34，触屏 16 / 36），样式仍在
 *     `styles/nodes.css` 的 `.node-connection-handle`。只有把手能起笔，
 *     节点体不能——否则在终端里划一下选文字就会拉出一条线。
 *  2. **落点**：整个节点体上盖一个 `type="target"` 的把手，`inset: 0`、
 *     完全透明，**只在有连线正在进行时**才接指针事件。这样拖过来的线可以
 *     落在节点身上的任何位置（不必精确瞄准 6px 的圆点），而平时它不存在，
 *     终端的点击、编辑器的选区、按钮全都照常。
 *
 * 落点把手为什么不能只靠 `connectionRadius`：那是按把手**中心**算距离的，
 * 24px 之外就吸不上；一个 800×400 的终端，从右边拖过来时最近的左把手中心
 * 可能在 300px 开外。RF 的命中判定优先看指针正下方的 `.react-flow__handle`
 * （`XYHandle.isValid` 的 `elementFromPoint`），铺满节点的落点正好吃这一条。
 */

/** 起笔的把手一律不当落点：线要落在节点体上，不是落在 6px 的圆点上。 */
const SOURCE_ONLY = { isConnectableStart: true, isConnectableEnd: false };

/**
 * 落点把手的样式全部写成内联：RF 默认的 `.react-flow__handle` 是 6px 的
 * 圆点，而这里要的是一块铺满节点的透明区域。写内联而不是加一条 CSS 规则，
 * 是因为 `styles/canvas.css` 不归这一批（§5.1 的所有权表）。
 */
const BODY_HANDLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  transform: "none",
  border: "none",
  borderRadius: "var(--r-card)",
  background: "transparent",
  opacity: 0,
  minWidth: 0,
  minHeight: 0,
};

export interface ConnectionHandlesProps {
  /**
   * 只给落点，不给起笔的把手（分组与白板对象用）。分组自己有标题与色带，
   * 白板对象是一笔墨迹或一个形状，左右挂两个圆点既没地方放也没意义，但它们
   * 仍然可以是一条连线 / 一条内容引用的一端。
   */
  dropOnly?: boolean;
}

export function ConnectionHandles({
  dropOnly = false,
}: ConnectionHandlesProps = {}) {
  const t = useT();
  // 只订阅「有没有连线在进行中」这一个布尔量：连线过程中指针每动一下
  // `ConnectionState` 都在变，整份订阅会让画布上每个节点跟着重渲。
  const connecting = useConnection((connection) => connection.inProgress);

  return (
    <>
      {dropOnly ? null : (
        <>
          <Handle
            type="source"
            id="left"
            position={Position.Left}
            aria-label={t("node.linkIn")}
            className="node-connection-handle"
            data-slot="connection-handle"
            data-side="left"
            {...SOURCE_ONLY}
          />
          <Handle
            type="source"
            id="right"
            position={Position.Right}
            aria-label={t("node.linkOut")}
            className="node-connection-handle"
            data-slot="connection-handle"
            data-side="right"
            {...SOURCE_ONLY}
          />
        </>
      )}
      <Handle
        type="target"
        id="body"
        // `position` 只决定 RF 给的 CSS 类；铺满节点的落点靠上面的内联样式。
        position={Position.Left}
        isConnectableStart={false}
        // 分组在投影里是 `connectable: false`（`sync/project.ts`），
        // 但落点必须带上 `connectable` 类才会被 `XYHandle.isValid` 认。
        isConnectable
        data-slot="connection-drop"
        style={{
          ...BODY_HANDLE,
          pointerEvents: connecting ? "all" : "none",
        }}
      />
      {/*
       * 只有落点的节点还需要一个**从不参与交互**的 source 锚点：
       * `getEdgePosition` 找不到起点侧的把手就整条边不画（`error008`），
       * 而分组与白板对象身上一个 source 把手都没有。内容引用的 `source`
       * 恒为白板对象（`sync/project.projectReference`），少了这个锚点整条
       * 引用边就不存在。它永远 `pointer-events: none`，所以
       * `elementFromPoint` 不会选中它，也起不了笔。
       */}
      {dropOnly ? (
        <Handle
          type="source"
          id="anchor"
          position={Position.Right}
          isConnectableStart={false}
          isConnectableEnd={false}
          data-slot="connection-anchor"
          style={{ ...BODY_HANDLE, pointerEvents: "none" }}
        />
      ) : null}
    </>
  );
}
