/**
 * vitest 的全局前置（`vitest.config.ts` 的 `setupFiles`）。
 *
 * 只放那些**必须在模块求值之前**就位的补丁：ES import 会被提升，所以像
 * `matchMedia` 这种在 `import "tldraw"` 时就被读的东西，写在测试文件里的
 * `installDomPolyfills()` 已经来不及了。运行时才用到的补丁仍然留在
 * `app/test-harness.tsx`。
 */

// tldraw 的 `globals/environment.ts` 在模块顶层读 `(color-gamut: p3)` 与
// `(any-pointer: coarse)`，jsdom 没有 matchMedia。
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
