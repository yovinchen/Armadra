import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

vi.mock("../api/client", () => ({
  runtimeApi: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    createBoard: vi.fn(),
    updateBoard: vi.fn(),
    deleteBoard: vi.fn(),
    updateWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    sessions: vi.fn().mockResolvedValue([]),
    deliveries: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({
      repository: false,
      changedCount: 0,
      ahead: 0,
      behind: 0,
    }),
    agents: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../platform", () => ({
  pickDirectory: vi.fn().mockResolvedValue("/tmp/picked"),
  isTauri: () => false,
  onFileDrop: () => () => undefined,
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { LeftSidebar } from "./LeftSidebar";

installDomPolyfills();

const timestamp = "2026-09-04T10:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function renderSidebar() {
  return render(
    <TestProviders>
      <LeftSidebar />
    </TestProviders>,
  );
}

afterEach(() => cleanup());

beforeEach(() => {
  useCanvasStore.setState({ workspace, boards: [], boardId: null });
  useCanvasStore.getState().setPanel("sidebar", "open");
  usePreferencesStore.setState({
    openWorkspaceIds: [workspace.id],
    collapsedWorkspaceIds: [],
    pinnedBoardIds: [],
  });
});

describe("LeftSidebar", () => {
  it("自上而下是工作空间名、搜索/通知、新建看板、项目、设置", () => {
    renderSidebar();

    // 顶行的工作空间名 + 「项目」组里的那一行
    expect(screen.getAllByText("repo")).toHaveLength(2);
    expect(screen.getByLabelText("搜索")).toBeTruthy();
    expect(screen.getByLabelText("通知")).toBeTruthy();
    expect(screen.getByText("新建看板")).toBeTruthy();
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
    expect(screen.getByTestId("window-drag-region")).toBeTruthy();
    expect(screen.queryByTestId("window-drag-strip")).toBeNull();
  });

  it("折叠钮留在标题栏，折叠后左上角补一条拖拽带", () => {
    renderSidebar();
    const toggle = screen.getByLabelText("收起侧栏");

    fireEvent.click(toggle);
    expect(useCanvasStore.getState().panels.sidebar).toBe("collapsed");
    // 折叠之后按钮还在（同一个元素，没有被卸载），只是换了名字
    expect(screen.getByLabelText("展开侧栏")).toBe(toggle);

    const strip = screen.getByTestId("window-drag-strip");
    expect(strip.className).toContain("w-[120px]");
  });

  it("搜索打开命令面板，通知打开投递记录", () => {
    renderSidebar();

    fireEvent.click(screen.getByLabelText("搜索"));
    expect(useCanvasStore.getState().panels.palette).toBe(true);
  });

  it("折叠把宽度收到 0，展开再放回来", () => {
    renderSidebar();
    const aside = screen.getByLabelText("侧栏");
    expect(aside.getAttribute("data-state")).toBe("open");
    expect(aside.style.width).toBe("var(--sidebar-w)");

    act(() => useCanvasStore.getState().setPanel("sidebar", "collapsed"));
    expect(aside.getAttribute("data-state")).toBe("collapsed");
    expect(aside.style.width).toBe("0px");
    expect(aside.getAttribute("aria-hidden")).toBe("true");

    act(() => useCanvasStore.getState().setPanel("sidebar", "open"));
    expect(aside.style.width).toBe("var(--sidebar-w)");
  });

  it("开合状态同步进偏好（重启后恢复的依据）", () => {
    renderSidebar();
    act(() => useCanvasStore.getState().setPanel("sidebar", "collapsed"));
    expect(usePreferencesStore.getState().sidebarOpen).toBe(false);
    act(() => useCanvasStore.getState().setPanel("sidebar", "open"));
    expect(usePreferencesStore.getState().sidebarOpen).toBe(true);
  });
});
