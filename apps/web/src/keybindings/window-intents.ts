/**
 * 壳推给页面的两条窗口事件，页面这一半。
 *
 * 两条通道以前都是单向接通的：主进程发，没有任何人订阅。于是
 *
 *   * `window:key-intent`（⌘W）——壳发完意图**同一拍**就把窗口关了，页面
 *     哪怕订阅了也来不及先关节点；
 *   * `window:notification-click`——主进程发的通知点开之后，`nodeId` 到了
 *     页面就丢了，节点不会被选中。
 *
 * 现在 ⌘W 是一问一答（`apps/desktop/src/shell-core/key-intent.ts`）：壳把
 * 意图和一个 token 交过来，页面答「我接了」或「没得接」，壳只在页面没接时
 * 才做自己那一半。页面不答，壳等一小会儿照样关窗——**⌘W 绝不允许变成一个
 * 按了没反应的键**。
 *
 * 「关节点」走的是画布已有的 `canvas.closeNode` 命令，不是这里再写一份删除：
 * 那条命令上挂着「结束会话并删除？」确认框，绕过去会把带 PTY 的终端节点
 * 静默删掉。
 */
import * as React from "react";

import { runCanvasCommand } from "../canvas/commands";
import { requestCenterOnNode } from "../canvas/flow/flow-context";
import { useCanvasStore } from "../store/canvas-store";

/** 壳的桥，不在桌面壳里时是 `undefined`。 */
function bridge(): Window["armadra"] {
  return typeof window === "undefined" ? undefined : window.armadra;
}

/**
 * 当前该关掉的那个节点：先看选中，再看专注模式。返回是否真的关了。
 *
 * 专注模式下那个节点不一定在 `selectedNodeIds` 里，所以先把它选上——
 * `canvas.closeNode` 读的是画布自己的选中项。
 */
export function closeFocusedNode(): boolean {
  const state = useCanvasStore.getState();
  const id = state.selectedNodeIds[0] ?? state.focusNodeId ?? null;
  if (!id) return false;
  // 画布没挂载时命令表是空的（单测、启动瞬间），这时候没人接得住，
  // 应当让壳去关窗而不是假装关了个节点。
  if (state.selectedNodeIds[0] !== id) state.selectNodes([id]);
  return runCanvasCommand("canvas.closeNode");
}

/** 点通知：选中并居中那个节点，顺便把窗口拉到前面。 */
export function focusNodeFromNotification(nodeId: string): void {
  if (typeof window !== "undefined") window.focus();
  useCanvasStore.getState().selectNodes([nodeId]);
  requestCenterOnNode(nodeId);
}

/**
 * 订阅两条通道，返回退订函数。不在桌面壳里时什么也不做。
 *
 * 每个 intent 都**必须**回一次 `resolveKeyIntent`：没接住也要说没接住，
 * 那正是壳去关窗的信号。
 */
export function subscribeWindowIntents(): () => void {
  const shell = bridge();
  // 连 `window` 这一域都没有的桥不是这一版 preload 装的（旧壳、测试替身）。
  // 订阅不上就不订阅，绝不能因为它让整个应用外壳渲染不出来。
  if (!shell || typeof shell.window?.onKeyIntent !== "function")
    return () => undefined;

  const offIntent = shell.window.onKeyIntent((intent, token) => {
    const handled = intent === "close-window" ? closeFocusedNode() : false;
    void shell.window.resolveKeyIntent(token, handled).catch(() => {
      // 答复送不到就让壳的超时去收尾，它本来就是为这种情况留的。
    });
  });

  const offClick = shell.window.onNotificationClick(({ nodeId }) => {
    if (nodeId) focusNodeFromNotification(nodeId);
  });

  return () => {
    offIntent();
    offClick();
  };
}

/**
 * 订阅一次，挂在窗口层。
 *
 * 装在 `shell/WindowDragLayer` 上：那是页面里唯一一块「只因为有个原生窗口
 * 才存在」的东西，和这两条事件同一个由来，而且它在 App 里无条件渲染，
 * 所以订阅跟着窗口活，一次，不会因为哪个面板开合而丢。
 */
export function useWindowIntents(): void {
  React.useEffect(() => subscribeWindowIntents(), []);
}
