import {
  CalendarClock,
  FolderTree,
  GitBranch,
  Layers,
  Settings,
} from "lucide-react";

import { useT } from "../app/preferences-store";
import { useCompactLayout } from "../platform/layout";
import { useCanvasStore, type PanelState } from "../store/canvas-store";
import { cn } from "@/lib/cn";

/**
 * 手机底部导航（客户端平台设计，移动端能力矩阵）。
 *
 * 手机上没有右上角那条工具簇的位置，也没有悬停提示。五个去处：画布、文件、
 * Git、自动化、设置——每一个都是**同一批**面板，只是入口换成了拇指够得到的
 * 地方，不是另一套简化功能。
 *
 * 「画布」不是一个面板，而是「把所有面板关掉」：手机上一次只看得下一样东西。
 */

type Destination = {
  id: string;
  labelKey: string;
  icon: typeof Layers;
  /** 这个去处对应的面板；`null` 是画布本身。 */
  panel: "explorer" | "scm" | "automation" | "settings" | null;
};

const DESTINATIONS: Destination[] = [
  { id: "canvas", labelKey: "mobile.nav.canvas", icon: Layers, panel: null },
  {
    id: "files",
    labelKey: "mobile.nav.files",
    icon: FolderTree,
    panel: "explorer",
  },
  { id: "git", labelKey: "mobile.nav.git", icon: GitBranch, panel: "scm" },
  {
    id: "automation",
    labelKey: "mobile.nav.automation",
    icon: CalendarClock,
    panel: "automation",
  },
  {
    id: "settings",
    labelKey: "mobile.nav.settings",
    icon: Settings,
    panel: "settings",
  },
];

/** 一次只开一个：切过去之前先把其它几个关掉。 */
function closeOthers(
  panels: PanelState,
  setPanel: ReturnType<typeof useCanvasStore.getState>["setPanel"],
  keep: Destination["panel"],
): void {
  if (keep !== "explorer" && panels.explorer !== "closed")
    setPanel("explorer", "closed");
  if (keep !== "scm" && panels.scm !== "closed") setPanel("scm", "closed");
  if (keep !== "automation" && panels.automation !== "closed")
    setPanel("automation", "closed");
  if (keep !== "settings" && panels.settings) setPanel("settings", false);
  if (panels.resources !== "closed") setPanel("resources", "closed");
  if (panels.usage !== "closed") setPanel("usage", "closed");
}

export function MobileBottomNav() {
  const t = useT();
  const compact = useCompactLayout();
  const workspace = useCanvasStore((state) => state.workspace);
  const panels = useCanvasStore((state) => state.panels);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const focusNodeId = useCanvasStore((state) => state.focusNodeId);
  // 焦点页有自己的返回栏与按键条，底部导航让位给它。
  if (!compact || focusNodeId) return null;
  // 还没打开工作空间时其余四个去处没有对象，但**设置必须够得到**：手机是从
  // 那里配对的，把它藏进侧栏抽屉等于让新设备无从下手。
  const needsWorkspace = !workspace;

  const active = panels.settings
    ? "settings"
    : panels.automation !== "closed"
      ? "automation"
      : panels.scm !== "closed"
        ? "git"
        : panels.explorer !== "closed"
          ? "files"
          : "canvas";

  return (
    <nav
      aria-label={t("mobile.nav.label")}
      data-slot="mobile-bottom-nav"
      className={cn(
        "fixed inset-x-0 bottom-0 z-[var(--z-cluster)] flex items-stretch",
        "border-t border-border bg-[var(--panel)]/95 backdrop-blur-[12px]",
        // 手机的主页横条压在底部，内容再往上抬一层。
        "pb-[env(safe-area-inset-bottom)]",
      )}
    >
      {DESTINATIONS.map((destination) => {
        const Icon = destination.icon;
        const current = active === destination.id;
        return (
          <button
            key={destination.id}
            type="button"
            aria-current={current ? "page" : undefined}
            disabled={needsWorkspace && destination.panel !== "settings"}
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1",
              "text-[11px] leading-4 transition-colors disabled:opacity-40",
              current
                ? "text-[var(--brand)]"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => {
              closeOthers(panels, setPanel, destination.panel);
              if (destination.panel === null) return;
              if (destination.panel === "settings") setPanel("settings", true);
              else setPanel(destination.panel, "drawer");
            }}
          >
            <Icon className="size-5" aria-hidden />
            <span>{t(destination.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
