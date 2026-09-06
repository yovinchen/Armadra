import { Handle, Position } from "@xyflow/react";

import { useT } from "@/app/preferences-store";

/**
 * 节点左右两侧的上下文链接把手（React Flow 计划 §2.5 / F06）。
 *
 * **B1 重建。** 那一批要补的是落点：节点整体套一个只在
 * `useConnection().inProgress` 时可命中的 `<Handle type="target" id="body">`，
 * 加上 `ConnectionMode.Loose` 与自绘的预览线。
 *
 * B0 先把两个 source 把手放上去——尺寸与命中区沿用平台设计 §4.1 的规格，
 * 样式仍在 `styles/nodes.css` 的 `.node-connection-handle`，一行没动。
 * 起笔的做法从「切 arrow 工具再放行 pointerdown」变成 React Flow 自己的
 * 把手拖拽，所以 `LinkArrow` 那一整套换形逻辑消失了。
 */
export function ConnectionHandles() {
  const t = useT();
  return (
    <>
      <Handle
        type="source"
        id="left"
        position={Position.Left}
        aria-label={t("node.linkIn")}
        className="node-connection-handle"
        data-slot="connection-handle"
        data-side="left"
      />
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        aria-label={t("node.linkOut")}
        className="node-connection-handle"
        data-slot="connection-handle"
        data-side="right"
      />
    </>
  );
}
