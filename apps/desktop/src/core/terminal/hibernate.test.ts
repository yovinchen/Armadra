import { describe, expect, it } from "vitest";

import {
  DEFAULT_ECO_IDLE_MINUTES,
  type HibernationFacts,
  TEST_ECO_IDLE_ENV,
  TEST_HIBERNATE_INTERVAL_MS,
  ecoPolicy,
  ecoTestOverride,
  hasBackgroundWork,
  hibernationBlockers,
  isShell,
  onlyWaitingForTime,
  programName,
} from "./hibernate";

/**
 * Eco 休眠的判据（终端宿主设计 §7.2），纯函数部分。
 *
 * 每一条「不该睡」都单独成一个用例：这张表错一格，代价是某个人回来发现自己
 * 正在等审批的会话没了，所以值得逐格钉死。
 */

const READY: HibernationFacts = {
  agentId: "claude",
  resumable: true,
  providerSessionId: "prov-1",
  remote: false,
  state: "idle",
  stateSource: "hook",
  attachedSockets: 0,
  inputPending: false,
  leaseFree: true,
  queued: false,
  foregroundIsAgent: true,
  backgroundProcess: false,
  scheduled: false,
  idleForMs: 31 * 60_000,
  thresholdMs: 30 * 60_000,
};

describe("hibernationBlockers", () => {
  it("判据全过就能睡", () => {
    expect(hibernationBlockers(READY)).toEqual([]);
    expect(hibernationBlockers({ ...READY, state: "done" })).toEqual([]);
    expect(hibernationBlockers({ ...READY, stateSource: "extension" })).toEqual(
      [],
    );
  });

  it.each([
    ["普通 shell", { agentId: null }, "notAgent"],
    ["不能续接的 CLI", { resumable: false }, "noResume"],
    [
      "没报过 provider 会话 id",
      { providerSessionId: undefined },
      "noProviderSession",
    ],
    ["SSH 会话", { remote: true }, "remote"],
    ["正在一轮里", { state: "working" }, "working"],
    ["停在权限提示上", { state: "blocked" }, "awaitingApproval"],
    ["停在提问上", { state: "waiting" }, "awaitingApproval"],
    ["从没报过状态", { state: undefined }, "unknownState"],
    ["只有 PTY 观测", { stateSource: "observed" }, "unknownState"],
    ["有人看着", { attachedSockets: 1 }, "attached"],
    ["半截输入", { inputPending: true }, "inputPending"],
    ["租约在别人手里", { leaseFree: false }, "leaseHeld"],
    ["队里有投递", { queued: true }, "deliveryQueued"],
    ["有计划要投给它", { scheduled: true }, "scheduled"],
    ["前台不是 Agent", { foregroundIsAgent: false }, "notAgentPane"],
    ["问不到前台", { foregroundIsAgent: undefined }, "notAgentPane"],
    ["有后台作业", { backgroundProcess: true }, "backgroundProcess"],
    ["没闲够", { idleForMs: 29 * 60_000 }, "recentlyActive"],
  ] as const)("%s 不睡", (_label, patch, blocker) => {
    expect(hibernationBlockers({ ...READY, ...patch })).toContain(blocker);
  });

  it("只差时间就是状态机里的 idle", () => {
    const waiting = hibernationBlockers({ ...READY, idleForMs: 0 });
    expect(onlyWaitingForTime(waiting)).toBe(true);
    expect(
      onlyWaitingForTime(
        hibernationBlockers({ ...READY, idleForMs: 0, attachedSockets: 1 }),
      ),
    ).toBe(false);
  });
});

describe("ecoPolicy", () => {
  it("缺省开着、30 分钟", () => {
    expect(ecoPolicy(() => undefined)).toEqual({
      enabled: true,
      idleMinutes: DEFAULT_ECO_IDLE_MINUTES,
    });
  });

  it("读设置里的两个键，越界的阈值退回默认", () => {
    const settings: Record<string, unknown> = {
      "terminal.ecoMode": false,
      "terminal.ecoIdleMinutes": 60,
    };
    expect(ecoPolicy((path) => settings[path])).toEqual({
      enabled: false,
      idleMinutes: 60,
    });
    settings["terminal.ecoIdleMinutes"] = 1;
    expect(ecoPolicy((path) => settings[path]).idleMinutes).toBe(
      DEFAULT_ECO_IDLE_MINUTES,
    );
  });
});

describe("ecoTestOverride", () => {
  it("只认 1–600 的整数秒，给出分钟阈值与两秒一轮的巡检", () => {
    expect(ecoTestOverride({ [TEST_ECO_IDLE_ENV]: "30" })).toEqual({
      idleMinutes: 0.5,
      intervalMs: TEST_HIBERNATE_INTERVAL_MS,
    });
    expect(ecoTestOverride({})).toBeUndefined();
    for (const bad of ["0", "601", "1.5", "-3", "abc", ""]) {
      expect(ecoTestOverride({ [TEST_ECO_IDLE_ENV]: bad })).toBeUndefined();
    }
  });
});

describe("后台作业", () => {
  it("认得出 shell，包括登录 shell 的写法", () => {
    expect(isShell("/bin/zsh -c 'npm run dev'")).toBe(true);
    expect(isShell("-zsh")).toBe(true);
    expect(isShell("node /opt/mcp/server.js")).toBe(false);
    expect(programName("/usr/local/bin/claude --resume x")).toBe("claude");
  });

  it("shell 下面不止 Agent，或 Agent 下面挂着 shell，都算有后台作业", () => {
    expect(hasBackgroundWork(["claude"], ["node mcp.js"])).toBe(false);
    expect(hasBackgroundWork(["claude", "npm run dev"], [])).toBe(true);
    expect(
      hasBackgroundWork(["claude"], ["/bin/zsh -c 'vite'", "node vite"]),
    ).toBe(true);
  });
});
