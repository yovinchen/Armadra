/**
 * 「跳到某个节点」——可能跨看板（§27）。
 *
 * 同一块板上这件事只有一步：选中 + 发居中事件（居中的算术在画布那边，§9.1）。
 * 跨板要多等两拍：先切板，等 `use-board-sync` 把那块板的文档取回来，
 * 再等画布把文档同步成 shape——`centerOnNode` 读的是 shape 的包围盒，
 * shape 还没落地时它什么也不做。
 *
 * 所以这里的做法是：订阅 store 等文档到位，然后按一个很短的时间表重发几次
 * 居中请求。居中是幂等的，多发几次的代价只是多算几次包围盒；反过来，
 * 只发一次的代价是用户点了一行却什么都没发生。
 */
import { requestCenterOnNode } from "../canvas/editor-context";
import { useCanvasStore } from "../store/canvas-store";

/** 文档到位之后重发居中的时间表（毫秒）。 */
export const CENTER_RETRY_DELAYS: readonly number[] = [0, 120, 320, 640];
/** 等文档的上限：超过就放弃订阅，不留着一个永远不触发的监听。 */
export const GOTO_TIMEOUT_MS = 10_000;

function focusNow(nodeId: string): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  for (const delay of CENTER_RETRY_DELAYS) {
    if (delay === 0) requestCenterOnNode(nodeId);
    else setTimeout(() => requestCenterOnNode(nodeId), delay);
  }
}

/** 需要时先切板，然后选中并居中到 `nodeId`。 */
export function gotoNode(boardId: string, nodeId: string): void {
  const state = useCanvasStore.getState();
  if (state.document?.board.id === boardId) {
    focusNow(nodeId);
    return;
  }

  state.selectBoard(boardId);

  let unsubscribe: (() => void) | null = null;
  const timer = setTimeout(() => {
    unsubscribe?.();
    unsubscribe = null;
  }, GOTO_TIMEOUT_MS);

  unsubscribe = useCanvasStore.subscribe((next) => {
    if (next.document?.board.id !== boardId) return;
    if (!next.document.nodes.some((node) => node.id === nodeId)) return;
    clearTimeout(timer);
    unsubscribe?.();
    unsubscribe = null;
    focusNow(nodeId);
  });
}
