import { Suspense } from "react";

import { useCanvasStore } from "../store/canvas-store";
import {
  AutomationDrawer,
  CommandPalette,
  ControlConfirmDialog,
  ExplorerDrawer,
  GithubDrawer,
  HandoffDialog,
  HandoffHistoryDrawer,
  CodeActionMenu,
  EditPreviewDialog,
  MergeDialog,
  ProblemsPanel,
  ReferencesPanel,
  ResourceDrawer,
  QuickOpen,
  SettingsDialog,
  GitToolWindow,
  SshPromptDialog,
  UsageDashboard,
} from "./lazy";
import { useMountedOnce, useOverlayRequested } from "./overlay-gates";

/**
 * 所有浮层的挂载点。
 *
 * 以前这一段直接写在 `App.tsx` 里，十几个 `lazy()` 组件无条件渲染——于是
 * `React.lazy` 在启动那一刻就把每一个 chunk 都取了回来。闸门的理由写在
 * `overlay-gates.ts`；这里只负责「谁看哪一个开合状态」。
 *
 * 三个例外留在下面无条件挂着，因为它们的触发器是工作空间事件流而不是一个
 * 开合状态：控制确认、SSH 口令、交接对话框都得在事件到达**之前**就已经订阅
 * 上。三个加起来不到 7 kB，放进闸门只会把「谁先订阅」这条规则弄乱。
 */

function Gate({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  return useMountedOnce(open) ? <>{children}</> : null;
}

export function Overlays() {
  const panels = useCanvasStore((state) => state.panels);
  const codeAction = useOverlayRequested("codeAction");
  const editPreview = useOverlayRequested("editPreview");
  const merge = useOverlayRequested("merge");

  return (
    <Suspense fallback={null}>
      <Gate open={panels.explorer !== "closed"}>
        <ExplorerDrawer />
      </Gate>
      <Gate open={panels.scm !== "closed"}>
        <GitToolWindow />
      </Gate>
      <Gate open={panels.problems !== "closed"}>
        <ProblemsPanel />
      </Gate>
      <Gate open={panels.references !== "closed"}>
        <ReferencesPanel />
      </Gate>
      <Gate open={editPreview}>
        <EditPreviewDialog />
      </Gate>
      <Gate open={codeAction}>
        <CodeActionMenu />
      </Gate>
      <Gate open={merge}>
        <MergeDialog />
      </Gate>
      <Gate open={panels.resources !== "closed"}>
        <ResourceDrawer />
      </Gate>
      <Gate open={panels.automation !== "closed"}>
        <AutomationDrawer />
      </Gate>
      <Gate open={panels.usage !== "closed"}>
        <UsageDashboard />
      </Gate>
      <Gate open={panels.github !== "closed"}>
        <GithubDrawer />
      </Gate>
      <Gate open={panels.settings}>
        <SettingsDialog />
      </Gate>
      <Gate open={panels.palette}>
        <CommandPalette />
      </Gate>
      <Gate open={panels.quickOpen}>
        <QuickOpen />
      </Gate>
      <Gate open={panels.handoff !== "closed"}>
        <HandoffHistoryDrawer />
      </Gate>
      {/* 事件流驱动的三个：必须先订阅，不能等状态。 */}
      <ControlConfirmDialog />
      <SshPromptDialog />
      <HandoffDialog />
    </Suspense>
  );
}
