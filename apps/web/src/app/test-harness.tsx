import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { TooltipProvider } from "@/ui/tooltip";

/**
 * 壳的测试外壳。Radix 的 Popper/ScrollArea 依赖 `ResizeObserver`，
 * jsdom 没有；`scrollIntoView` 同理。这里一次补齐，测试文件不再各自打补丁。
 */
export function installDomPolyfills() {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: ResizeObserverStub,
      writable: true,
    });
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  }
}

/**
 * 与 `app/App.tsx` 同一组 provider。`<ReactFlowProvider>` 也在里面：
 * Dock 的缩放档位用 `useViewport()`，那个 hook 在 provider 之外会抛。
 */
export function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
      </ReactFlowProvider>
    </QueryClientProvider>
  );
}
