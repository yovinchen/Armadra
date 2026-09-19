import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import type { Workspace } from "@armadra/shared";
import { useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";

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
    loadBoard: vi.fn(),
    conversations: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../platform", () => ({
  pickDirectory: vi.fn().mockResolvedValue("/tmp/picked"),
  isDesktop: () => false,
  onFileDrop: () => () => undefined,
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { LeftSidebar } from "./LeftSidebar";

installDomPolyfills();
const initialMatchMedia = window.matchMedia;

const timestamp = "2026-09-04T10:00:00.000Z";
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

function SettingsFocusHarness() {
  const open = useCanvasStore((state) => state.panels.settings);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === ",")
        useCanvasStore.getState().setPanel("settings", true);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  return (
    <Dialog open={open}>
      <DialogContent aria-describedby={undefined} showCloseButton={false}>
        <DialogTitle>测试设置</DialogTitle>
        <input aria-label="设置输入" />
        <button
          onClick={() => useCanvasStore.getState().setPanel("settings", false)}
        >
          关闭设置
        </button>
      </DialogContent>
    </Dialog>
  );
}

function responsiveWidth(initial: number) {
  let width = initial;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    if (query !== "(max-width: 767px)") return initialMatchMedia(query);
    return {
      ...initialMatchMedia(query),
      matches: width <= 767,
      addEventListener: (
        _event: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _event: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        listeners.delete(listener);
      },
    };
  });
  return (next: number) => {
    width = next;
    act(() => {
      for (const listener of listeners) {
        if (typeof listener === "function") listener(new Event("change"));
        else listener.handleEvent(new Event("change"));
      }
    });
  };
}

function renderSidebar(withSettings = false) {
  return render(
    <TestProviders>
      <LeftSidebar />
      {withSettings && <SettingsFocusHarness />}
    </TestProviders>,
  );
}

afterEach(() => {
  cleanup();
  window.matchMedia = initialMatchMedia;
});

beforeEach(() => {
  useCanvasStore.setState({ workspace, boards: [], boardId: null });
  useCanvasStore.getState().setPanel("sidebar", "open");
  useCanvasStore.getState().setPanel("settings", false);
  usePreferencesStore.setState({
    openWorkspaceIds: [workspace.id],
    collapsedWorkspaceIds: [],
    pinnedBoardIds: [],
  });
});

describe("LeftSidebar", () => {
  it("自上而下是标题栏、Armadra、新建画布、项目、设置", () => {
    renderSidebar();

    // 顶行写的是系统名；工作空间名只出现在「项目」组里那一行
    expect(screen.getByText("Armadra")).toBeTruthy();
    expect(screen.getAllByText("repo")).toHaveLength(1);
    expect(screen.getByText("新建画布")).toBeTruthy();
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.getByLabelText("添加项目")).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
    expect(screen.getByTestId("window-titlebar-inset")).toBeTruthy();
  });

  it("搜索与通知都在标题栏那一行里，与折叠钮同排", () => {
    renderSidebar();
    const titlebar = screen.getByTestId("window-titlebar-inset");

    expect(titlebar.contains(screen.getByLabelText("搜索"))).toBe(true);
    expect(titlebar.contains(screen.getByLabelText("通知"))).toBe(true);
    // 折叠钮画在侧栏外面（fixed），所以不在这条流里
    expect(titlebar.contains(screen.getByLabelText("收起侧栏"))).toBe(false);
  });

  it("折叠钮留在标题栏，拖拽交给全局拖拽层，这里不再自带拖拽带", () => {
    renderSidebar();
    const toggle = screen.getByLabelText("收起侧栏");

    fireEvent.click(toggle);
    expect(useCanvasStore.getState().panels.sidebar).toBe("collapsed");
    // 折叠之后按钮还在（同一个元素，没有被卸载），只是换了名字
    expect(screen.getByLabelText("展开侧栏")).toBe(toggle);
    expect(screen.queryByTestId("window-drag-strip")).toBeNull();
  });

  it("搜索打开搜索面板，不再是命令面板", async () => {
    renderSidebar();

    fireEvent.click(screen.getByLabelText("搜索"));
    expect(await screen.findByPlaceholderText("搜索")).toBeTruthy();
    expect(useCanvasStore.getState().panels.palette).toBe(false);
  });

  it("通知在「项目」的位置展开 Agent 面板，再按一次收回", () => {
    renderSidebar();
    const bell = screen.getByLabelText("通知");

    fireEvent.click(bell);
    expect(screen.queryByText("项目")).toBeNull();

    fireEvent.click(bell);
    expect(screen.getByText("项目")).toBeTruthy();
  });

  it("Esc 收回 Agent 面板", () => {
    renderSidebar();

    fireEvent.click(screen.getByLabelText("通知"));
    expect(screen.queryByText("项目")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("项目")).toBeTruthy();
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
  it("窄屏侧栏作为抽屉打开，关闭后画布仍保留完整宽度", async () => {
    const original = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...original(query),
      matches: query === "(max-width: 767px)",
    }));
    useCanvasStore.getState().setPanel("sidebar", "collapsed");
    renderSidebar();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    const drawer = await screen.findByRole("dialog", { name: "侧栏" });
    expect(within(drawer).getByRole("button", { name: "搜索" })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "收起侧栏" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useCanvasStore.getState().panels.sidebar).toBe("collapsed");
  });

  it("从手机侧栏打开设置时先收起抽屉", async () => {
    const original = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...original(query),
      matches: query === "(max-width: 767px)",
    }));
    renderSidebar();
    const drawer = await screen.findByRole("dialog", { name: "侧栏" });
    fireEvent.click(within(drawer).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(useCanvasStore.getState().panels.sidebar).toBe("collapsed");
    expect(usePreferencesStore.getState().sidebarOpen).toBe(false);
  });

  it("设置已打开时从桌面缩到手机宽度不会新开侧栏弹层或丢失偏好", async () => {
    const resize = responsiveWidth(1280);
    useCanvasStore.getState().setPanel("settings", true);
    renderSidebar(true);
    const input = await screen.findByRole("textbox", { name: "设置输入" });
    input.focus();
    resize(390);
    expect(screen.queryByRole("dialog", { name: "侧栏" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "测试设置" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "设置输入" })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(useCanvasStore.getState().panels.sidebar).toBe("open");
    expect(usePreferencesStore.getState().sidebarOpen).toBe(true);
    expect(
      document
        .querySelector('[data-slot="sidebar-toggle"] button')
        ?.getAttribute("aria-label"),
    ).toBe("展开侧栏");
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(await screen.findByRole("dialog", { name: "侧栏" })).toBeTruthy();
    expect(usePreferencesStore.getState().sidebarOpen).toBe(true);
  });

  it("窄屏快捷键打开设置会暂时隐藏侧栏且不把焦点抢回折叠按钮", async () => {
    responsiveWidth(390);
    renderSidebar(true);
    await screen.findByRole("dialog", { name: "侧栏" });
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-slot="sidebar-toggle"] button',
    )!;
    const focusToggle = vi.spyOn(toggle, "focus");
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "设置输入" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "侧栏" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(focusToggle).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.sidebar).toBe("open");
    expect(usePreferencesStore.getState().sidebarOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(await screen.findByRole("dialog", { name: "侧栏" })).toBeTruthy();
  });
});
