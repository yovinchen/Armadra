import type { Position } from "@armadra/shared";

import { containerSize, getFlow, screenToPage } from "../flow/flow-context";

/**
 * 最近一次指针位置（React Flow 计划 §2.8，归属 canvas）。
 *
 * 只为一件事存在：「粘贴到光标处」偏好（`pasteAtCursor`）。粘贴事件本身
 * 没有坐标——它是键盘触发的——所以落点只能靠记住鼠标最后停在哪。
 *
 * 模块级变量，不进 store：它每移动一像素就变一次，进 store 会让 45 个
 * 消费方跟着重渲，而它对界面没有任何影响。
 */

let lastScreenPoint: Position | null = null;

export function rememberPointer(point: Position): void {
  lastScreenPoint = { x: point.x, y: point.y };
}

export function forgetPointer(): void {
  lastScreenPoint = null;
}

/** 最近一次的屏幕坐标；从来没动过鼠标（键盘操作、触屏）时是 null。 */
export function lastPointerScreen(): Position | null {
  return lastScreenPoint;
}

/** 画布挂载时装一个 `pointermove` 监听；卸载时摘掉。 */
export function trackPointer(container: HTMLElement): () => void {
  const onMove = (event: PointerEvent) =>
    rememberPointer({ x: event.clientX, y: event.clientY });
  container.addEventListener("pointermove", onMove);
  return () => {
    container.removeEventListener("pointermove", onMove);
    forgetPointer();
  };
}

/**
 * 视口中心的画布坐标。画布没挂载时回原点——调用方拿到的仍是一个合法
 * 落点，粘贴出来的东西在 (0,0)，总比抛异常好。
 */
export function viewportCentre(): Position {
  const flow = getFlow();
  const { width, height } = containerSize();
  if (!flow || width <= 0 || height <= 0) return { x: 0, y: 0 };
  return flow.screenToFlowPosition({ x: width / 2, y: height / 2 });
}

/**
 * 粘贴落点（§2.8）：偏好开着且真的知道指针在哪时用指针，否则用视口中心。
 */
export function pastePoint(pasteAtCursor: boolean): Position {
  if (!pasteAtCursor || !lastScreenPoint) return viewportCentre();
  return screenToPage(lastScreenPoint);
}
