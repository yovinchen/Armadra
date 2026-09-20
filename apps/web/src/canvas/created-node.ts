import * as React from "react";

import { onWorkspaceEvent } from "../api/events";
import { useCanvasStore } from "../store/canvas-store";
import { hasDrafts } from "./flow/drafts";
import { revealNewNode } from "./flow/use-flow-viewport";

/**
 * Agent 建的节点，和人在菜单里建的节点一样被送到眼前（`node.created`）。
 *
 * 手动新建做两件事：选中它、把相机对准它（`menus/add-menu.ts` 的
 * `create()`）。控制动词建的节点以前只是悄悄出现在画布某个角落——同一个
 * 结果走了两条路。现在两条路都调 {@link revealCreatedNode}，差别只剩「要
 * 不要做」这个判断，而那个判断是下面这个纯函数。
 *
 * 这条事件是广播：同一个工作空间的每个页面、每台设备都会收到。所以判断
 * 必须能说清「谁该跟过去」：
 *
 *  1. **只有正开着这块画布的页面**。别的页面开着别的板，把它拽到一个它
 *     没在看的节点上是纯粹的打扰。
 *  2. **只有看得见的页面**。后台标签页跟过去，用户回来时画布已经被挪过
 *     了，而他根本没看见是谁挪的。
 *  3. **用户正在拖拽 / 缩放时不抢**。手势中途换相机会让指针和节点错位。
 *  4. **用户正在输入时不抢**。改选区会把便签、文字对象的编辑态顶掉。
 *     终端不算输入：终端里有键盘焦点是常态（Agent 正是从那里发的动词），
 *     而换选区既不会打断它，也不会把焦点抢走。
 */

/** xterm 的隐藏输入框；终端有焦点不算「用户正在输入」。 */
export const TERMINAL_INPUT_CLASS = "xterm-helper-textarea";

export interface CreatedNodeGate {
  /** 事件说的那块画布。 */
  eventBoardId: string;
  /** 这个页面正开着的画布；没开就是 `null`。 */
  openBoardId: string | null;
  /** 页面在前台（`document.visibilityState === "visible"`）。 */
  pageVisible: boolean;
  /** 有手势正在进行（拖拽 / resize）。 */
  gesturing: boolean;
  /** 键盘焦点在一个正在编辑的文本框里。 */
  typing: boolean;
}

export function shouldRevealCreatedNode(gate: CreatedNodeGate): boolean {
  if (gate.openBoardId === null) return false;
  if (gate.eventBoardId !== gate.openBoardId) return false;
  if (!gate.pageVisible) return false;
  if (gate.gesturing) return false;
  if (gate.typing) return false;
  return true;
}

/** 焦点所在的元素算不算「正在输入」。 */
export function isTextEntry(
  element: {
    tagName?: string;
    isContentEditable?: boolean;
    classList?: { contains(name: string): boolean };
  } | null,
): boolean {
  if (!element) return false;
  if (element.classList?.contains(TERMINAL_INPUT_CLASS)) return false;
  const tag = element.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  return element.isContentEditable === true;
}

/** 当下这个页面的闸门取值。 */
function gateFor(eventBoardId: string): CreatedNodeGate {
  const state = useCanvasStore.getState();
  return {
    eventBoardId,
    openBoardId: state.document?.board.id ?? null,
    pageVisible:
      typeof document === "undefined" || document.visibilityState === "visible",
    gesturing: hasDrafts(),
    typing:
      typeof document === "undefined"
        ? false
        : isTextEntry(document.activeElement as HTMLElement | null),
  };
}

/**
 * 选中 + 把相机对准它。手动新建（`add-menu.ts`）与 `node.created` 共用。
 *
 * `addNode` 自己已经选中了新节点，这里再选一次是幂等的；两条路都走这一个
 * 函数，是为了「新建之后会发生什么」只有一处定义。
 */
export function revealCreatedNode(nodeId: string): void {
  if (!nodeId) return;
  useCanvasStore.getState().selectNodes([nodeId]);
  revealNewNode(nodeId);
}

/* --------------------------- node.created 那一路 -------------------------- */

/**
 * 事件到的时候节点还没到：事件本身不带节点，画布要等 `board.changed` 触发
 * 的那次重取（`app/use-board-sync.ts`）把它合进来。所以先记下来，等它出现
 * 在文档里再动相机。
 */
interface Pending {
  nodeId: string;
  boardId: string;
  at: number;
}

/** 等了这么久还没出现就不等了：那次重取多半失败了，或者板被切走了。 */
export const PENDING_TTL_MS = 30_000;

let pending: Pending | null = null;

/** 仅测试用：清掉等待中的那一个。 */
export function clearPendingReveal(): void {
  pending = null;
}

export function pendingRevealId(): string | null {
  return pending?.nodeId ?? null;
}

/** 收到一条 `node.created`。返回值只为测试可读。 */
export function noteCreatedNode(
  event: { boardId: string; nodeId: string },
  now: number = Date.now(),
): boolean {
  if (!shouldRevealCreatedNode(gateFor(event.boardId))) return false;
  pending = { nodeId: event.nodeId, boardId: event.boardId, at: now };
  return applyPendingReveal(now);
}

/**
 * 节点到了吗？到了就送过去。
 *
 * 闸门在这里**再判一次**：从事件到达到节点落地之间用户可能已经动手拖了，
 * 或者切到了别的板。那时候就不跟了——节点已经在画布上，不差这一次相机。
 */
export function applyPendingReveal(now: number = Date.now()): boolean {
  const waiting = pending;
  if (!waiting) return false;
  if (now - waiting.at > PENDING_TTL_MS) {
    pending = null;
    return false;
  }
  const document = useCanvasStore.getState().document;
  if (!document || document.board.id !== waiting.boardId) return false;
  if (!document.nodes.some((node) => node.id === waiting.nodeId)) return false;
  pending = null;
  if (!shouldRevealCreatedNode(gateFor(waiting.boardId))) return false;
  revealCreatedNode(waiting.nodeId);
  return true;
}

/**
 * 画布挂载期间订阅 `node.created`。
 *
 * 订阅 store 用 `subscribe` 而不是选择器 hook：这个 hook 住在
 * `FlowWorkspace` 里，为了等一个节点让整块画布跟着文档重渲是不划算的。
 */
export function useCreatedNodeReveal(): void {
  React.useEffect(() => {
    const off = onWorkspaceEvent("node.created", (event) => {
      noteCreatedNode(event);
    });
    const unsubscribe = useCanvasStore.subscribe(() => {
      if (pending) applyPendingReveal();
    });
    return () => {
      off();
      unsubscribe();
      pending = null;
    };
  }, []);
}
