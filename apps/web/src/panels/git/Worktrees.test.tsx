import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  GitWorktreeRecord,
  Workspace,
} from "@armadra/shared";

import { runtimeApi } from "../../api/client";
import { usePreferencesStore } from "../../app/preferences-store";
import { installDomPolyfills } from "../../app/test-harness";
import { useCanvasStore } from "../../store/canvas-store";
import {
  clearArmedInitScripts,
  consumeArmedInitScript,
  frameBindingOf,
} from "../../canvas/frame-binding";
import { Worktrees } from "./Worktrees";

installDomPolyfills();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STAMP = "2026-09-05T10:00:00.000Z";
const ROOT = "/Users/dev/project";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed10",
  name: "One",
  rootPath: ROOT,
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: STAMP,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const board: Board = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed11",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: STAMP,
  updatedAt: STAMP,
};

function worktree(patch: Partial<GitWorktreeRecord> = {}): GitWorktreeRecord {
  return {
    path: `${ROOT}/wt/feature`,
    headOid: "a".repeat(40),
    branch: "feature/login",
    detached: false,
    bare: false,
    isMain: false,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    accessible: true,
    dirty: false,
    ...patch,
  };
}

function boundFrame(): CanvasNode {
  return {
    id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
    boardId: board.id,
    type: "group",
    title: "feature/login",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 720, height: 560 },
    labels: [],
    note: "",
    data: {
      kind: "group",
      binding: {
        worktreePath: "wt/feature",
        branch: "feature/login",
        repositoryId: "repo-1",
        initScript: null,
        initScriptState: "none",
        initScriptNodeId: null,
      },
    },
    createdAt: STAMP,
    updatedAt: STAMP,
  } as CanvasNode;
}

function load(nodes: CanvasNode[] = []) {
  const document: BoardDocument = { board, nodes, edges: [] };
  useCanvasStore.setState({ workspace, document, boardId: board.id });
}

function setup(nodes: CanvasNode[] = []) {
  load(nodes);
  const request = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <Worktrees
        workspaceId={workspace.id}
        repositoryKey="repo-0:."
        target={{
          workspaceId: workspace.id,
          repositoryPath: workspace.rootPath,
          path: ".",
        }}
        branches={[]}
        busy={false}
        request={request}
      />
    </QueryClientProvider>,
  );
  return { request, client };
}

const nodesOf = () => useCanvasStore.getState().document?.nodes ?? [];

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  clearArmedInitScripts();
  useCanvasStore.setState({
    workspace: null,
    document: null,
    boardId: null,
    selectedNodeIds: [],
  });
});

it("creates a bound Frame and one init terminal after the worktree appears", async () => {
  let current: GitWorktreeRecord[] = [];
  vi.spyOn(runtimeApi, "gitRepositoryWorktrees").mockImplementation(
    async () => current,
  );
  const { request, client } = setup();
  await screen.findByText("No worktrees");

  fireEvent.change(screen.getByLabelText(/Worktree path/), {
    target: { value: "wt/feature" },
  });
  fireEvent.change(screen.getByLabelText("Branch name"), {
    target: { value: "feature/login" },
  });
  fireEvent.click(
    screen.getByLabelText("Also create a Frame bound to this worktree"),
  );
  fireEvent.change(
    screen.getByLabelText("Init script (runs once in the new worktree)"),
    { target: { value: "pnpm install" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));

  expect(request).toHaveBeenCalledExactlyOnceWith({
    kind: "createWorktree",
    path: "wt/feature",
    branch: "feature/login",
    createBranch: true,
    expectedOid: null,
    startPoint: null,
  });
  // 画布上还什么都没有：checkout 出现在列表里才算成功。
  expect(nodesOf()).toHaveLength(0);

  current = [worktree()];
  await act(async () => {
    await client.invalidateQueries();
  });
  await screen.findByText(`${ROOT}/wt/feature`);

  const frame = nodesOf().find((node) => node.type === "group");
  expect(frameBindingOf(frame)).toMatchObject({
    worktreePath: "wt/feature",
    branch: "feature/login",
    initScript: "pnpm install",
    initScriptState: "pending",
  });
  const terminal = nodesOf().find((node) => node.type === "terminal");
  expect(terminal?.parentId).toBe(frame!.id);
  // cwd 是继承来的绝对路径（Runtime 直接拿它当子进程的工作目录）。
  expect(terminal?.data).toMatchObject({ cwd: `${ROOT}/wt/feature` });
  expect(
    frameBindingOf(frame ? nodesOf().find((n) => n.id === frame.id) : null),
  ).toMatchObject({ initScriptNodeId: terminal!.id });
  // 只开一个终端，而且脚本的闸只开一次。
  expect(nodesOf().filter((node) => node.type === "terminal")).toHaveLength(1);
  expect(consumeArmedInitScript(frame!.id)).toBe(true);
  expect(consumeArmedInitScript(frame!.id)).toBe(false);
});

it("does not touch the canvas when the Frame option is off", async () => {
  let current: GitWorktreeRecord[] = [];
  vi.spyOn(runtimeApi, "gitRepositoryWorktrees").mockImplementation(
    async () => current,
  );
  const { client } = setup();
  await screen.findByText("No worktrees");
  fireEvent.change(screen.getByLabelText(/Worktree path/), {
    target: { value: "wt/feature" },
  });
  fireEvent.change(screen.getByLabelText("Branch name"), {
    target: { value: "feature/login" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  current = [worktree()];
  await act(async () => {
    await client.invalidateQueries();
  });
  await screen.findByText(`${ROOT}/wt/feature`);
  expect(nodesOf()).toHaveLength(0);
});

it("unbinding clears the binding; removing the worktree is a separate, safe action", async () => {
  vi.spyOn(runtimeApi, "gitRepositoryWorktrees").mockResolvedValue([
    worktree(),
  ]);
  const frame = boundFrame();
  const { request } = setup([frame]);
  expect(await screen.findByText("Bound Frame: feature/login")).toBeTruthy();

  // 移除走的是既有的安全删除，且不碰绑定。
  fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
  expect(request).toHaveBeenCalledExactlyOnceWith({
    kind: "removeWorktree",
    path: `${ROOT}/wt/feature`,
    expectedOid: "a".repeat(40),
    allowUnpublished: false,
  });
  expect(frameBindingOf(nodesOf()[0])).not.toBeNull();

  // 解绑只清画布上的绑定，一个仓库请求都不发。
  request.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Unbind Frame" }));
  expect(request).not.toHaveBeenCalled();
  expect(nodesOf()[0]!.data).toEqual({ kind: "group", binding: null });
});

it("keeps the remove button refusing a dirty checkout", async () => {
  vi.spyOn(runtimeApi, "gitRepositoryWorktrees").mockResolvedValue([
    worktree({ dirty: true }),
  ]);
  setup([boundFrame()]);
  const remove = await screen.findByRole("button", {
    name: "Remove worktree",
  });
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  // 解绑不受影响：它不动磁盘，所以脏不脏都能解。
  const unbind = screen.getByRole("button", { name: "Unbind Frame" });
  expect((unbind as HTMLButtonElement).disabled).toBe(false);
});
