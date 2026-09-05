/**
 * 资源抽屉（T02，平台总纲 §4「右侧资源 / ResourcePanel」）。
 *
 * 右侧工作面板的一个页签形态：主机总览、会话表、孤立会话、防休眠租约。
 * 与文件、Git 抽屉同一套壳（`Sheet` + 40px 头部），宽度用同一个
 * `--drawer-w`，窄屏自动铺满。
 *
 * 采样只在这个抽屉开着的时候进行——`useResources` 拿订阅，关掉就退订
 * （设计 §8「面板打开时每 2 秒，关闭时…」）。
 */
import { useState } from "react";
import { RotateCw, X } from "lucide-react";

import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { IconButton } from "../ui/icon-button";
import { ComponentList } from "./resources/ComponentList";
import { HostCard } from "./resources/HostCard";
import { OrphanList } from "./resources/OrphanList";
import { PowerSection } from "./resources/PowerSection";
import { SessionTable } from "./resources/SessionTable";
import type { SessionSort } from "./resources/metrics";
import { useResources } from "./resources/use-resources";

export function ResourceDrawer() {
  const mode = useCanvasStore((state) => state.panels.resources);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const t = useT();
  const [sort, setSort] = useState<SessionSort>("cpu");

  const open = mode === "drawer";
  const { snapshot, error, loading, refresh } = useResources(workspaceId, open);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setPanel("resources", "closed");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-w-full gap-0 p-0 data-[side=right]:w-[min(100vw,var(--drawer-w))] data-[side=right]:sm:max-w-none"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="flex-1 truncate text-[13px] font-semibold">
            {t("resources.title")}
          </SheetTitle>
          <IconButton label={t("resources.refresh")} onClick={refresh}>
            <RotateCw />
          </IconButton>
          <IconButton
            label={t("resources.close")}
            onClick={() => setPanel("resources", "closed")}
          >
            <X />
          </IconButton>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            {error && !snapshot && (
              <p className="text-[12px] text-[var(--danger)]">{error}</p>
            )}
            {/* 还没有过样本时不画表格骨架：等第一份真实数字，别先显示一屏 0。 */}
            {loading && !snapshot && (
              <p className="text-[12px] text-muted-foreground">
                {t("resources.loading")}
              </p>
            )}

            {snapshot && (
              <>
                <HostCard host={snapshot.host} />

                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">
                    {t("resources.sessions")}
                  </h3>
                  <SessionTable
                    sessions={snapshot.sessions}
                    sort={sort}
                    onSorted={setSort}
                  />
                </section>

                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">
                    {t("resources.components")}
                  </h3>
                  <ComponentList components={snapshot.components} />
                </section>

                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">
                    {t("resources.orphans")}
                  </h3>
                  {workspaceId && (
                    <OrphanList
                      workspaceId={workspaceId}
                      orphans={snapshot.orphans}
                      onChanged={refresh}
                    />
                  )}
                </section>

                <PowerSection power={snapshot.power} onChanged={refresh} />
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
