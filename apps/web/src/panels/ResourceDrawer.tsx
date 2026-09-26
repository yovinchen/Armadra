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
import { SheetTitle } from "../ui/sheet";
import { WorkPanelSheet } from "./WorkPanelSheet";
import { IconButton } from "../ui/icon-button";
import { ComponentList } from "./resources/ComponentList";
import { HostCard } from "./resources/HostCard";
import { OrphanList } from "./resources/OrphanList";
import { PowerSection } from "./resources/PowerSection";
import { SessionTable } from "./resources/SessionTable";
import {
  LOCAL_HOST,
  componentsOnHost,
  hostOverviews,
  type SessionSort,
} from "./resources/metrics";
import { useResources } from "./resources/use-resources";
import { useSshHosts } from "./settings/ssh-hosts";

export function ResourceDrawer() {
  const mode = useCanvasStore((state) => state.panels.resources);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const t = useT();
  const [sort, setSort] = useState<SessionSort>("cpu");
  // 主机筛选由抽屉持有：主机总览与会话表看的是同一台机器。
  const [host, setHost] = useState<string | null | "all">("all");
  const sshHosts = useSshHosts();
  const hostName = (id: string) =>
    sshHosts.find((entry) => entry.id === id)?.name ?? id;

  const open = mode === "drawer";
  const { snapshot, error, loading, refresh } = useResources(workspaceId, open);

  return (
    <WorkPanelSheet
      panel="resources"
      open={open}
      onClose={() => setPanel("resources", "closed")}
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
              {hostOverviews(snapshot.host, snapshot.executionHosts, host).map(
                (overview) => (
                  <HostCard
                    key={overview.hostId}
                    host={overview}
                    name={
                      overview.location === "remote"
                        ? hostName(overview.hostId)
                        : undefined
                    }
                  />
                ),
              )}

              <section>
                <h3 className="mb-1 text-[13px] font-semibold">
                  {t("resources.sessions")}
                </h3>
                <SessionTable
                  sessions={snapshot.sessions}
                  sort={sort}
                  onSorted={setSort}
                  host={host}
                  onHost={setHost}
                  extraHosts={[
                    ...(snapshot.executionHosts.length > 0 ? [LOCAL_HOST] : []),
                    ...snapshot.executionHosts.map((entry) => entry.hostId),
                  ]}
                  hostName={hostName}
                />
              </section>

              <section>
                <h3 className="mb-1 text-[13px] font-semibold">
                  {t("resources.components")}
                </h3>
                <ComponentList
                  components={componentsOnHost(snapshot.components, host)}
                />
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
    </WorkPanelSheet>
  );
}
