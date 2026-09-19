import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  FrameBinding,
  GitRepositoryList,
  Workspace,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { useCanvasStore } from "@/store/canvas-store";
import { WorktreeBindingBadge } from "./WorktreeBindingBadge";

installDomPolyfills();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STAMP = "2026-09-05T10:00:00.000Z";
const ROOT = "/Users/dev/project";
const FRAME = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";

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

function binding(patch: Partial<FrameBinding> = {}): FrameBinding {
  return {
    worktreePath: "wt/feature",
    branch: "feature/login",
    repositoryId: "repo-1",
    initScript: null,
    initScriptState: "none",
    initScriptNodeId: null,
    ...patch,
  };
}

function frame(bound: FrameBinding): CanvasNode {
  return {
    id: FRAME,
    boardId: board.id,
    type: "group",
    title: "feature/login",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 720, height: 560 },
    labels: [],
    note: "",
    data: { kind: "group", binding: bound },
    createdAt: STAMP,
    updatedAt: STAMP,
  } as CanvasNode;
}

function list(dirtyCount: number | null, present = true): GitRepositoryList {
  return {
    workspaceRoot: ROOT,
    maxDepth: 4,
    truncated: false,
    observedAt: STAMP,
    repositories: [
      {
        repositoryId: "repo-0",
        repositoryPath: ".",
        name: "project",
        kind: "root",
        parentRepositoryId: null,
        headBranch: "main",
        dirtyCount: 0,
      },
      ...(present
        ? [
            {
              repositoryId: "repo-1",
              repositoryPath: "wt/feature",
              name: "feature",
              kind: "worktree" as const,
              parentRepositoryId: "repo-0",
              headBranch: "feature/login",
              dirtyCount,
            },
          ]
        : []),
    ],
  };
}

function mount(bound: FrameBinding) {
  const node = frame(bound);
  const document: BoardDocument = { board, nodes: [node], edges: [] };
  useCanvasStore.setState({ workspace, document, boardId: board.id });
  render(
    <TestProviders>
      <WorktreeBindingBadge node={node} />
    </TestProviders>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({
    workspace: null,
    document: null,
    boardId: null,
    selectedNodeIds: [],
  });
});

it("shows the branch, the worktree path and the change count", async () => {
  vi.spyOn(runtimeApi, "gitRepositories").mockResolvedValue(list(3));
  mount(binding());
  expect(await screen.findByText("3 uncommitted change(s)")).toBeTruthy();
  expect(screen.getByText("feature/login")).toBeTruthy();
  const path = screen.getByTitle("wt/feature");
  expect(path.textContent).toContain("wt/feature");
});

it("tells an unknown change count apart from a clean checkout", async () => {
  const spy = vi
    .spyOn(runtimeApi, "gitRepositories")
    .mockResolvedValue(list(0));
  mount(binding());
  expect(await screen.findByText("No uncommitted changes")).toBeTruthy();
  cleanup();
  // `dirtyCount: null` 是「数不了」（没有执行权限），不是 0。
  spy.mockResolvedValue(list(null));
  mount(binding());
  expect(
    await screen.findByText("Change count unknown (needs an execution grant)"),
  ).toBeTruthy();
  expect(screen.queryByText("No uncommitted changes")).toBeNull();
});

it("offers recreate and unbind once the checkout is gone", async () => {
  vi.spyOn(runtimeApi, "gitRepositories").mockResolvedValue(list(0, false));
  vi.spyOn(runtimeApi, "gitRepositoryBranches").mockResolvedValue({
    repositoryId: "repo-0",
    repositoryPath: ".",
    head: { headOid: "b".repeat(40), branch: "main" },
    branches: [
      {
        name: "feature/login",
        fullRef: "refs/heads/feature/login",
        oid: "a".repeat(40),
        remote: false,
        current: false,
        upstream: null,
        ahead: null,
        behind: null,
        upstreamMissing: false,
        symbolicTarget: null,
      },
    ],
    remotes: ["origin"],
    observedAt: STAMP,
  });
  const operate = vi
    .spyOn(runtimeApi, "gitRepositoryOperate")
    .mockResolvedValue({} as never);
  // 服务端判定这一路读不通时（这里没有桩），徽章退回发现结果那一档，而不
  // 是宣布绑定坏了——这正是「检查失败不是结论」那条规则。
  vi.spyOn(runtimeApi, "gitRepositoryWorktreeBinding").mockRejectedValue(
    new Error("no verdict"),
  );
  mount(binding());
  expect(await screen.findByText("Worktree not found")).toBeTruthy();

  const recreate = await screen.findByRole("button", { name: "Recreate" });
  await vi.waitFor(() =>
    expect((recreate as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(recreate);
  // 网关先要问一次归属，所以这一次写落在微任务上，不在点击的同一拍。
  await vi.waitFor(() =>
    expect(operate).toHaveBeenCalledExactlyOnceWith(
      workspace.id,
      {
        kind: "createWorktree",
        path: "wt/feature",
        branch: "feature/login",
        createBranch: false,
        expectedOid: "a".repeat(40),
        startPoint: null,
      },
      { headOid: "b".repeat(40), branch: "main" },
      ".",
    ),
  );
});

it("unbinding clears the binding and never removes the checkout", async () => {
  vi.spyOn(runtimeApi, "gitRepositories").mockResolvedValue(list(0, false));
  vi.spyOn(runtimeApi, "gitRepositoryBranches").mockRejectedValue(
    new Error("no branches"),
  );
  const operate = vi.spyOn(runtimeApi, "gitRepositoryOperate");
  mount(binding());
  fireEvent.click(await screen.findByRole("button", { name: "Unbind" }));
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((item) => item.id === FRAME);
  expect(node?.data).toEqual({ kind: "group", binding: null });
  expect(operate).not.toHaveBeenCalled();
});

it("reports the init script state", async () => {
  vi.spyOn(runtimeApi, "gitRepositories").mockResolvedValue(list(0));
  mount(binding({ initScript: "pnpm install", initScriptState: "failed" }));
  expect(await screen.findByText("Init script failed")).toBeTruthy();
});
