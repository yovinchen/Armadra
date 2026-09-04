import * as React from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { useResolvedTheme, useT } from "@/app/preferences-store";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/** 沿用 v2 的沙箱位；预览节点不允许顶层导航，也不给下载权限。 */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/** 只有历史是本地状态：v3 的 browser 数据只存当前 URL。 */
const MAX_HISTORY = 50;

export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `https://${value}`;
}

/** 浏览器节点（§3.4）：地址栏 + 四个图标钮 + 沙箱 iframe。 */
export function BrowserNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  /**
   * 跨域 iframe 的 `prefers-color-scheme` 取自 iframe 元素自己的 `color-scheme`
   * （HTML 规范，Chrome 98+ / WebKit 均已实现），所以把应用主题写上去，
   * Google 这类跟随系统深浅色的页面就会和画布一个色（2026-09-04 用户要求
   * 浏览器默认黑色）。页面自己固定亮色的没法管。
   */
  const theme = useResolvedTheme();
  const url = node.data.kind === "browser" ? node.data.url : "";
  const [address, setAddress] = React.useState(url);
  const [history, setHistory] = React.useState<string[]>(url ? [url] : []);
  const [index, setIndex] = React.useState(url ? 0 : -1);
  const [reloads, setReloads] = React.useState(0);

  React.useEffect(() => setAddress(url), [url]);

  function commit(next: string) {
    const target = normalizeUrl(next);
    if (!target) return;
    setHistory((current) => {
      const kept = current.slice(0, index + 1);
      const merged = [...kept, target].slice(-MAX_HISTORY);
      setIndex(merged.length - 1);
      return merged;
    });
    useCanvasStore.getState().updateNodeData(id, { url: target });
  }

  function step(delta: number) {
    const next = index + delta;
    const target = history[next];
    if (!target) return;
    setIndex(next);
    useCanvasStore.getState().updateNodeData(id, { url: target });
  }

  const headerActions = (
    <>
      <IconButton
        label={t("browser.back")}
        disabled={index <= 0}
        onClick={() => step(-1)}
      >
        <ArrowLeft />
      </IconButton>
      <IconButton
        label={t("browser.forward")}
        disabled={index < 0 || index >= history.length - 1}
        onClick={() => step(1)}
      >
        <ArrowRight />
      </IconButton>
      <IconButton
        label={t("browser.reload")}
        onClick={() => setReloads((value) => value + 1)}
      >
        <RotateCw />
      </IconButton>
      <IconButton
        label={t("browser.openExternal")}
        disabled={!url}
        onClick={() => void openExternal(url)}
      >
        <ExternalLink />
      </IconButton>
    </>
  );

  return (
    <NodeShell
      node={node}
      selected={selected}
      headerChips={<Badge variant="outline">{t("browser.preview")}</Badge>}
      headerActions={headerActions}
    >
      <div className="flex h-full w-full flex-col">
        <div className="shrink-0 p-1.5">
          <Input
            aria-label={t("browser.address")}
            className="h-6 font-mono text-[11px]"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(address);
            }}
          />
        </div>
        <div className="min-h-0 flex-1 bg-[var(--browser-bg)]">
          {url && (
            <iframe
              key={`${url}#${reloads}`}
              src={url}
              title={node.title}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              className="h-full w-full border-0"
              style={{ colorScheme: theme }}
            />
          )}
        </div>
      </div>
    </NodeShell>
  );
}
