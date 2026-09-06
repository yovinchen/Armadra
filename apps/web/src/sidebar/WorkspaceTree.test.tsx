import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

const listWorkspaces = vi.fn();
const createBoard = vi.fn();
const updateBoard = vi.fn();
const deleteBoard = vi.fn();
const updateWorkspace = vi.fn();
const deleteWorkspace = vi.fn();
const sessions = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    listWorkspaces: (...args: unknown[]) => listWorkspaces(...args),
    createBoard: (...args: unknown[]) => createBoard(...args),
    updateBoard: (...args: unknown[]) => updateBoard(...args),
    deleteBoard: (...args: unknown[]) => deleteBoard(...args),
    updateWorkspace: (...args: unknown[]) => updateWorkspace(...args),
    deleteWorkspace: (...args: unknown[]) => deleteWorkspace(...args),
    sessions: (...args: unknown[]) => sessions(...args),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn(),
    deliveries: vi.fn().mockResolvedValue([]),
    cloneRepo: vi.fn(),
    cloneStatus: vi.fn(),
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
import { WorkspaceTree } from "./WorkspaceTree";

installDomPolyfills();
afterEach(cleanup);

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

const FIRST = "019ff7d1-0d12-7421-833d-2c5e8d64ed30";
const SECOND = "019ff7d1-0d12-7421-833d-2c5e8d64ed31";

/** Radix 的下拉是 pointerdown 触发的，`click` 打不开。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
}

function renderTree() {
  return render(
    <TestProviders>
      <WorkspaceTree />
    </TestProviders>,
  );
}

/** store 里放几块板；`setBoards` 会按 sortOrder 排好。 */
function setBoards(count: number) {
  useCanvasStore.setState({ workspace, boards: [], boardId: null });
  useCanvasStore.getState().setBoards(
    [
      { id: FIRST, name: "Default", sortOrder: 0 },
      { id: SECOND, name: "实验", sortOrder: 1 },
    ].slice(0, count),
  );
  useCanvasStore.getState().selectBoard(FIRST);
}

beforeEach(() => {
  listWorkspaces.mockReset().mockResolvedValue([
    {
      ...workspace,
      boards: [
        { id: FIRST, name: "Default", nodeCount: 3 },
        { id: SECOND, name: "实验", nodeCount: 7 },
      ],
    },
  ]);
  createBoard.mockReset();
  updateBoard.mockReset();
  deleteBoard.mockReset();
  updateWorkspace.mockReset();
  deleteWorkspace.mockReset();
  sessions.mockReset().mockResolvedValue([]);
  usePreferencesStore.setState({
    openWorkspaceIds: [workspace.id],
    collapsedWorkspaceIds: [],
    pinnedBoardIds: [],
  });
  setBoards(2);
});

