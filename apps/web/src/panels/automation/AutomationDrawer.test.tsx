import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanvasNode } from "@armadra/shared";
import {
  AutomationApiError,
  AutomationPlanState,
  AutomationRunState,
  automationPlan,
  automationPlanConfig,
  automationPlanSnapshot,
  automationRun,
  automationRunSnapshot,
  automationTarget,
} from "../../api/automations";

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

vi.mock("@/canvas/placement", () => ({
  nodeDropPosition: () => ({ x: 0, y: 0 }),
}));

// 时区下拉在关着时也会把全部选项渲染进一个片段（给 SelectValue 取文字），
// 真实列表四百多项，编辑表单每渲染一次都要走一遍——整套并行跑时这几条用例
// 因此超过默认预算。这里只关心计划原有的时区被原样带回，留几项就够。
vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  timezoneOptions: () => ["UTC", "Asia/Shanghai", "America/New_York"],
}));

import { AutomationDrawer, failureKey } from "./AutomationDrawer";
import { useAutomationFocus } from "./open";

const digest = new Uint8Array(32).fill(3);

function planSnapshot(overrides: Record<string, unknown> = {}) {
  return automationPlanSnapshot({
    plan: automationPlan({
      id: "plan-1",
      configVersion: 2n,
      state: AutomationPlanState.ACTIVE,
      nextDueUnixMs: 1_788_557_900_000n,
      config: automationPlanConfig({
        workspaceId: "workspace-1",
        title: "每晚构建",
        target: automationTarget({
          executionHostId: "a".repeat(32),
          sessionId: "session-1",
        }),
        schedule: {
          kind: {
            case: "cron",
            value: { expression: "0 3 * * *", timezone: "Asia/Shanghai" },
          },
        },
      }),
      ...overrides,
    }),
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
    pausePlan: vi.fn(async () =>
      planSnapshot({ state: AutomationPlanState.PAUSED }),
    ),
    runNow: vi.fn(async () =>
      automationRunSnapshot({
        run: automationRun({
          id: "run-1",
          planId: "plan-1",
          workspaceId: "workspace-1",
        }),
        revision: 1n,
      }),
    ),
    definePlan: vi.fn(async () => planSnapshot()),
    defineCommandSession: vi.fn(async () => ({ sessionId: "session-1" })),
    planPayload: vi.fn(async () => "每晚构建一次"),
    ...overrides,
  };
}

/** One run snapshot, so a paged history has something distinguishable in it. */
function runSnapshot(id: string, scheduledAt: bigint) {
  return automationRunSnapshot({
    run: automationRun({
      id,
      planId: "plan-1",
      workspaceId: "workspace-1",
      scheduledAtUnixMs: scheduledAt,
      state: AutomationRunState.SUCCEEDED,
    }),
    revision: 1n,
  });
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
  useAutomationFocus.setState({
    planId: null,
    reveal: 0,
    prefill: null,
    editingPlanId: null,
    compose: 0,
  });
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

describe("run history navigation", () => {
  it("keeps a freshly created plan on the plan list", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    await screen.findByText("每晚构建");
    // Creating selects the plan; it must not navigate away from the list.
    useAutomationFocus.getState().focus("plan-1");
    await waitFor(() => expect(screen.getByText("暂停")).toBeTruthy());
  });

  it("navigates when a card explicitly asks to see the runs", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("查看运行历史"));
    await waitFor(() =>
      expect(screen.getByText("这个计划还没有运行记录")).toBeTruthy(),
    );
  });

  it("asks the Host for the next page instead of pulling the whole history", async () => {
    const api = client({
      listRuns: vi.fn(async (_plan: string, cursor: string) =>
        cursor === ""
          ? {
              runs: [runSnapshot("run-new", 3_000n)],
              nextId: "cursor-1",
              hasMore: true,
            }
          : {
              runs: [runSnapshot("run-old", 1_000n)],
              nextId: "",
              hasMore: false,
            },
      ),
    });
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("查看运行历史"));
    // Only the first page is requested until somebody asks for more.
    await waitFor(() =>
      expect(document.querySelector('[data-run-id="run-new"]')).toBeTruthy(),
    );
    expect(api.listRuns).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-run-id="run-old"]')).toBeNull();

    fireEvent.click(screen.getByText("加载更早的记录"));
    await waitFor(() =>
      expect(document.querySelector('[data-run-id="run-old"]')).toBeTruthy(),
    );
    // The second call carries the cursor the Host issued, not a page number
    // this panel invented.
    expect(api.listRuns).toHaveBeenLastCalledWith(
      "plan-1",
      "cursor-1",
      expect.any(Number),
    );
    // Nothing more to fetch, so the affordance goes away.
    expect(screen.queryByText("加载更早的记录")).toBeNull();
  });
});

