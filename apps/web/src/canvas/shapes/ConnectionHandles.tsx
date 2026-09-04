import * as React from "react";

import { useT } from "@/app/preferences-store";
import { getEditor } from "@/canvas/editor-context";
import { beginHandleLink, endHandleLink } from "./LinkArrow";

/**
 * 节点左右两侧的上下文链接把手（tldraw 计划 §4.3，归属 nodes）。
 *
 * 起笔的做法：按下时把当前工具切成 `arrow`，然后**放行**这次 pointerdown。
 * tldraw 的画布把所有指针事件都挂在 `.tl-canvas` 上（`useCanvasEvents`，
 * 一律 `target: "canvas"`），冒泡到那里时当前工具已经是箭头，于是箭头就在
 * 指针所在的位置起笔——不需要我们自己合成 `editor.dispatch`，也就不用去猜
 * 它期望的坐标系。松手后回到 select 工具。
 *
 * 绑定的合法性（自连、重复连）由 Phase 2 的 `LinkArrow` 副作用负责，
 * 把手只管起笔。
 */

export interface ConnectionHandlesProps {
  /** 节点色：把手是它的实心圆点。 */
  color: string;
}

type HandleSide = "left" | "right";

function startArrow(event: React.PointerEvent<HTMLDivElement>): void {
  if (event.button !== 0) return;
  const editor = getEditor();
  if (!editor) return;

  editor.setCurrentTool("arrow");
  // 「这一条线是从把手起笔的」——`LinkArrow` 在交互结束时读它：末端没绑到
  // 节点就把线删掉（把手只用来连节点，§4.3）。
  beginHandleLink();

  // 松手回到选择工具。箭头工具自己在 `isToolLocked=false` 时也会回退，
  // 这里再兜一层：拖到一半按 Esc / 拖成零长度都不会留在箭头工具上。
  const back = () => {
    const current = getEditor();
    if (current) current.setCurrentTool("select");
    // 只点了一下没拖出箭头：把标记收回来，免得留给下一条线。
    endHandleLink();
    window.removeEventListener("pointerup", back);
    window.removeEventListener("pointercancel", back);
  };
  window.addEventListener("pointerup", back);
  window.addEventListener("pointercancel", back);
}

function ConnectionHandle({
  side,
  color,
  label,
}: {
  side: HandleSide;
  color: string;
  label: string;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={label}
      data-slot="connection-handle"
      data-side={side}
      className="node-connection-handle"
      style={{ background: color }}
      onPointerDown={startArrow}
    />
  );
}

export function ConnectionHandles({ color }: ConnectionHandlesProps) {
  const t = useT();
  return (
    <>
      <ConnectionHandle side="left" color={color} label={t("node.linkIn")} />
      <ConnectionHandle side="right" color={color} label={t("node.linkOut")} />
    </>
  );
}
