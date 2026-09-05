import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create } from "@armadra/protocol";
import {
  AutomationPlanSnapshotSchema,
  AutomationRunSnapshotSchema,
} from "@armadra/protocol";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  panels: { automation: "drawer" as "drawer" | "closed" },
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  document: { nodes: [] as CanvasNode[] },
  setPanel: vi.fn(),
  addNode: vi.fn(),
  removeNodes: vi.fn(),
}));

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  connect: vi.fn(async () => {}),
  reset: vi.fn(),
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

vi.mock("../viewport", () => ({
  currentViewportCenter: () => ({ x: 0, y: 0 }),
}));

import { AutomationDrawer, failureKey } from "./AutomationDrawer";
import { HostAutomationError } from "@armadra/host-client";
import { useAutomationFocus } from "./open";

const digest = new Uint8Array(32).fill(3);

function planSnapshot(overrides: Record<string, unknown> = {}) {
  return create(AutomationPlanSnapshotSchema, {
    plan: {
      id: "plan-1",
      configVersion: 2n,
      state: 2,
      nextDueUnixMs: 1_788_557_900_000n,
      config: {
        workspaceId: "workspace-1",
        title: "每晚构建",
        target: { executionHostId: "a".repeat(32), sessionId: "session-1" },
        schedule: {
          kind: {
            case: "cron",
            value: { expression: "0 3 * * *", timezone: "Asia/Shanghai" },
          },
        },
      },
      ...overrides,
    },
    revision: 5n,
    configSha256: digest,
  });
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    listPlans: vi.fn(async () => ({
      plans: [planSnapshot()],
      nextId: "",
      hasMore: false,
    })),
    listRuns: vi.fn(async () => ({ runs: [], nextId: "", hasMore: false })),
    listCommandSessions: vi.fn(async () => ({
      sessions: [],
      nextId: "",
      hasMore: false,
    })),
    activatePlan: vi.fn(async () => planSnapshot()),
    pausePlan: vi.fn(async () => planSnapshot({ state: 3 })),
    runNow: vi.fn(async () =>
      create(AutomationRunSnapshotSchema, {
        run: { id: "run-1", planId: "plan-1", workspaceId: "workspace-1" },
        revision: 1n,
      }),
    ),
    definePlan: vi.fn(async () => planSnapshot()),
    defineCommandSession: vi.fn(async () => ({ sessionId: "session-1" })),
    ...overrides,
  };
}

function ready(api: ReturnType<typeof client>, canManage = true) {
  session.state = {
    status: "ready",
    client: api,
    canManage,
    session: { scopes: [] },
    hello: { hostId: "a".repeat(32) },
  };
}

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AutomationDrawer />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  store.panels.automation = "drawer";
  store.document.nodes = [];
  store.setPanel.mockClear();
  store.addNode.mockClear();
  store.removeNodes.mockClear();
  session.connect.mockClear();
  session.state = { status: "idle" };
  useAutomationFocus.getState().focus(null);
});
afterEach(cleanup);

describe("automation page availability", () => {
  it("names why the page cannot be used and offers the settings entry", async () => {
    session.state = { status: "blocked", reason: "signedOut" };
    renderDrawer();
    expect(await screen.findByText("这台设备还没有与 Host 配对")).toBeTruthy();
    // No pretend actions while the Host is unusable.
    expect(screen.queryByText("新建计划")).toBeNull();
    expect(screen.queryByText("启用")).toBeNull();
    fireEvent.click(screen.getByText("前往设置 → 连接"));
    expect(store.setPanel).toHaveBeenCalledWith("settings", true);
  });

  it("says a Host without a Worker cannot run plans", async () => {
    session.state = { status: "blocked", reason: "unsupported" };
    renderDrawer();
    expect(
      await screen.findByText("这个 Host 没有执行 Worker，无法运行计划"),
    ).toBeTruthy();
  });

  it("hides the management actions from a read-only device", async () => {
    ready(client(), false);
    renderDrawer();
    expect(await screen.findByText("每晚构建")).toBeTruthy();
    expect(screen.queryByText("暂停")).toBeNull();
    expect(screen.queryByText("立即运行")).toBeNull();
    expect(screen.getAllByText(/只读权限/).length).toBeGreaterThan(0);
  });
});