describe("WorkspaceTree", () => {
  it("「项目」组默认展开，缩进列出看板；行尾不带节点数", async () => {
    renderTree();

    expect(await screen.findByText("repo")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("实验")).toBeTruthy();
    expect(screen.queryByText("3")).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
    // 没有置顶就不显示置顶组
    expect(screen.queryByText("置顶")).toBeNull();
  });

  it("看板行不展开 Agent，Agent 也不出现在树里", async () => {
    sessions.mockResolvedValue([
      {
        nodeId: "node-1",
        boardId: FIRST,
        sessionId: "session-1",
        title: "Codex",
        cwd: "/repo",
        agentId: "codex",
        state: "idle",
        unread: true,
        updatedAt: timestamp,
        alive: true,
      },
    ]);
    renderTree();

    await screen.findByText("Default");
    // 会话只喂行尾那颗点，标题不进树
    expect(await screen.findByLabelText("未读")).toBeTruthy();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("看板名是纯文本，没有输入框", async () => {
    renderTree();

    fireEvent.doubleClick(await screen.findByText("实验"));
    expect(screen.queryByLabelText("看板名称")).toBeNull();
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it("项目名是纯文本，没有输入框", async () => {
    renderTree();

    fireEvent.doubleClick(await screen.findByText("repo"));
    expect(screen.queryByLabelText("工作空间名称")).toBeNull();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("看板菜单只有置顶与删除", async () => {
    renderTree();
    await screen.findByText("实验");

    openMenu(screen.getAllByLabelText("看板操作")[1]!);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["置顶", "删除"]);
  });

  it("「项目」右边的 + 添加项目（浏览器里退回新建文件夹对话框）", async () => {
    renderTree();
    await screen.findByText("repo");

    fireEvent.click(screen.getByLabelText("添加项目"));
    expect(await screen.findByText("新建文件夹")).toBeTruthy();
  });

  it("点工作空间行收起它的看板，状态写进偏好", async () => {
    renderTree();

    fireEvent.click(await screen.findByText("repo"));
    expect(screen.queryByText("实验")).toBeNull();
    expect(usePreferencesStore.getState().collapsedWorkspaceIds).toEqual([
      workspace.id,
    ]);
  });

  it("点看板切换当前看板", async () => {
    renderTree();

    fireEvent.click(await screen.findByText("实验"));
    expect(useCanvasStore.getState().boardId).toBe(SECOND);
  });

  it("看板菜单里的置顶把它放进置顶组", async () => {
    renderTree();
    await screen.findByText("实验");

    openMenu(screen.getAllByLabelText("看板操作")[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "置顶" }));

    expect(usePreferencesStore.getState().pinnedBoardIds).toEqual([SECOND]);
    // 置顶组出现，「实验」在树里出现两次（置顶一次、项目一次）
    expect(await screen.findByLabelText("置顶")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("实验").length).toBe(2));
  });

  it("只剩一块板时不让删", async () => {
    setBoards(1);
    renderTree();

    await screen.findByText("Default");
    openMenu(screen.getByLabelText("看板操作"));
    const item = await screen.findByRole("menuitem", { name: "删除" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(deleteBoard).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("删除走确认对话框", async () => {
    deleteBoard.mockResolvedValue(undefined);
    renderTree();

    await screen.findByText("实验");
    openMenu(screen.getAllByLabelText("看板操作")[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(deleteBoard).toHaveBeenCalledWith(workspace.id, SECOND),
    );
  });

  it("「新建看板」在当前工作空间建一块并切过去", async () => {
    const third = "019ff7d1-0d12-7421-833d-2c5e8d64ed32";
    createBoard.mockResolvedValue({ id: third, name: "看板 3", sortOrder: 2 });
    renderTree();
    await screen.findByText("repo");

    fireEvent.click(screen.getByText("新建看板"));

    await waitFor(() =>
      expect(createBoard).toHaveBeenCalledWith(workspace.id, "看板 3"),
    );
    await waitFor(() => expect(useCanvasStore.getState().boardId).toBe(third));
  });

  it("行菜单里的移除经确认后调接口并关掉这个工作空间", async () => {
    deleteWorkspace.mockResolvedValue(undefined);
    renderTree();

    await screen.findByText("repo");
    openMenu(screen.getByLabelText("工作空间菜单"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "删除" }),
    );

    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByText("不会删除磁盘文件")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    await waitFor(() =>
      expect(deleteWorkspace).toHaveBeenCalledWith(workspace.id),
    );
    await waitFor(() =>
      expect(usePreferencesStore.getState().openWorkspaceIds).toEqual([]),
    );
  });

  it("超过 8 块板时末尾给「展开显示」", async () => {
    useCanvasStore.setState({ workspace, boards: [], boardId: null });
    useCanvasStore.getState().setBoards(
      Array.from({ length: 10 }, (_value, index) => ({
        id: `019ff7d1-0d12-7421-833d-2c5e8d64ed${40 + index}`,
        name: `板 ${index}`,
        sortOrder: index,
      })),
    );
    renderTree();

    await screen.findByText("板 0");
    expect(screen.getByText("板 7")).toBeTruthy();
    expect(screen.queryByText("板 8")).toBeNull();

    fireEvent.click(screen.getByText("展开显示"));
    expect(await screen.findByText("板 9")).toBeTruthy();
    expect(screen.getByText("收起")).toBeTruthy();
  });
});
