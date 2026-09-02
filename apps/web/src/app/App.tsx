import { Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useWorkspaceEvents } from "../api/events";
import { TldrawWorkspace } from "../canvas/TldrawWorkspace";
// 六个浮层都在 `./lazy` 里 `React.lazy` 包过，走各自的 chunk（§17 代码分割）。
import {
  CommandPalette,
  ControlConfirmDialog,
  DeliveryLog,
  ExplorerDrawer,
  SettingsDialog,
  SourceControlDrawer,
} from "./lazy";
import { Banners } from "../shell/Banners";
import { ControlsCluster } from "../shell/ControlsCluster";
import { Dock } from "../shell/Dock";
import { LeftSidebar } from "../shell/LeftSidebar";
import { UsageOrb } from "../shell/UsageOrb";
import { useCanvasStore } from "../store/canvas-store";
import { Toaster } from "@/ui/sonner";
import { TooltipProvider } from "@/ui/tooltip";
import { Launcher } from "./Launcher";
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
 * 壳的渲染顺序（§22 改版后）：侧栏 + 画布占满窗口，其余全是浮层。
 * 没有工作空间时只有启动页（设置与 Toast 仍然可用）。
 */
function AppShell() {
  const workspace = useCanvasStore((state) => state.workspace);

  useEffect(syncDocumentPreferences, []);
  useTldrawPreferences();
  useWorkspaceEvents(workspace?.id ?? null);
  useAgentNotifications();
  useBoardSync();
  const dispatch = useCommandDispatch();
  useAppKeybindings(dispatch);

  if (!workspace) {
    return (
      <>
        <Launcher />
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
        <Toaster position="bottom-right" />
      </>
    );
  }

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <LeftSidebar />
      <div className="relative min-w-0 flex-1">
        <TldrawWorkspace />
      </div>
      <ControlsCluster />
      <Dock />
      <UsageOrb />
      <Banners />
      <Suspense fallback={null}>
        <ExplorerDrawer />
        <SourceControlDrawer />
        <SettingsDialog />
        <CommandPalette />
        <DeliveryLog />
        <ControlConfirmDialog />
      </Suspense>
      <Toaster position="bottom-right" />
    </div>
  );
}
