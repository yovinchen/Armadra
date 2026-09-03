/**
 * 资源管理器抽屉（§3.6，⌘⇧E）。
 *
 * 两种形态共用同一份头部与同一棵树：右侧 360px 抽屉（带 scrim），
 * 或 pin 成右侧 320px 浮卡（不挡画布、无 scrim）。
 */
import { Pin, PinOff, X } from "lucide-react";

import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { IconButton } from "../ui/icon-button";
import { FileTree } from "./FileTree";

export function ExplorerDrawer() {
  const mode = useCanvasStore((state) => state.panels.explorer);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const t = useT();

  if (mode === "closed") return null;

  // `SheetTitle` 是 Radix Dialog.Title，只能长在 Sheet 里；
  // pin 成浮卡时不再有 Dialog 上下文，标题退回普通标题元素。
  const renderHeader = (Title: typeof SheetTitle | "h2") => (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
      <Title className="flex-1 truncate text-[13px] font-semibold">
        {t("explorer.title")}
      </Title>
      <IconButton
        label={mode === "pinned" ? t("explorer.unpin") : t("explorer.pin")}
        active={mode === "pinned"}
        onClick={() =>
          setPanel("explorer", mode === "pinned" ? "drawer" : "pinned")
        }
      >
        {mode === "pinned" ? <PinOff /> : <Pin />}
      </IconButton>
      <IconButton
        label={t("explorer.close")}
        onClick={() => setPanel("explorer", "closed")}
      >
        <X />
      </IconButton>
    </div>
  );

  const body = (
    <ScrollArea className="min-h-0 flex-1">
      <FileTree />
    </ScrollArea>
  );

  if (mode === "pinned") {
    return (
      <aside
        aria-label={t("explorer.title")}
        className="fixed top-[96px] right-[14px] bottom-[14px] z-[var(--z-cluster)] flex w-[320px] flex-col overflow-hidden rounded-xl border border-border bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[var(--shadow-overlay)] backdrop-blur-md"
      >
        {renderHeader("h2")}
        {body}
      </aside>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) setPanel("explorer", "closed");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-[var(--drawer-w)] gap-0 p-0 sm:max-w-none"
      >
        {renderHeader(SheetTitle)}
        {body}
      </SheetContent>
    </Sheet>
  );
}
