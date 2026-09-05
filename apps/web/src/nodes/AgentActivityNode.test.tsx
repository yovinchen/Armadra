import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const terminal = {
  id: "33333333-3333-4333-8333-333333333333",
  boardId: "b1",
  type: "terminal",
  title: "Claude",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  labels: [],
  note: "",
  data: { kind: "terminal" },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
} as unknown as CanvasNode;

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(),
}));

const agent = vi.hoisted(() => ({
  status: undefined as Record<string, unknown> | undefined,
  cards: [] as Record<string, unknown>[],
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});
vi.mock("@/agent/status-store", () => ({
  useAgentStatus: () => agent.status,
}));
vi.mock("@/agent/subagent-store", () => ({
  useSubagentCards: () => agent.cards,
}));
const propose = vi.hoisted(() => vi.fn());
vi.mock("@/panels/automation/open", () => ({
  proposePlanFromNative: propose,
}));

import { AgentActivityNode } from "./AgentActivityNode";

const node = {
  id: "44444444-4444-4444-8444-444444444444",
  boardId: "b1",
  type: "agentActivity",
  title: "Claude",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  labels: [],
  note: "",
  data: {
    kind: "agentActivity",
    sourceNodeId: terminal.id,
    source: "loop",
    sessionId: "session-1",
    executionHostId: "",
    generation: 4,
    nativeJobId: "job-1",
  },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
} as unknown as CanvasNode;

function renderCard(override: CanvasNode = node) {
  return render(
    <AgentActivityNode
      id={override.id}
      node={override}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );
}

beforeEach(() => {
  store.document.nodes = [terminal];
  agent.status = undefined;
  agent.cards = [];
});
afterEach(cleanup);

describe("agent activity card", () => {
  it("observes a real node and says it is read-only", () => {
    renderCard();
    // 卡片标题与被观察节点标题同名，两处都出现。
    expect(screen.getAllByText("Claude").length).toBeGreaterThan(1);
    expect(screen.getByText("只读观察")).toBeTruthy();
    expect(screen.getByText("CLI 循环")).toBeTruthy();
  });

  it("reports zero observations rather than inventing a loop", () => {
    renderCard();
    expect(screen.getByText("已观察 0 次")).toBeTruthy();
    expect(screen.getByText("还没有观察到活动")).toBeTruthy();
  });

  it("shows the latest observation from the existing hook stream", () => {
    agent.cards = [
      {
        id: "card-1",
        parentId: terminal.id,
        taskLabel: "评审改动",
        startedAt: Date.parse("2026-09-05T12:00:00Z"),
        state: "done",
      },
    ];
    renderCard();
    expect(screen.getByText("已观察 1 次")).toBeTruthy();
    expect(screen.getByText("评审改动")).toBeTruthy();
  });

  it("says so when the observed node has left the canvas", () => {
    store.document.nodes = [];
    renderCard();
    expect(screen.getByText("被观察的节点已不在这块画布上")).toBeTruthy();
    expect(screen.queryByText("只读观察")).toBeNull();
  });

  it("offers no pause or cancel — hiding it never stops the CLI's loop", () => {
    renderCard();
    expect(
      screen.getByText("隐藏这张卡片不会取消 CLI 自己的循环"),
    ).toBeTruthy();
    for (const label of ["暂停", "立即运行", "启用"])
      expect(screen.queryByText(label)).toBeNull();
  });

  it("proposes a platform plan without creating or activating one", () => {
    store.document.nodes = [
      {
        ...terminal,
        data: {
          kind: "terminal",
          sessionId: "01a072aa-0000-7000-8000-000000000001",
          agent: { id: "claude" },
        },
      } as unknown as CanvasNode,
    ];
    renderCard();
    const button = screen.getByRole("button", { name: "转为平台计划" });
    fireEvent.click(button);
    // A draft the person still confirms: nothing is created here, and the
    // native card and its CLI loop are untouched.
    expect(propose).toHaveBeenCalledWith({
      targetKind: "agent",
      nodeId: terminal.id,
      title: "Claude",
      origin: "native",
    });
    expect(store.addNode).not.toHaveBeenCalled();
    expect(store.removeNodes).not.toHaveBeenCalled();
  });

  it("says so rather than offering a plan with nothing to target", () => {
    // The observed node has no Agent session, so no plan could name a target.
    renderCard();
    const button = screen.getByRole("button", { name: "转为平台计划" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("被观察的节点上没有可作为目标的 Agent 会话"),
    ).toBeTruthy();
  });

  it("shows the job identity it was given and hides what it was not", () => {
    renderCard();
    expect(screen.getByText("session-1")).toBeTruthy();
    expect(screen.getByText("job-1")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    cleanup();
    renderCard({
      ...node,
      data: { kind: "agentActivity", sourceNodeId: terminal.id },
    } as unknown as CanvasNode);
    expect(screen.queryByText("会话")).toBeNull();
    expect(screen.queryByText("代次")).toBeNull();
  });
});
