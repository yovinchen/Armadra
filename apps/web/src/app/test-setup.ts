/**
 * vitest 的全局前置（`vitest.config.ts` 的 `setupFiles`）。
 *
 * 只放那些**必须在模块求值之前**就位的补丁：ES import 会被提升，写在测试
 * 文件里的 `installDomPolyfills()` 已经来不及了。运行时才用到的补丁仍然
 * 留在 `app/test-harness.tsx`。
 */

/**
 * React Flow 的容器用 `ResizeObserver` 量自己的尺寸（`useResizeHandler`），
 * jsdom 没有这个类。桩只需要存在并且能被 new / observe / disconnect —— 尺寸
 * 恒为 0，测试里断言的是节点与回调，不是像素。
 */
if (typeof globalThis.ResizeObserver !== "function") {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

/**
 * `matchMedia`：`platform/layout.ts` 的 `isCompactLayout()` 在模块顶层就读它，
 * 而 jsdom 没有。默认全部不匹配 = 桌面布局。
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
