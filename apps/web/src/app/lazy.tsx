import { lazy } from "react";

/**
 * 浮层的懒加载入口（§17「代码分割」）。
 *
 * 壳打开时只有 TabBar + 画布是必需的；设置、命令面板、资源管理器、源码控制、
 * 投递日志、控制确认框都是"用户按了才出现"的浮层，全部切到独立 chunk，
 * 让入口 chunk 只带画布这条主链路。挂载点在 `App.tsx`，统一包
 * `<Suspense fallback={null}>`：浮层默认是关闭状态，加载期间本来就不该有像素。
 *
 * 命名导出要在这里转成 default，`React.lazy` 只认 `{ default }`。
 */

export const SettingsDialog = lazy(() =>
  import("@/panels/SettingsDialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);

export const CommandPalette = lazy(() =>
  import("@/panels/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);

export const ControlConfirmDialog = lazy(() =>
  import("@/panels/ControlConfirmDialog").then((module) => ({
    default: module.ControlConfirmDialog,
  })),
);

export const HandoffDialog = lazy(() =>
  import("@/agent/handoff/HandoffDialog").then((module) => ({
    default: module.HandoffDialog,
  })),
);

export const ExplorerDrawer = lazy(() =>
  import("@/panels/ExplorerDrawer").then((module) => ({
    default: module.ExplorerDrawer,
  })),
);

export const SourceControlDrawer = lazy(() =>
  import("@/panels/SourceControlDrawer").then((module) => ({
    default: module.SourceControlDrawer,
  })),
);
