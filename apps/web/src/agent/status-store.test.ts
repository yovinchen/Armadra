import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, SessionSummary } from "@ai-coding-canvas/shared";

import {
  APPROVAL_TTL_MS,
  DONE_HOLDOFF_MS,
  agentHeaderState,
  countStatuses,
  isFreshDone,
  isResolvedApproval,
  useAgentStatusStore,
} from "./status-store";

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";
const BASE = Date.parse("2026-09-04T10:00:00.000Z");

function status(
  partial: Partial<AgentStatus> & { updatedAt: string },
): AgentStatus {
  return {
    nodeId: NODE,
    workspaceId: WORKSPACE,
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    ...partial,
  };
}

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

const store = () => useAgentStatusStore.getState();

/** 已读回执是 fire-and-forget 的 POST；测试里换成一个可断言的假 fetch。 */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAgentStatusStore.getState().reset();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("agent status mirror", () => {
  it("holds `done` for 3s against a late `working`", () => {
    store().upsert(status({ state: "done", updatedAt: at(0) }), {
      now: BASE,
      selected: true,
      focused: true,
    });
    store().upsert(status({ state: "working", updatedAt: at(500) }), {
      now: BASE + 500,
    });
    expect(store().statuses[NODE]!.state).toBe("done");

    store().upsert(
      status({ state: "working", updatedAt: at(DONE_HOLDOFF_MS + 10) }),
      { now: BASE + DONE_HOLDOFF_MS + 10 },
    );
    expect(store().statuses[NODE]!.state).toBe("working");
  });

  it("carries the runtime's unread badge when the node is not being watched", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: true,
      remote: false,
    });
    expect(store().statuses[NODE]!.unread).toBe(true);

    store().markRead(NODE, { remote: false });
    expect(store().statuses[NODE]!.unread).toBe(false);
  });

  it("counts a turn that ends under the user's eyes as read, and says so", async () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: true,
      focused: true,
    });
    expect(store().statuses[NODE]!.unread).toBe(false);
    // 只有客户端知道用户在看，所以回执必须由客户端补，否则刷新后徽标回来。
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain(
      `/api/agent-status/${NODE}/read`,
    );
  });

  it("keeps the badge when the window is blurred even if the node is selected", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: true,
      focused: false,
      remote: false,
    });
    expect(store().statuses[NODE]!.unread).toBe(true);
  });

  /**
   * §5.4/§5.7：未读只由已读回执清除。新回合不算「看过」——§5.7 的投递就是
   * 靠开新回合，用户可能压根没看上一回合的结果；而且 `GET /sessions` 直接
   * 读 SQLite 的 `unread`，本地擅自清掉只会让刷新一次徽标又冒出来。
   */
  it("does not clear the badge just because a new turn started", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: false,
      remote: false,
    });
    store().upsert(
      status({
        state: "working",
        unread: true,
        updatedAt: at(DONE_HOLDOFF_MS + 1),
      }),
      { now: BASE + DONE_HOLDOFF_MS + 1, remote: false },
    );
    expect(store().statuses[NODE]!.unread).toBe(true);
    expect(store().statuses[NODE]!.state).toBe("working");
  });

  it("ignores frames older than the one already stored", () => {
    store().upsert(status({ state: "working", updatedAt: at(1_000) }), {
      now: BASE + 1_000,
    });
    store().upsert(status({ state: "blocked", updatedAt: at(500) }), {
      now: BASE + 1_000,
    });
    expect(store().statuses[NODE]!.state).toBe("working");
  });

  it("attaches a pendingId from an approval event", () => {
    store().upsert(status({ state: "blocked", updatedAt: at(0) }), {
      now: BASE,
    });
    store().handleEvent({
      type: "agent.approval",
      nodeId: NODE,
      pendingId: "pending-1",
      request: {},
    });
    expect(store().statuses[NODE]!.pendingId).toBe("pending-1");
  });

  it("drops the mirror when the terminal exits", () => {
    store().upsert(status({ state: "working", updatedAt: at(0) }), {
      now: BASE,
    });
    store().handleEvent({
      type: "terminal.exit",
      sessionId: "s1",
      nodeId: NODE,
      exitCode: 0,
    });
    expect(NODE in store().statuses).toBe(false);
  });

  it("hydrates from the sessions payload without clobbering fresher state", () => {
    const session: SessionSummary = {
      nodeId: NODE,
      boardId: "board",
      sessionId: "s1",
      kind: "terminal",
      title: "claude",
      cwd: "/repo",
      agentId: "claude",
      state: "done",
      unread: true,
      updatedAt: at(0),
      alive: true,
    };
    store().hydrate([session], WORKSPACE);
    expect(store().statuses[NODE]!.state).toBe("done");
    expect(store().statuses[NODE]!.unread).toBe(true);
    expect(store().statuses[NODE]!.restored).toBe(true);

    store().upsert(status({ state: "working", updatedAt: at(10_000) }), {
      now: BASE + 10_000,
    });
    store().hydrate([session], WORKSPACE);
    expect(store().statuses[NODE]!.state).toBe("working");
  });

  it("skips sessions without an agent", () => {
    store().hydrate(
      [
        {
          nodeId: NODE,
          boardId: "board",
          sessionId: "s1",
          kind: "terminal",
          title: "zsh",
          cwd: "/repo",
          unread: false,
          updatedAt: at(0),
          alive: true,
        },
      ],
      WORKSPACE,
    );
    expect(NODE in store().statuses).toBe(false);
  });

  it("counts the three sidebar signals per workspace", () => {
    const counts = countStatuses(
      {
        a: status({ nodeId: "a", state: "blocked", updatedAt: at(0) }),
        b: status({
          nodeId: "b",
          state: "done",
          unread: true,
          updatedAt: at(0),
        }),
        c: status({ nodeId: "c", state: "working", updatedAt: at(0) }),
        d: status({ nodeId: "d", state: "done", updatedAt: at(0) }),
        e: status({
          nodeId: "e",
          workspaceId: "other",
          state: "working",
          updatedAt: at(0),
        }),
      },
      WORKSPACE,
    );
    expect(counts).toEqual({ attention: 1, unread: 1, working: 1 });
  });
  it("posts a read receipt when the unread badge is cleared", async () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: false,
      remote: false,
    });
    store().markRead(NODE);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/agent-status/${NODE}/read`);
    expect(init.method).toBe("POST");

    // 已经读过了就不再发第二次回执。
    store().markRead(NODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the receipt when asked to stay local", () => {
    store().upsert(status({ state: "done", unread: true, updatedAt: at(0) }), {
      now: BASE,
      selected: false,
      focused: false,
      remote: false,
    });
    store().markRead(NODE, { remote: false });
    expect(store().statuses[NODE]!.unread).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the pendingId when the approval comes back resolved", () => {
    store().upsert(
      status({ state: "blocked", pendingId: "p1", updatedAt: at(0) }),
      { now: BASE },
    );
    store().handleEvent({
      type: "agent.approval",
      nodeId: NODE,
      pendingId: "p1",
      request: { id: "p1", answer: "allow", answeredAt: at(1) },
    });
    expect(store().statuses[NODE]!.pendingId).toBeUndefined();
    // 状态本身不动：下一条 `agent.status` 才有权改它。
    expect(store().statuses[NODE]!.state).toBe("blocked");
  });

  it("recognises both resolved shapes", () => {
    expect(isResolvedApproval({ resolved: true })).toBe(true);
    expect(isResolvedApproval({ answer: "deny" })).toBe(true);
    expect(isResolvedApproval({ answeredAt: at(0) })).toBe(true);
    expect(isResolvedApproval({ answer: null })).toBe(false);
    expect(isResolvedApproval(undefined)).toBe(false);
  });

  it("expires a pending approval after five minutes", () => {
    store().upsert(status({ state: "blocked", updatedAt: at(0) }), {
      now: BASE,
    });
    store().handleEvent(
      {
        type: "agent.approval",
        nodeId: NODE,
        pendingId: "p1",
        request: {},
      },
      { now: BASE },
    );
    store().sweepApprovals(BASE + APPROVAL_TTL_MS - 1);
    expect(store().statuses[NODE]!.pendingId).toBe("p1");

    store().sweepApprovals(BASE + APPROVAL_TTL_MS);
    expect(store().statuses[NODE]!.pendingId).toBeUndefined();
  });

  it("maps states to the pill and the glow", () => {
    expect(agentHeaderState(undefined)).toEqual({});
    expect(
      agentHeaderState(status({ state: "working", updatedAt: at(0) })),
    ).toEqual({
      pill: { tone: "working", labelKey: "agent.state.working" },
      glow: "working",
    });
    expect(
      agentHeaderState(status({ state: "waiting", updatedAt: at(0) })),
    ).toEqual({
      pill: { tone: "attention", labelKey: "agent.state.waiting" },
      glow: "attention",
    });
    expect(
      agentHeaderState(
        status({ state: "done", unread: true, updatedAt: at(0) }),
      ),
    ).toEqual({
      pill: { tone: "unread", labelKey: "agent.state.done" },
      glow: "unread",
    });
    // 读过的 done 不出胶囊，空闲节点头部保持干净（§14）。
    expect(
      agentHeaderState(status({ state: "done", updatedAt: at(0) })),
    ).toEqual({});
  });

  it("shows nothing for a restored `done`", () => {
    expect(
      agentHeaderState(
        status({
          state: "done",
          unread: true,
          restored: true,
          updatedAt: at(0),
        }),
      ),
    ).toEqual({});
  });

  /**
   * 合成收尾（20 分钟无回报 / 终端被杀）只是「让节点别再声称 RUNNING」。
   * Runtime 给它的判决是 `false` 且不置未读，所以它自己就落到「无胶囊」，
   * 显示侧不必特判；`isFreshDone` 仍要拦住它，免得弹「已完成」。
   */
  it("puts no pill on a synthetic close, and never calls it a fresh done", () => {
    for (const lastMessage of [
      "stale=true no hook report for 20 minutes",
      "terminated=true the terminal exited before the turn ended",
    ]) {
      const closed = {
        ...status({ state: "done", updatedAt: at(0) }),
        errored: false,
        interrupted: false,
        lastMessage,
      };
      expect(agentHeaderState(closed)).toEqual({});
      expect(isFreshDone(closed)).toBe(false);
    }
  });

  /**
   * Runtime 特意不让合成收尾清掉已有的未读：更早那个回合的输出仍然没人看过。
   * 终端死了不代表之前那次的结果不用看，所以 DONE 胶囊照出。
   */
  it("keeps an older turn's unread badge visible through a synthetic close", () => {
    expect(
      agentHeaderState({
        ...status({ state: "done", unread: true, updatedAt: at(0) }),
        errored: false,
        interrupted: false,
        lastMessage:
          "terminated=true the terminal exited before the turn ended",
      }),
    ).toEqual({
      pill: { tone: "unread", labelKey: "agent.state.done" },
      glow: "unread",
    });
  });

  it("does not resurrect a mirror the terminal exit already dropped", () => {
    store().upsert(status({ state: "working", updatedAt: at(0) }), {
      now: BASE,
      remote: false,
    });
    store().handleEvent({
      type: "terminal.exit",
      sessionId: "s1",
      nodeId: NODE,
      exitCode: 137,
    });
    expect(NODE in store().statuses).toBe(false);

    // 60s 后巡检补出来的合成收尾：终端早没了，镜像不该被它重新变出来。
    store().upsert(
      {
        ...status({ state: "done", updatedAt: at(60_000) }),
        errored: false,
        interrupted: false,
        lastMessage:
          "terminated=true the terminal exited before the turn ended",
      },
      { now: BASE + 60_000, remote: false },
    );
    expect(NODE in store().statuses).toBe(false);
  });

  it("shows TURN FAILED and PAUSED when the runtime reports them", () => {
    expect(
      agentHeaderState({
        ...status({ state: "done", unread: true, updatedAt: at(0) }),
        errored: true,
      }),
    ).toEqual({
      pill: { tone: "failed", labelKey: "agent.state.errored" },
      glow: "unread",
    });
    expect(
      agentHeaderState({
        ...status({ state: "done", updatedAt: at(0) }),
        interrupted: true,
      }),
    ).toEqual({
      pill: { tone: "paused", labelKey: "agent.state.interrupted" },
    });
  });
});
