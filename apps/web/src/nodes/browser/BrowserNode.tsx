import type { NodeBodyProps } from "../registry";
import { isDesktop } from "@/platform";
import { StreamSurface } from "./StreamSurface";
import { WebviewSurface } from "./WebviewSurface";

/**
 * 浏览器节点（§3.4 / B01）。
 *
 * 两套后端，按宿主分（typescript-core.md R6）：桌面壳里页面是本窗口的一个
 * `<webview>` guest；服务器壳里没有窗口，页面在 core 起的 headless Chromium
 * 里，这边画它的画面流。授权、租约与 17 个动词两边是同一份，不同的只是页面
 * 在哪。
 *
 * 判定在渲染期间做一次就够：一个页面不会在运行中从 Electron 变成浏览器。
 */
export function BrowserNode(props: NodeBodyProps) {
  if (isDesktop()) return <WebviewSurface {...props} />;
  return <StreamSurface {...props} />;
}
