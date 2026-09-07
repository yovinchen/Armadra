import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, RotateCw, X } from "lucide-react";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { IconButton } from "../../../ui/icon-button";
import { Tabs, TabsList, TabsTrigger } from "../../../ui/tabs";
import { WorkPanelSheet } from "../../WorkPanelSheet";
import { ExecutionHostBadge } from "../../ExecutionHostBadge";
import { invalidateGitQueries } from "../queries";
import { LogPage } from "../log/LogPage";
import { CommitPagePlaceholder } from "./pages";

/**
 * Git 工具窗口（Git 工具窗口设计 §2.1）。
 *
 * **底部**停靠，不是右侧抽屉：日志页是三栏，要的是宽度。它仍然是
 * `WorkPanelSheet` 的一块工作面板，所以「一次只开一个」照旧——`setPanel` 里
 * `bottom` / `maximized` 与 `drawer` 同样算「占着那块地方」。
 *
 * 高度与最大化记进偏好（`preferences-store` 的 `git` 段）：拖过一次之后每次
 * 打开都是那个高度，而不是每次都回到 40vh。
 */
export function GitToolWindow() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.scm);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const git = usePreferencesStore((state) => state.git);
  const set = usePreferencesStore((state) => state.setGitPreference);
  const client = useQueryClient();
  const [tab, setTab] = useState<"log" | "commit">("log");

  const open = mode === "bottom" || mode === "maximized";
  const maximized = mode === "maximized";
  const close = () => setPanel("scm", "closed");

  return (
    <WorkPanelSheet
      panel="scm"
      open={open}
      onClose={close}
      side="bottom"
      label={t("gitLog.title")}
      resizeLabel={t("gitLog.resize")}
      height={git.windowHeight > 0 ? git.windowHeight : null}
      onHeightChange={(height) => set("windowHeight", height)}
      maximized={maximized}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "log" | "commit")}
          className="min-w-0 gap-0"
        >
          <TabsList variant="line" className="h-9">
            <TabsTrigger value="log" className="text-xs">
              {t("gitLog.tab.log")}
            </TabsTrigger>
            <TabsTrigger value="commit" className="text-xs">
              {t("gitLog.tab.commit")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        <ExecutionHostBadge />
        <IconButton
          label={t("gitLog.refresh")}
          onClick={() => {
            invalidateGitQueries(client, workspaceId);
            void client.invalidateQueries({ queryKey: ["git-log"] });
            void client.invalidateQueries({ queryKey: ["git-refs"] });
          }}
        >
          <RotateCw />
        </IconButton>
        <IconButton
          label={t(maximized ? "gitLog.restore" : "gitLog.maximize")}
          onClick={() => {
            set("maximized", !maximized);
            setPanel("scm", maximized ? "bottom" : "maximized");
          }}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton label={t("gitLog.close")} onClick={close}>
          <X />
        </IconButton>
      </div>
      {workspaceId && tab === "log" && <LogPage workspaceId={workspaceId} />}
      {workspaceId && tab === "commit" && (
        <CommitPagePlaceholder workspaceId={workspaceId} />
      )}
    </WorkPanelSheet>
  );
}
