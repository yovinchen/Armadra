import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

vi.mock("../api/client", () => ({
  RUNTIME_URL: "http://127.0.0.1:0",
  runtimeApi: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listBoards: vi.fn().mockResolvedValue([]),
    loadBoard: vi.fn(),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    sessions: vi.fn().mockResolvedValue([]),
    deliveries: vi.fn().mockResolvedValue([]),
    agents: vi.fn().mockResolvedValue([]),
    usage: vi.fn().mockResolvedValue(null),
    conversations: vi.fn().mockResolvedValue([]),
    // The SSH prompt dialog polls on mount now that the overlays gate mounts
    // it eagerly (it is the one overlay that has to be awake before a prompt).
    sshPrompts: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../platform", () => ({
  isDesktop: () => true,
  pickDirectory: vi.fn().mockResolvedValue(null),
  onFileDrop: () => () => undefined,
}));

vi.mock("../api/events", () => ({
  useWorkspaceEvents: () => undefined,
  onWorkspaceEvent: () => () => undefined,
  onWorkspaceConnection: () => () => undefined,
  onWorkspaceAccessLost: () => () => undefined,
  useRuntimeConnection: () => "open",
}));

/** 画布本身在 jsdom 里跑不动，这里只关心它在不在。 */
vi.mock("../canvas/FlowWorkspace", () => ({
  FlowWorkspace: () => <div data-testid="canvas" />,
}));

import { installDomPolyfills } from "./test-harness";
import { runtimeApi } from "../api/client";
import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { App } from "./App";

installDomPolyfills();

const timestamp = "2026-09-05T10:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(() => {
  cleanup();
  delete (window as { armadra?: unknown }).armadra;
});

beforeEach(() => {
  vi.mocked(runtimeApi.listWorkspaces).mockResolvedValue([]);
  useCanvasStore.setState({ workspace: null, boards: [], boardId: null });
  useCanvasStore.getState().setPanel("sidebar", "open");
  usePreferencesStore.setState({
    openWorkspaceIds: [],
    collapsedWorkspaceIds: [],
    pinnedBoardIds: [],
  });
  // 拖拽属性只看 `window.armadra` 在不在（window-region.ts 的 isShell）；
  // 壳挂起来之后 App 还会去装全局快捷键、订阅窗口意图，所以桩得把这几样
  // 接住，都是不做事的空实现。
  (window as { armadra?: unknown }).armadra = {
    dialog: { pickDirectory: async () => [] },
    shell: {
      openExternal: async () => undefined,
      showItemInFolder: async () => ({ ok: true }),
    },
    shortcuts: { apply: async () => [], onTriggered: () => () => undefined },
    window: {
      isFocused: async () => true,
      onKeyIntent: () => () => undefined,
      resolveKeyIntent: async () => ({ ok: true }),
      onNotificationClick: () => () => undefined,
    },
    app: { locale: async () => "zh-CN" },
    pathForFile: () => "",
  };
});

/**
 * 可拖拽区域由原生层按 DOM 顺序计算：`drag` 矩形并进去、`no-drag` 矩形减
 * 出来，后出现的覆盖先出现的。页面里的命中测试看不出这个问题——那是 z 轴的
 * 事——所以这里守的是顺序本身：拖拽层必须排在每一个 `no-drag` 控件前面。
 */
describe("桌面壳里的拖拽区顺序", () => {
  it("拖拽层是整棵树里第一个带拖拽属性的节点，排在侧栏的按钮前面", () => {
    render(<App />);
    const layer = screen.getByTestId("window-drag-layer");
    expect(layer.getAttribute("data-app-region")).toBe("drag");
    const regions = [
      ...document.querySelectorAll("[data-app-region]"),
    ] as HTMLElement[];
    expect(regions[0]).toBe(layer);
    const search = screen.getByLabelText("搜索");
    expect(
      layer.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(search.closest('[data-app-region="no-drag"]')).not.toBeNull();
  });

  it("右上角的控件簇整体写回 no-drag：它的第一格落在拖拽带里", () => {
    render(<App />);
    act(() => useCanvasStore.getState().setWorkspace(workspace));
    const cluster = document.querySelector('[data-slot="controls-cluster"]');
    expect(cluster?.getAttribute("data-app-region")).toBe("no-drag");
    expect(
      screen
        .getByTestId("window-drag-layer")
        .compareDocumentPosition(cluster!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("侧栏折叠钮挂在 body 下，不留在 App 的 flex 根容器里", () => {
    render(<App />);
    const toggle = document.querySelector('[data-slot="sidebar-toggle"]');
    expect(toggle?.parentElement).toBe(document.body);
    expect(toggle?.getAttribute("data-app-region")).toBe("no-drag");
  });
});
