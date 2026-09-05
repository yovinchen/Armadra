/**
 * 「这一次打开该不该放开屏动画」。
 *
 * 判据只有页面会话，不需要桌面壳配合：⌘W / 托盘只是把窗口藏起来，WebView
 * 还活着，`sessionStorage` 里的标记也还在，恢复窗口不会重播；⌘Q 之后重新打开
 * 是新进程新 WebView，标记随之消失，动画照放。开发热重载与浏览器刷新同样落在
 * 「同一个页面会话」里，所以不会反复播。
 */

const SHOWN_KEY = "armadra.splash.shown";

/** 隐私模式 / 沙箱里 `sessionStorage` 可能直接抛异常。 */
function readShown(): boolean {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 标记这一页面会话已经放过了。 */
export function markSplashShown(): void {
  try {
    sessionStorage.setItem(SHOWN_KEY, "1");
  } catch {
    // 存不进去就退化成「每次加载都放」，不影响功能
  }
}

/** 只给测试用：把标记清掉。 */
export function clearSplashShown(): void {
  try {
    sessionStorage.removeItem(SHOWN_KEY);
  } catch {
    // 同上
  }
}

/**
 * `enabled` 是设置里的「启动动画」开关；关掉就永远不放。
 */
export function shouldShowSplash(enabled: boolean): boolean {
  if (!enabled) return false;
  return !readShown();
}
