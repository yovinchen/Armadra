import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorkspaceSummary } from "@armadra/shared";

const listWorkspaces = vi.fn();
const openWorkspace = vi.fn((_id: string) => Promise.resolve());
const deleteWorkspace = vi.fn((_id: string) => Promise.resolve());

vi.mock("../api/client", () => ({
  runtimeApi: {
    listWorkspaces: () => listWorkspaces(),
    openWorkspace: (id: string) => openWorkspace(id),
    deleteWorkspace: (id: string) => deleteWorkspace(id),
    createWorkspace: vi.fn(),
    cloneRepository: vi.fn(),
    gitCloneStatus: vi.fn(),
    cancelClone: vi.fn(),
  },
}));

import { installDomPolyfills, TestProviders } from "./test-harness";
import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { Launcher } from "./Launcher";

installDomPolyfills();
afterEach(cleanup);

function workspace(id: string, name: string): WorkspaceSummary {
  const now = new Date().toISOString();
  return {
    id,
    name,
    rootPath: `/tmp/${name}`,
    color: "#5B5BD6",
    permissions: { read: true, write: true, execute: true },
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    boards: [],
  };
}

/** Radix 的下拉是 pointerdown 触发的，`click` 打不开。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
}

describe("Launcher", () => {
  beforeEach(() => {
    listWorkspaces.mockReset();
    openWorkspace.mockClear();
    deleteWorkspace.mockClear();
    usePreferencesStore.setState({ openWorkspaceIds: [] });
    useCanvasStore.setState({ workspace: null });
  });

  it("列出最近的工作空间", async () => {
    listWorkspaces.mockResolvedValue([
      workspace("11111111-1111-4111-8111-111111111111", "alpha"),
      workspace("22222222-2222-4222-8222-222222222222", "beta"),
    ]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(await screen.findByText("/tmp/beta")).toBeTruthy();
  });

  it("操作条三段加右上角设置", async () => {
    listWorkspaces.mockResolvedValue([]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    expect(await screen.findByText("新建文件夹")).toBeTruthy();
    expect(screen.getByText("打开文件夹")).toBeTruthy();
    expect(screen.getByText("克隆仓库")).toBeTruthy();
    expect(screen.getByLabelText("设置")).toBeTruthy();
  });

  it("空列表只有一行文字，没有搜索框", async () => {
    listWorkspaces.mockResolvedValue([]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    expect(await screen.findByText("还没有工作空间")).toBeTruthy();
    expect(screen.queryByLabelText("搜索")).toBeNull();
  });

  it("超过 8 个工作空间才长出搜索框，且只筛出匹配的行", async () => {
    listWorkspaces.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) =>
        workspace(`${index + 1}1111111-1111-4111-8111-111111111111`, `ws${index}`),
      ),
    );
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    const search = await screen.findByLabelText("搜索");
    fireEvent.change(search, { target: { value: "ws3" } });
    expect(screen.getByText("ws3")).toBeTruthy();
    expect(screen.queryByText("ws4")).toBeNull();
  });

  it("行上相对时间与 ⋯ 各占各的位置，不互相顶掉", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    listWorkspaces.mockResolvedValue([workspace(id, "epsilon")]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    await screen.findByText("epsilon");
    // 时间常驻在名称那一行，`⋯` 在行右侧自己的 40px 里——两者同时存在。
    expect(screen.getByText("刚刚")).toBeTruthy();
    expect(screen.getByLabelText("工作空间操作")).toBeTruthy();
  });

  it("新建文件夹卡片打开对话框", async () => {
    listWorkspaces.mockResolvedValue([]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    fireEvent.click(await screen.findByText("新建文件夹"));
    expect(await screen.findByLabelText("父目录")).toBeTruthy();
  });

  it("克隆仓库卡片打开对话框", async () => {
    listWorkspaces.mockResolvedValue([]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    fireEvent.click(await screen.findByText("克隆仓库"));
    expect(await screen.findByLabelText("仓库地址")).toBeTruthy();
  });

  it("卡片的 ⋯ 菜单经确认后才调用移除接口", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    listWorkspaces.mockResolvedValue([workspace(id, "gamma")]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    await screen.findByText("gamma");

    openMenu(screen.getByLabelText("工作空间操作"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "从列表移除" }),
    );

    // 菜单项本身不删任何东西，先出确认框，而且只写那一句话。
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByText("移除工作空间？")).toBeTruthy();
    expect(screen.getByText("不会删除磁盘文件")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith(id));
  });

  it("确认框上的取消不删任何东西", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    listWorkspaces.mockResolvedValue([workspace(id, "delta")]);
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    await screen.findByText("delta");

    openMenu(screen.getByLabelText("工作空间操作"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "从列表移除" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));

    expect(deleteWorkspace).not.toHaveBeenCalled();
  });

  it("本地服务不可达时给出重连入口", async () => {
    listWorkspaces.mockRejectedValue(new Error("boom"));
    render(
      <TestProviders>
        <Launcher />
      </TestProviders>,
    );
    expect(await screen.findByText("无法连接本地服务")).toBeTruthy();
    expect(screen.getByText("重连")).toBeTruthy();
  });
});
