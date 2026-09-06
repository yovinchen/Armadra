import { createRoot } from "react-dom/client";
import { usePreferencesStore } from "../app/preferences-store";
import { Splash } from "./Splash";
import { markSplashShown, shouldShowSplash } from "./session";
import { SPLASH_DURATION_MS } from "./timeline";

/** 覆盖层无论如何都会在这个时刻之前消失：动画全长加淡出，再留两秒余量。 */
export const SPLASH_HARD_LIMIT_MS = SPLASH_DURATION_MS + 2260;

/**
 * 把开屏动画挂到自己的 React root 上。
 *
 * 为什么不是 index.html 里的一段无依赖脚本：桌面壳的 CSP 是
 * `default-src 'self'`，内联脚本会被挡掉（见 index.html 的注释），单独再拆一个
 * 入口脚本又要多一次请求。所以做成组件，但**不等 `initRuntimeSockets()`**——
 * `main.tsx` 一执行就调这里，覆盖层和 App 的挂载是并行的，Runtime 该连连、
 * 该拉数据拉数据，动画只是浮在上面。
 *
 * 不走 `<StrictMode>`：开发下的 effect 双跑会让动画从头再来一遍。
 */
export function mountSplash(): void {
  if (typeof document === "undefined") return;
  const { splashAnimation } = usePreferencesStore.getState();
  if (!shouldShowSplash(splashAnimation)) return;
  markSplashShown();

  const host = document.createElement("div");
  host.id = "splash-root";
  document.body.append(host);
  const root = createRoot(host);
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    // 卸载自己的 root 必须错开当前这次渲染，否则 React 会警告同步卸载。
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  root.render(<Splash onDismiss={dismiss} />);
  // 最后一道保险：组件自己的定时器也没能收场（React 没有再渲染、rAF 与
  // 定时器都没推进）时，直接把覆盖层摘掉，底下的 App 露出来。
  setTimeout(dismiss, SPLASH_HARD_LIMIT_MS);
}
