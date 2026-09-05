/**
 * 资源管理器抽屉（§3.6，⌘⇧E）。
 *
 * 两种形态共用同一份头部与同一棵树：非模态右侧 360px 抽屉，
 * 或 pin 成右侧 320px 浮卡。两者都允许文件拖向画布和终端。
 *
 * 两个页签（E01/M4）：「文件」是那棵树，「搜索」是项目内容搜索。⌘⇧H 走
 * `PROJECT_SEARCH_EVENT` 直接切到第二页并把焦点放进输入框。
 */
import { useEffect, useState } from "react";
import { Pin, PinOff, X } from "lucide-react";

import { PROJECT_SEARCH_EVENT } from "../app/commands";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { IconButton } from "../ui/icon-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ExecutionHostBadge } from "./ExecutionHostBadge";
import { FileTree } from "./FileTree";
import { ProjectSearchPanel } from "./ProjectSearchPanel";

export function ExplorerDrawer() {
  const mode = useCanvasStore((state) => state.panels.explorer);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const t = useT();
  const [tab, setTab] = useState<"files" | "search">("files");
  /** 每次经命令进入搜索页都换一个值，让面板把焦点放回输入框。 */
  const [focusToken, setFocusToken] = useState<number | undefined>(undefined);

  useEffect(() => {
    const open = () => {
      setTab("search");
      setFocusToken(Date.now());
    };
    window.addEventListener(PROJECT_SEARCH_EVENT, open);
    return () => window.removeEventListener(PROJECT_SEARCH_EVENT, open);
  }, []);

  if (mode === "closed") return null;

  // `SheetTitle` 是 Radix Dialog.Title，只能长在 Sheet 里；
  // pin 成浮卡时不再有 Dialog 上下文，标题退回普通标题元素。
  const renderHeader = (Title: typeof SheetTitle | "h2") => (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
      <Title className="flex-1 truncate text-[13px] font-semibold">
        {t("explorer.title")}
      </Title>
      <ExecutionHostBadge />
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
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as "files" | "search")}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList variant="line" className="mx-2 mt-1 shrink-0">
        <TabsTrigger value="files">{t("projectSearch.tab.files")}</TabsTrigger>
        <TabsTrigger value="search">
          {t("projectSearch.tab.search")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="files" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <FileTree />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="search" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <ProjectSearchPanel autoFocusToken={focusToken} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );

  if (mode === "pinned") {
    return (
      <aside
        aria-label={t("explorer.title")}
        className="fixed top-[96px] right-[14px] bottom-[14px] z-[var(--z-cluster)] flex w-[320px] max-w-[calc(100vw-28px)] flex-col overflow-hidden rounded-xl border border-border bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[var(--shadow-overlay)] backdrop-blur-md"
      >
        {renderHeader("h2")}
        {body}
      </aside>
    );
  }

  return (
    <Sheet
      open
      modal={false}
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
