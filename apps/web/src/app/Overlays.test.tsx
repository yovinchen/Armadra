import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * 闸门的守门用例（§17「代码分割」）。
 *
 * 分包只有在 chunk **没被取回来**的时候才省东西，而 `React.lazy` 是「被渲染
 * 就去取」。所以这里量的不是渲染结果，而是**那个 `import()` 有没有发生**：
 * 每个面板模块换成一个记账用的替身，空画布挂完整个 `<Overlays>` 之后，账上
 * 必须一笔都没有；把对应的开合状态翻开，那一笔才记上。
 *
 * 回归长这样：谁把某个浮层从 `<Gate>` 里挪出去、或者在 `Overlays.tsx` 顶上
 * 直接 `import` 了面板本体，下面第一条就红。
 */

const imported: string[] = [];

/** 记一笔，并给出一个什么都不画的组件。 */
function stub(name: string) {
  imported.push(name);
  return () => null;
}

vi.mock("@/panels/SettingsDialog", () => ({
  SettingsDialog: stub("SettingsDialog"),
}));
vi.mock("@/panels/CommandPalette", () => ({
  CommandPalette: stub("CommandPalette"),
}));
vi.mock("@/panels/QuickOpen", () => ({ QuickOpen: stub("QuickOpen") }));
vi.mock("@/panels/ExplorerDrawer", () => ({
  ExplorerDrawer: stub("ExplorerDrawer"),
}));
vi.mock("@/panels/git/window/GitToolWindow", () => ({
  GitToolWindow: stub("GitToolWindow"),
}));
vi.mock("@/panels/ResourceDrawer", () => ({
  ResourceDrawer: stub("ResourceDrawer"),
}));
vi.mock("@/panels/automation/AutomationDrawer", () => ({
  AutomationDrawer: stub("AutomationDrawer"),
}));
vi.mock("@/panels/handoff/HandoffHistoryDrawer", () => ({
  HandoffHistoryDrawer: stub("HandoffHistoryDrawer"),
}));
vi.mock("@/panels/UsageDashboard", () => ({
  UsageDashboard: stub("UsageDashboard"),
}));
vi.mock("@/panels/github/GithubDrawer", () => ({
  GithubDrawer: stub("GithubDrawer"),
}));
vi.mock("@/panels/problems/ProblemsPanel", () => ({
  ProblemsPanel: stub("ProblemsPanel"),
}));
vi.mock("@/panels/references/ReferencesPanel", () => ({
  ReferencesPanel: stub("ReferencesPanel"),
}));
vi.mock("@/editor/language/EditPreviewDialog", () => ({
  EditPreviewDialog: stub("EditPreviewDialog"),
}));
vi.mock("@/editor/language/CodeActionMenu", () => ({
  CodeActionMenu: stub("CodeActionMenu"),
}));
vi.mock("@/editor/merge/MergeDialog", () => ({
  MergeDialog: stub("MergeDialog"),
}));
// 事件流驱动的三个不在闸门后面：它们必须先订阅才等得到事件。
vi.mock("@/panels/ControlConfirmDialog", () => ({
  ControlConfirmDialog: () => null,
}));
vi.mock("@/panels/settings/pages/ssh/SshPromptDialog", () => ({
  SshPromptDialog: () => null,
}));
vi.mock("@/agent/handoff/HandoffDialog", () => ({
  HandoffDialog: () => null,
}));

const { Overlays } = await import("./Overlays");
const { requestOverlay, useOverlayGates } = await import("./overlay-gates");

/** `React.lazy` 的 `import()` 是微任务，要冲一轮才看得到结果。 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const panels = () => useCanvasStore.getState().panels;

beforeEach(() => {
  imported.length = 0;
  useOverlayGates.setState({ requested: new Set() });
});

afterEach(() => {
  for (const key of Object.keys(panels()) as (keyof ReturnType<
    typeof panels
  >)[]) {
    if (key === "sidebar") continue;
    useCanvasStore
      .getState()
      .setPanel(key, (typeof panels()[key] === "boolean" ? false : "closed") as never);
  }
});

describe("浮层的挂载闸门", () => {
  it("空画布挂完整个浮层层，一个面板模块也没被取回来", async () => {
    render(<Overlays />);
    await settle();
    expect(imported).toEqual([]);
  });

  it("面板开了，才取它那一份；别的仍然没动", async () => {
    render(<Overlays />);
    await settle();
    act(() => useCanvasStore.getState().setPanel("settings", true));
    await settle();
    expect(imported).toEqual(["SettingsDialog"]);
  });

  it("编辑器那三个浮层由它们自己的 store 报到，而不是由开合状态", async () => {
    render(<Overlays />);
    await settle();
    act(() => requestOverlay("merge"));
    await settle();
    expect(imported).toEqual(["MergeDialog"]);
  });

  it("关掉之后不再卸载：已经取回来的那一份就留着", async () => {
    render(<Overlays />);
    await settle();
    act(() => useCanvasStore.getState().setPanel("palette", true));
    await settle();
    act(() => useCanvasStore.getState().setPanel("palette", false));
    await settle();
    expect(imported).toEqual(["CommandPalette"]);
  });
});
