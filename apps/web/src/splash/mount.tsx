import { createRoot } from "react-dom/client";
import { usePreferencesStore } from "../app/preferences-store";
import { Splash } from "./Splash";
import { markSplashShown, shouldShowSplash } from "./session";

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
  const dismiss = () => {
    // 卸载自己的 root 必须错开当前这次渲染，否则 React 会警告同步卸载。
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  root.render(<Splash onDismiss={dismiss} />);
}
