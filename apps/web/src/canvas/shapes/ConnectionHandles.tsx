import * as React from "react";
import type { TLShapeId } from "tldraw";

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

type HandleSide = "left" | "right";

function canStart(event: React.PointerEvent<HTMLDivElement>): boolean {
  return (
    event.button === 0 &&
    !(event.pointerType === "touch" && event.isPrimary === false)
  );
}

function startArrow(
  event: React.PointerEvent<HTMLDivElement>,
): (() => void) | undefined {
  const editor = getEditor();
  if (!editor) return;
  const pointerId = event.pointerId;
  editor.setCurrentTool("arrow");
  const shapeId =
    event.currentTarget.closest<HTMLElement>("[data-shape-id]")?.dataset
      .shapeId;
  const gesture = beginHandleLink(
    event.currentTarget.dataset.side as HandleSide,
    shapeId as TLShapeId | undefined,
    editor,
  );
  let active = true;
  const finish = (returnToSelect: boolean) => {
    if (!active) return;
    active = false;
    window.removeEventListener("pointerup", back);
    window.removeEventListener("pointercancel", back);
    window.removeEventListener("keydown", clearOnEscape);
    // Unmount / an old pointerup must not clear another handle's pending start.
    const owned = endHandleLink(gesture);
    if (returnToSelect && owned && getEditor() === editor)
      editor.setCurrentTool("select");
  };
  const back = (event: PointerEvent) => {
    if (event.pointerId === pointerId) finish(true);
  };
  const clearOnEscape = (event: KeyboardEvent) => {
    // Native canvas Escape owns cancellation / history rollback. Only retire
    // this gesture's listeners here, without overriding another editor's tool.
    if (event.key === "Escape") finish(false);
  };
  window.addEventListener("keydown", clearOnEscape);
  window.addEventListener("pointerup", back);
  window.addEventListener("pointercancel", back);
  return () => finish(false);
}

function ConnectionHandle({
  side,
  label,
}: {
  side: HandleSide;
  label: string;
}) {
  const cleanupGesture = React.useRef<(() => void) | undefined>(undefined);
  React.useEffect(() => () => cleanupGesture.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canStart(event)) return;
    cleanupGesture.current?.();
    cleanupGesture.current = startArrow(event);
  };
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={label}
      data-slot="connection-handle"
      data-side={side}
      className="node-connection-handle"
      onPointerDown={onPointerDown}
    />
  );
}

export function ConnectionHandles() {
  const t = useT();
  return (
    <>
      <ConnectionHandle side="left" label={t("node.linkIn")} />
      <ConnectionHandle side="right" label={t("node.linkOut")} />
    </>
  );
}
