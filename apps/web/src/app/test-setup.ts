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
 * `localStorage`：Node 25 起全局自带一个 Web Storage 的 getter，没给
 * `--localstorage-file` 时它答 `undefined`，而且盖住了 jsdom 的那一个。于是
 * 同一份用例在新 Node 上所有本机存储读写都静默失败、在 CI 的 Node 22 上是真
 * 存储——编辑器草稿在用例之间串了数据，本机却复现不出来。这里一律换回 jsdom
 * 自己的，让两边跑的是同一件事。
 */
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
let storageUsable = false;
try {
  storageUsable = typeof globalThis.localStorage?.getItem === "function";
} catch {
  storageUsable = false;
}
if (dom !== undefined && !storageUsable) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: dom.window.localStorage,
  });
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

/**
 * `DOMMatrixReadOnly`：React Flow 的 `updateNodeInternals` 用它解析节点的
 * `transform` 取缩放（`getDimensions` → `.m22`）；把手挂上时会补量一次
 * （`ConnectionHandles`），于是任何在真 React Flow 里挂过节点的测试都会走到
 * 这里。jsdom 没有这个类。恒等矩阵：测试里从不断言像素。
 */
if (
  typeof window !== "undefined" &&
  typeof window.DOMMatrixReadOnly !== "function"
) {
  class DOMMatrixReadOnlyStub {
    readonly a = 1;
    readonly b = 0;
    readonly c = 0;
    readonly d = 1;
    readonly e = 0;
    readonly f = 0;
    readonly m11 = 1;
    readonly m22 = 1;
    readonly is2D = true;
    readonly isIdentity = true;
  }
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    writable: true,
    configurable: true,
    value: DOMMatrixReadOnlyStub,
  });
}
