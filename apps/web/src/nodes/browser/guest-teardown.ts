/**
 * 卸载 `<webview>` 时 Electron 自己抛的那一条 `Invalid guestInstanceId`（§58）。
 *
 * 不是这边的卸载顺序错了，是 Electron 42 的元素实现本身：`<webview>` 一离开
 * 文档，影子根里那个 iframe 跟着分离，主进程随之销毁 guest，并在 guest 的
 * `destroyed` 里把登记删掉；紧接着元素的 `disconnectedCallback` 又同步发一次
 * `GUEST_VIEW_MANAGER_DETACH_GUEST`，主进程按 id 找不到登记，抛回这句话。
 * 一个只有「建 `<webview>`、等 `dom-ready`、移除」三步的最小 Electron 页面每次
 * 都复现，先 `display:none` 再删也一样——guest 早一步没了，而那个 id 存在
 * 元素的私有状态里，页面够不着。
 *
 * 所以能做的是把它认出来并且只认它：React 摘下 `<webview>` 的 ref 发生在把
 * 元素移出文档之前（同一次提交的变更阶段），这时打开一个到下一个微任务为止
 * 的窗口；`disconnectedCallback` 是移除时同步跑的自定义元素回调，它抛的错同步
 * 派发成 `window` 的 `error` 事件，正好落在窗口里。窗口里、消息逐字是这一句
 * 的，`preventDefault()`——浏览器不再把它报成未捕获的错误，控制台与 CDP 的
 * `Runtime.exceptionThrown` 都不会看到。窗口外的同一句话、窗口里的别的错误
 * 一律照常报。
 */

const TEARDOWN_ERROR =
  /^(?:Uncaught )?(?:Error: )?Invalid guestInstanceId: \d+$/;

let open = 0;
let installed = false;

function messageOf(event: ErrorEvent): string {
  return event.error instanceof Error ? event.error.message : event.message;
}

function onError(event: ErrorEvent): void {
  if (open === 0) return;
  if (!TEARDOWN_ERROR.test(messageOf(event))) return;
  event.preventDefault();
}

/**
 * 一个 `<webview>` 马上要被移出文档。由它的 ref 在摘下时调用。
 */
export function expectGuestTeardown(): void {
  if (typeof window === "undefined") return;
  if (!installed) {
    window.addEventListener("error", onError);
    installed = true;
  }
  open += 1;
  queueMicrotask(() => {
    open -= 1;
  });
}