describe("editing a plan", () => {
  it("saves a new version at the revision on screen and says it is a draft again", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("编辑"));
    // The stored prompt is read back: saving an empty payload would blank it.
    const prompt = (await screen.findByDisplayValue(
      "每晚构建一次",
    )) as HTMLTextAreaElement;
    expect(api.planPayload).toHaveBeenCalledWith("plan-1");
    fireEvent.change(prompt, { target: { value: "换一句提示词" } });
    fireEvent.click(screen.getByText("保存新版本"));
    await waitFor(() => expect(api.definePlan).toHaveBeenCalled());
    const request = (
      api.definePlan.mock.calls.at(-1) as unknown as [
        {
          planId: string;
          config: { schedule?: { kind?: { case?: string } }; title: string };
          payload: Uint8Array;
          expectedRevision: bigint;
        },
      ]
    )[0];
    expect(request.planId).toBe("plan-1");
    // The exact revision the row displayed, so a save that raced another
    // device is refused rather than overwriting it.
    expect(request.expectedRevision).toBe(5n);
    // 载荷在线上就是原文（R7a）。
    expect(request.payload).toBe("换一句提示词");
    // The schedule the plan already had is re-sent, not a fresh default.
    expect(request.config.schedule?.kind?.case).toBe("cron");
    expect(request.config.title).toBe("每晚构建");
    // Back on the list afterwards, and the plan is no longer being edited.
    await waitFor(() => expect(screen.getByText("每晚构建")).toBeTruthy());
    expect(useAutomationFocus.getState().editingPlanId).toBeNull();
  });

  it("cannot be saved before the stored prompt has been read", async () => {
    let resolvePayload: ((value: Uint8Array) => void) | null = null;
    const api = client({
      planPayload: vi.fn(
        () =>
          new Promise<Uint8Array>((resolve) => {
            resolvePayload = resolve;
          }),
      ),
    });
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("编辑"));
    const submit = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-slot="automation-submit"]',
      );
      if (!button) throw new Error("no submit button yet");
      return button;
    });
    expect(submit.disabled).toBe(true);
    resolvePayload!(new TextEncoder().encode("已存的提示词"));
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it("shows the frozen target read-only rather than re-picking one", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    fireEvent.click(await screen.findByText("编辑"));
    expect(
      await screen.findByText(/目标沿用这份计划冻结下来的那一个/),
    ).toBeTruthy();
    // The target pickers are gone: repointing a plan is a different decision.
    expect(screen.queryByText("已有的命令会话")).toBeNull();
  });
});

describe("failure messages", () => {
  it("maps each failure onto the repair the user has to make", () => {
    expect(failureKey(new AutomationApiError("conflict"))).toBe(
      "automation.error.conflict",
    );
    expect(failureKey(new AutomationApiError("permission"))).toBe(
      "automation.error.permission",
    );
    expect(failureKey(new Error("boom"))).toBe("automation.error.network");
  });

  it("never tells the user to just retry a mutation with an unknown result", () => {
    expect(failureKey(new AutomationApiError("network", true))).toBe(
      "automation.error.unknownOutcome",
    );
  });
});
