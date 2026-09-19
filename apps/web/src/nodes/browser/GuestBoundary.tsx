import * as React from "react";

/**
 * 一个 guest 出错只能拖垮它自己的节点。
 *
 * `<webview>` 的方法在元素未附着、`dom-ready` 之前、guest 实例已销毁时都会
 * **抛错**；实测一次这样的抛错在没有边界的树里直接把 `#root` 清空、连错误
 * 覆盖层都没有。这是整个 apps/web 里第一个错误边界，只包 guest，不包节点外壳。
 */
interface GuestBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface GuestBoundaryState {
  failed: boolean;
}

export class GuestBoundary extends React.Component<
  GuestBoundaryProps,
  GuestBoundaryState
> {
  state: GuestBoundaryState = { failed: false };

  static getDerivedStateFromError(): GuestBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("browser guest failed", error);
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
