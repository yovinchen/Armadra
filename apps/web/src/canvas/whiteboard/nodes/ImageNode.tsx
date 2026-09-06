import * as React from "react";
import type { Node, NodeProps } from "@xyflow/react";

import { useCanvasStore } from "@/store/canvas-store";
import { assetUrlFor } from "../../assets";
import type { ImageItem } from "../model";
import { ItemFrame } from "./ItemFrame";

/**
 * 图片（React Flow 计划 F26，归属 whiteboard）。
 *
 * 文档里只有 `assetPath`（工作区相对路径）；显示地址每次渲染现算
 * （`assets.assetUrlFor`）——存下来的 `http://127.0.0.1:<port>` 在下一次
 * 启动时可能指向别人的端口，那样重开应用所有图片都会碎掉。
 *
 * resize 锁比例：白板上的图不该被拉扁，要裁剪请回到图片工具（§1.3 明确
 * 放弃了裁剪与翻转）。
 */

export type ImageFlowNode = Node<ImageItem, "wb.image">;

export function ImageNode({
  data,
  selected = false,
}: NodeProps<ImageFlowNode>) {
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const src = assetUrlFor(workspaceId, data.assetPath);
  const [broken, setBroken] = React.useState(false);

  return (
    <ItemFrame item={data} selected={selected} keepAspectRatio>
      {src && !broken ? (
        <img
          src={src}
          alt={data.alt ?? ""}
          draggable={false}
          onError={() => setBroken(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "fill",
            display: "block",
            userSelect: "none",
            pointerEvents: "none",
          }}
        />
      ) : (
        // 资产没了（换工作区、文件被删）也要留个占位：白板上突然少一块
        // 比看到一个空框更难排查。
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "grid",
            placeItems: "center",
            border: "1px dashed var(--border)",
            borderRadius: 4,
            color: "var(--muted-foreground)",
            fontSize: "var(--text-caption)",
            overflow: "hidden",
            padding: 4,
          }}
        >
          {data.alt || data.assetPath}
        </div>
      )}
    </ItemFrame>
  );
}

export default React.memo(ImageNode);
