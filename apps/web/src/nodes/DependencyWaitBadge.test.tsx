import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  launchHold,
  migrateLegacyLaunch,
  useDependencyStore,
} from "@/agent/dependency-store";
import { deriveEdges } from "@/canvas/derived-edges";
import { useCanvasStore } from "@/store/canvas-store";
import { DependencyWaitBadge } from "./DependencyWaitBadge";

/**
 * 「等待 X」（Agent 自动化设计 §6）。等待与启动都归 core：徽标读依赖表，页面
 * 只在 core 说「还在等」时不敲启动行；旧节点数据里带依赖的 `pendingLaunch`
 * 交给 core 之后从节点数据里摘掉。
 */

const core = vi.hoisted(() => ({
  launches: [] as Record<string, unknown>[],
  cancelled: [] as string[],
  imported: [] as { nodeId: string; after: readonly string[] }[],
  fail: false,
}));

vi.mock("@/api/client", () => ({
  runtimeApi: {
    dependencies: () =>
      core.fail
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ launches: core.launches }),
    cancelDependency: (_workspaceId: string, id: string) => {
      core.cancelled.push(id);
      core.launches = [];
      return Promise.resolve({ dependency: {} });
    },
    importLegacyDependencies: (
      _workspaceId: string,
      nodeId: string,
      after: readonly string[],
    ) => {
      core.imported.push({ nodeId, after });
      return Promise.resolve({ launch: {} });
    },
  },
}));

const edge = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace-1",
  downstreamNodeId: "node-b",
  upstreamNodeId: "node-a",
  upstreamTitle: "Builder",
  condition: "current",
  state: "waiting",
  reason: null,
  baseline: { state: "working", eventAt: null },
  createdAt: null,
  updatedAt: null,
  expiresAt: null,
  resolvedAt: null,
  ...patch,
});

const launch = (patch: Record<string, unknown> = {}) => ({
  nodeId: "node-b",
  workspaceId: "workspace-1",
  boardId: "board-1",
  state: "waiting",
  reason: null,
  attempts: 0,
  hasTask: false,
  sessionId: null,
  createdAt: null,
  launchedAt: null,
  dependencies: [edge("dep-1")],
  ...patch,
});

beforeEach(() => {
  core.launches = [];
  core.cancelled = [];
  core.imported = [];
  core.fail = false;
  useDependencyStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useDependencyStore.getState().reset();
});

describe("DependencyWaitBadge", () => {
  it("没有等待就什么都不画", async () => {
    render(<DependencyWaitBadge nodeId="node-b" workspaceId="workspace-1" />);
    await waitFor(() =>
      expect(useDependencyStore.getState().loaded).toBe(true),
    );
    expect(screen.queryByTestId("dependency-wait-node-b")).toBeNull();
  });

  it("写出在等谁，并能不等了", async () => {
    core.launches = [launch()];
    render(<DependencyWaitBadge nodeId="node-b" workspaceId="workspace-1" />);
    const badge = await screen.findByTestId("dependency-wait-node-b");
    expect(badge.textContent).toContain("Builder");
    await act(async () => {
      fireEvent.click(badge);
    });
    const cancel = await screen.findByRole("button", {
      name: "不等了，现在启动",
    });
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() => expect(core.cancelled).toEqual(["dep-1"]));
    await waitFor(() =>
      expect(screen.queryByTestId("dependency-wait-node-b")).toBeNull(),
    );
  });
});

describe("启动归谁", () => {
  it("还没读到答案是 unknown，core 说还在等是 held，其余是 free", async () => {
    expect(launchHold("workspace-1", "node-b")).toBe("unknown");
    core.launches = [launch()];
    await useDependencyStore.getState().refresh("workspace-1");
    expect(launchHold("workspace-1", "node-b")).toBe("held");
    expect(launchHold("workspace-1", "node-c")).toBe("free");
    expect(launchHold("workspace-2", "node-b")).toBe("unknown");
  });

  it("读不到就放行：core 启动前自己会看前台", async () => {
    core.fail = true;
    await useDependencyStore.getState().refresh("workspace-1");
    expect(launchHold("workspace-1", "node-b")).toBe("free");
  });

  it("旧 pendingLaunch 交给 core，然后从节点数据里摘掉", async () => {
    const updateNodeData = vi.fn();
    useCanvasStore.setState({
      document: {
        nodes: [
          {
            id: "node-b",
            data: {
              kind: "terminal",
              agent: {
                id: "claude",
                pendingLaunch: { command: "claude", after: ["node-a"] },
              },
            },
          },
        ],
      } as never,
      updateNodeData,
    } as never);
    const moved = await migrateLegacyLaunch("workspace-1", "node-b", {
      command: "claude",
      after: ["node-a"],
    });
    expect(moved).toBe(true);
    expect(core.imported).toEqual([{ nodeId: "node-b", after: ["node-a"] }]);
    expect(updateNodeData).toHaveBeenCalledWith(
      "node-b",
      { agent: { id: "claude" } },
      { history: "ignore" },
    );
  });
});

describe("rope 边由服务状态派生", () => {
  it("core 说在等的下游画虚线等待", () => {
    const node = (id: string) =>
      ({
        id,
        data: { kind: "terminal", agent: { id: "claude" } },
      }) as never;
    const edges = deriveEdges({
      nodes: [node("node-a"), node("node-b")],
      launchedAfter: {},
      cards: {},
      waitingOn: { "node-b": ["node-a"] },
    });
    expect(edges).toEqual([
      expect.objectContaining({
        source: "node-a",
        target: "node-b",
        variant: "rope",
        waiting: true,
      }),
    ]);
  });
});
