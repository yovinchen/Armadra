import { Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWorkspaceEvents } from "../api/events";
import { TldrawWorkspace } from "../canvas/TldrawWorkspace";
// 浮层都在 `./lazy` 里 `React.lazy` 包过，走各自的 chunk（§17 代码分割）。
import {
  AutomationDrawer,
  CommandPalette,
  ControlConfirmDialog,
  ExplorerDrawer,
  GithubDrawer,
  HandoffDialog,
  ResourceDrawer,
  QuickOpen,
  SettingsDialog,
  SourceControlDrawer,
  UsageDashboard,
} from "./lazy";
import { useMinimapPreferences } from "./minimap-preferences";
import { Banners } from "../shell/Banners";
import { ControlsCluster } from "../shell/ControlsCluster";
import { Dock } from "../shell/Dock";
import { LeftSidebar } from "../shell/LeftSidebar";
import { MobileBottomNav } from "../shell/MobileBottomNav";
import { MobileFocusPage } from "../shell/MobileFocusPage";
import { UsageOrb } from "../shell/UsageOrb";
import { WindowDragLayer } from "../shell/WindowDragLayer";
import { useCanvasStore } from "../store/canvas-store";
import { Toaster } from "@/ui/sonner";
import { TooltipProvider } from "@/ui/tooltip";
import { useCommandDispatch } from "./commands";
import { useAgentNotifications } from "./notifications";
import { syncDocumentPreferences } from "./preferences-store";
import { useAppKeybindings } from "./use-app-keybindings";
import { useBoardSync } from "./use-board-sync";
import { useTldrawPreferences } from "./use-tldraw-preferences";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 5_000 },
    },
  });
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={500}>
        <AppShell />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * 壳的渲染顺序（§22 改版后，§27 删掉首页）：侧栏 + 画布占满窗口，
 * 其余全是浮层。
 *
 * 启动就是这一个壳，不再有启动页：还没有工作空间时侧栏照常在（顶行下拉里
 * 打开 / 新建 / 克隆都能用），只是画布那一半空着——画布与它的浮层都要一块
 * 看板才有意义，所以它们跟着工作空间一起出现，空屏上不写任何提示文案（§14）。
 */
function AppShell() {
  const workspace = useCanvasStore((state) => state.workspace);
  const minimapCollapsed = useMinimapPreferences((state) => state.collapsed);

  useEffect(syncDocumentPreferences, []);
  useTldrawPreferences();
  useWorkspaceEvents(workspace?.id ?? null);
  useAgentNotifications();
  useBoardSync();
  const dispatch = useCommandDispatch();
  useAppKeybindings(dispatch);

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <LeftSidebar />
      <div
        className="workspace-surface relative min-w-0 flex-1"
        data-minimap-collapsed={minimapCollapsed}
      >
        <WindowDragLayer />
        {workspace && <TldrawWorkspace />}
        {workspace && (
          <>
            <ControlsCluster />
            <Dock />
            <UsageOrb />
          </>
        )}
      </div>
      {/* 手机布局的两块：底部导航与单节点焦点页。两者都在 <768px 才渲染，
          桌面上是 null，不占位也不订阅任何东西（客户端平台设计）。 */}
      <MobileBottomNav />
      <MobileFocusPage />
      <Banners />
      <Suspense fallback={null}>
        <ExplorerDrawer />
        <SourceControlDrawer />
        <ResourceDrawer />
        <AutomationDrawer />
        <UsageDashboard />
        <GithubDrawer />
        <SettingsDialog />
        <CommandPalette />
        <QuickOpen />
        <ControlConfirmDialog />
        <HandoffDialog />
      </Suspense>
      <Toaster position="bottom-right" />
    </div>
  );
}