describe("plan actions", () => {
  it("lists a workspace's plans with their state and schedule", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    expect(await screen.findByText("每晚构建")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText("Cron")).toBeTruthy();
    expect(api.listPlans).toHaveBeenCalled();
  });

  it("requires confirmation and shows the bound digest before activating", async () => {
    const api = client({
      listPlans: vi.fn(async () => ({
        plans: [planSnapshot({ state: 1 })],
        nextId: "",
        hasMore: false,
      })),
    });
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("启用"));
    expect(await screen.findByText("启用这个计划？")).toBeTruthy();
    // The exact revision, version and digest the user is looking at.
    expect(screen.getByText("03".repeat(32))).toBeTruthy();
    expect(api.activatePlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText("启用").at(-1)!);
    await waitFor(() =>
      expect(api.activatePlan).toHaveBeenCalledWith({
        planId: "plan-1",
        expectedRevision: 5n,
        configVersion: 2n,
        configSha256: digest,
      }),
    );
  });

  it("requires confirmation before queueing a manual run", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("立即运行"));
    expect(await screen.findByText("立即运行？")).toBeTruthy();
    expect(api.runNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText("立即运行").at(-1)!);
    await waitFor(() =>
      expect(api.runNow).toHaveBeenCalledWith({
        planId: "plan-1",
        expectedRevision: 5n,
      }),
    );
  });

  it("pauses against the exact revision it displayed", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("暂停"));
    await waitFor(() =>
      expect(api.pausePlan).toHaveBeenCalledWith({
        planId: "plan-1",
        expectedRevision: 5n,
      }),
    );
  });

  it("flags a plan the Host says needs attention without changing its state", async () => {
    const api = client({
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
    ready(api);
    renderDrawer();
    expect(await screen.findByText("需处理")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText(/TARGET_UNSUPPORTED/)).toBeTruthy();
  });
});

describe("card removal", () => {
  const card = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "automation",
    data: {
      kind: "automation",
      planId: "plan-1",
      planWorkspaceId: "workspace-1",
      executionHostId: "a".repeat(32),
    },
  } as unknown as CanvasNode;

  it("keeps removing the card and pausing the plan as two separate actions", async () => {
    store.document.nodes = [card];
    const api = client();
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("移除展示，保留计划"));
    expect(store.removeNodes).toHaveBeenCalledWith([card.id]);
    expect(api.pausePlan).not.toHaveBeenCalled();

    store.removeNodes.mockClear();
    fireEvent.click(screen.getByText("停用并移除"));
    await waitFor(() => expect(api.pausePlan).toHaveBeenCalled());
    await waitFor(() =>
      expect(store.removeNodes).toHaveBeenCalledWith([card.id]),
    );
  });

  it("offers a card only for a plan that has none on this board", async () => {
    ready(client());
    renderDrawer();
    fireEvent.click(await screen.findByText("在画布上显示"));
    expect(store.addNode).toHaveBeenCalledWith(
      "automation",
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "automation",
          planId: "plan-1",
          scheduleKind: "cron",
          timezone: "Asia/Shanghai",
        }),
      }),
    );
  });
});

describe("failure messages", () => {
  it("maps each failure onto the repair the user has to make", () => {
    expect(failureKey(new HostAutomationError("conflict"))).toBe(
      "automation.error.conflict",
    );
    expect(failureKey(new HostAutomationError("permission"))).toBe(
      "automation.error.permission",
    );
    expect(failureKey(new Error("boom"))).toBe("automation.error.network");
  });

  it("never tells the user to just retry a mutation with an unknown result", () => {
    expect(failureKey(new HostAutomationError("network", true))).toBe(
      "automation.error.unknownOutcome",
    );
  });
});
