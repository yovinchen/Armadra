import { History } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";

import { clearBrowserHistory, useBrowserHistory } from "./history";

/** 下拉里列多少条；存得更多（`HISTORY_LIMIT`），列太长反而找不到。 */
const SHOWN = 15;

/**
 * 地址栏旁的历史下拉：本工作空间的浏览器节点去过的页面（`./history`）。
 * 没有历史时按钮禁用而不是隐藏，地址栏右边不会忽有忽无地跳一格。
 */
export function HistoryMenu({
  workspaceId,
  onOpen,
}: {
  workspaceId: string | undefined;
  onOpen: (url: string) => void;
}) {
  const t = useT();
  const entries = useBrowserHistory(workspaceId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t("browser.history")}
          className="size-5"
          disabled={entries.length === 0}
        >
          <History />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-96">
        {entries.slice(0, SHOWN).map((url) => (
          <DropdownMenuItem key={url} onSelect={() => onOpen(url)}>
            <span className="truncate font-mono text-[12px]">{url}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            if (workspaceId) clearBrowserHistory(workspaceId);
          }}
        >
          {t("browser.history.clear")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
