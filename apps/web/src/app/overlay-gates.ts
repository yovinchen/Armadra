import { useEffect, useState } from "react";
import { create } from "zustand";

/**
 * 浮层的挂载闸门（§17「代码分割」的第二半）。
 *
 * `React.lazy` 只在组件**被渲染**的那一刻才发起 `import()`。`App.tsx` 以前把
 * 十几个 `lazy()` 浮层全部无条件挂进 `<Suspense>`，于是启动那一刻十几个
 * chunk 一起被取、被编译、常驻在 V8 里——实测空画布空闲时页面已经加载了
 * 34 个 JS chunk、6.17 MB，其中 codemirror（862 kB）、conflict（834 kB）、
 * markdown（544 kB）、language（153 kB）全部来自没人打开过的面板。分包分了，
 * 但没省下任何东西。
 *
 * 闸门做的就是把「渲染」推迟到「这个浮层第一次要出现」：
 *
 *  - 面板类浮层的开合状态本来就在 `canvas-store.panels` 里，闸门直接读它；
 *  - 编辑器那三个浮层（代码操作、编辑预览、三方合并）的状态在自己的 store
 *    里，而那些 store 顶上就 import 了 CodeMirror——读它等于又把 chunk 拉回
 *    启动路径。所以改成它们**反过来**报一声：store 打开时调 `requestOverlay`，
 *    闸门只依赖这个没有任何重依赖的模块。
 *
 * 开过一次就一直挂着（`useMountedOnce`）：关闭动画、面板里的滚动位置和未提交
 * 的输入都还在原处，行为与以前逐字一致，省下的只是「从没打开过」的那一份。
 */

/** 自带 store 的浮层，只有编辑器那三个。 */
export type OverlayKey = "codeAction" | "editPreview" | "merge";

interface OverlayGateState {
  readonly requested: ReadonlySet<OverlayKey>;
  readonly request: (key: OverlayKey) => void;
}

export const useOverlayGates = create<OverlayGateState>()((set) => ({
  requested: new Set<OverlayKey>(),
  request: (key) =>
    set((state) =>
      state.requested.has(key)
        ? state
        : { requested: new Set(state.requested).add(key) },
    ),
}));

/**
 * 「这个浮层现在要出现了」。由拥有状态的那个 store 在打开时调用。
 *
 * 幂等：第二次及以后不产生新状态，订阅者也就不会重渲染。
 */
export function requestOverlay(key: OverlayKey): void {
  useOverlayGates.getState().request(key);
}

/** 这个浮层是否已经被请求过。 */
export function useOverlayRequested(key: OverlayKey): boolean {
  return useOverlayGates((state) => state.requested.has(key));
}

/**
 * `open` 为真过一次就一直为真。
 *
 * `open || mounted` 让这一帧就返回 `true`——闸门不能比浮层自己晚一帧打开，
 * 否则按下 ⌘K 到命令面板出现之间会多一次空帧。
 */
export function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return open || mounted;
}
