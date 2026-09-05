import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create } from "@armadra/protocol";
import { AutomationPlanSnapshotSchema } from "@armadra/protocol";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  panels: { automation: "closed" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(),
  setPanel: vi.fn(),
}));

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  connect: vi.fn(async () => {}),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("@/host/automation-session", () => {
  const useAutomationSession = <T,>(selector: (state: typeof session) => T) =>
    selector(session);
  useAutomationSession.getState = () => session;
  return { useAutomationSession };
});

import { AutomationNode } from "./AutomationNode";

const node = {
  id: "22222222-2222-4222-8222-222222222222",
  boardId: "b1",
  type: "automation",
  title: "每晚构建",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  size: { width: 360, height: 260 },
  labels: [],
  note: "",
  data: {
    kind: "automation",
    planId: "plan-1",
    planWorkspaceId: "workspace-1",
    executionHostId: "a".repeat(32),
    scheduleKind: "cron",
    timezone: "Asia/Shanghai",
  },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
} as unknown as CanvasNode;

function planSnapshot(overrides: Record<string, unknown> = {}) {
  return create(AutomationPlanSnapshotSchema, {
    plan: {
      id: "plan-1",
      configVersion: 2n,
      state: 2,
      nextDueUnixMs: 1_788_557_900_000n,
      config: { workspaceId: "workspace-1", title: "每晚构建" },
      ...overrides,
    },
    revision: 5n,
    configSha256: new Uint8Array(32).fill(3),
  });
}

function ready(overrides: Record<string, unknown> = {}) {
  session.state = {
    status: "ready",
    canManage: true,
    hello: { hostId: "a".repeat(32) },
    session: { scopes: [] },
    client: {
      listPlans: vi.fn(async () => ({
        plans: [planSnapshot()],
        nextId: "",
        hasMore: false,
      })),
      listRuns: vi.fn(async () => ({ runs: [], nextId: "", hasMore: false })),
      ...overrides,
    },
  };
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AutomationNode
        id={node.id}
        node={node}
        selected={false}
        collapsed={false}
        focused={false}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  session.state = { status: "idle" };
  session.connect.mockClear();
});
afterEach(cleanup);

describe("automation card", () => {
  it("reads the plan from the Host rather than from the board", async () => {
    ready();
    renderCard();
    expect(await screen.findByText("已启用")).toBeTruthy();
    expect(screen.getByText("Cron")).toBeTruthy();
    expect(screen.getByText("Asia/Shanghai")).toBeTruthy();
  });

  it("says the Host is unreachable instead of drawing an empty plan", async () => {
    session.state = { status: "blocked", reason: "disconnected" };
    renderCard();
    expect(await screen.findByText("连不上 Host")).toBeTruthy();
    expect(screen.queryByText("已启用")).toBeNull();
  });

  it("reports a plan the Host no longer has", async () => {
    ready({
      listPlans: vi.fn(async () => ({ plans: [], nextId: "", hasMore: false })),
    });
    renderCard();
    expect(await screen.findByText("计划或会话不存在")).toBeTruthy();
  });

  it("never draws delivered input as a finished run", async () => {
    ready({
      listRuns: vi.fn(async () => ({
        runs: [
          {
            run: {
              id: "run-1",
              planId: "plan-1",
              workspaceId: "workspace-1",
              state: 5,
              dispatchAttempts: 1,
              receiptSequence: 1n,
              scheduledAtUnixMs: 1n,
              createdAtUnixMs: 1n,
              completedAtUnixMs: 0n,
              deliveryObserved: true,
              misfire: false,
              reasonCode: "",
            },
            revision: 1n,
          },
        ],
        nextId: "",
        hasMore: false,
      })),
    });
    renderCard();
    expect(await screen.findAllByText("已投递")).toHaveLength(2);
    expect(screen.queryByText("已成功")).toBeNull();
  });

  it("surfaces the Host's needs-attention marker", async () => {
    ready({
      listPlans: vi.fn(async () => ({
        plans: [
          planSnapshot({
            needsAttention: true,
            attentionReasonCode: "TARGET_UNSUPPORTED",
          }),
        ],
        nextId: "",
        hasMore: false,
      })),
    });
    renderCard();
    expect(await screen.findByText("需处理")).toBeTruthy();
  });

  it("opens a session for the plan's own workspace, not the local board", async () => {
    renderCard();
    expect(session.connect).toHaveBeenCalledWith("workspace-1");
  });
});
