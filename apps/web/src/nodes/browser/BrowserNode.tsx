import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";

import { NodeShell } from "../NodeShell";
import type { NodeBodyProps } from "../registry";
import { isDesktop } from "@/platform";
import { WebviewSurface } from "./WebviewSurface";

/**
 * 浏览器节点（§3.4 / B01）。
 *
 * 页面住在本窗口的一个 `<webview>` guest 里（electron-migration.md §4）。旧
 * 的那条路——Runtime 托管的 Chromium、画面帧流、兼容模式 iframe——在 W3.5 一
 * 起删掉了，所以这里只剩一个判定：宿主有没有 `<webview>`。
 *
 * 判定在渲染期间做一次就够：一个页面不会在运行中从 Electron 变成浏览器。
 */
export function BrowserNode(props: NodeBodyProps) {
  if (isDesktop()) return <WebviewSurface {...props} />;
  return <UnavailableNode {...props} />;
}

/**
 * 纯浏览器 / Host 托管模式下的浏览器节点（调研 D5 的明确结果）。
 *
 * 不给一个按不动的工具栏，也不退回沙箱 iframe：能显示一个页面和能被 Agent
 * 驱动是两件事，一个看得见却谁都操作不了的画面只会让人反复去点。说清楚它
 * 要什么，比给一个半成品强。
 */
function UnavailableNode({ node, selected }: NodeBodyProps) {
  const t = useT();
  return (
    <NodeShell
      node={node}
      selected={selected}
      status={{ tone: "failed", label: t("browser.state.unsupported") }}
      headerChips={<Badge variant="outline">{t("browser.preview")}</Badge>}
    >
      <div className="flex h-full w-full items-center justify-center p-4">
        <p className="max-w-[36ch] text-center text-[12px] text-muted-foreground">
          {t("browser.unavailable.desktopOnly")}
        </p>
      </div>
    </NodeShell>
  );
}
