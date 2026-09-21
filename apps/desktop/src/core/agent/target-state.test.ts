import { describe, expect, it } from "vitest";
import type { AgentStatus } from "./status";
import {
  OBSERVED_QUIET_MS,
  TARGET_STATES,
  acceptsDelivery,
  SILENT_START_MIN_AGE_MS,
  SILENT_START_QUIET_MS,
  observedQuiet,
  queueable,
  silentStartIdle,
  stateSourceIsReported,
  targetState,
} from "./target-state";

/**
 * 五态投影（设计 `agent-delivery.md` §4.1）。纯函数，所以「重启之后读回来的
 * 那一行」是一个值，不是一次重启。
 */

function status(patch: Partial<AgentStatus> = {}): AgentStatus {
  return {
    nodeId: "node-1",
    workspaceId: "ws-1",
    agentId: "codex",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: "2026-09-20T09:00:00+00:00",
    stateSource: "hook",
    ...patch,
  } as AgentStatus;
}

describe("投递目标的五态", () => {
  it("没有活着的会话就是 exited，哪怕库里还有一行", () => {
    expect(targetState(status({ state: "working" }), undefined)).toBe("exited");
    expect(targetState(undefined, undefined)).toBe("exited");
  });

  it("会话在但没有过上报是 starting", () => {
    expect(targetState(undefined, 3)).toBe("starting");
    expect(targetState(status(), 3)).toBe("starting");
    expect(targetState(status({ state: "" }), 3)).toBe("starting");
  });

  it("working 是 busy", () => {
    expect(targetState(status({ state: "working" }), 1)).toBe("busy");
  });

  it("blocked 与 waiting 都是 awaiting-approval", () => {
    expect(targetState(status({ state: "blocked" }), 1)).toBe(
      "awaiting-approval",
    );
    expect(targetState(status({ state: "waiting" }), 1)).toBe(
      "awaiting-approval",
    );
  });

  it("done / error / idle 都是 idle——失败结束了也是结束了", () => {
    for (const state of ["done", "error", "idle"]) {
      expect(targetState(status({ state }), 1)).toBe("idle");
    }
  });

  it("restored 的 idle 不算 idle，走 starting 的路径", () => {
    expect(targetState(status({ state: "done", restored: true }), 1)).toBe(
      "starting",
    );
  });

  it("没上报过的通道不算 idle", () => {
    expect(
      targetState(status({ state: "done", stateSource: "observed" }), 1),
    ).toBe("starting");
    const stripped = { ...status({ state: "done" }) } as Record<
      string,
      unknown
    >;
    delete stripped.stateSource;
    expect(targetState(stripped as unknown as AgentStatus, 1)).toBe("starting");
    expect(stateSourceIsReported("hook")).toBe(true);
    expect(stateSourceIsReported("extension")).toBe(true);
    expect(stateSourceIsReported("observed")).toBe(false);
    expect(stateSourceIsReported(undefined)).toBe(false);
  });

  it("不认识的状态值当作还没有可用的上报", () => {
    expect(targetState(status({ state: "dancing" }), 1)).toBe("starting");
  });

  it("只有 idle 直接接受投递；除了 exited 都还值得排队", () => {
    expect(TARGET_STATES.filter(acceptsDelivery)).toEqual(["idle"]);
    expect(TARGET_STATES.filter((state) => !queueable(state))).toEqual([
      "exited",
    ]);
  });
});

describe("没有 hook 的 CLI 的提示符就绪启发式", () => {
  const now = 100_000;

  it("半截的行永远不安静", () => {
    expect(
      observedQuiet({ pending: true, lastInputAt: 0, lastOutputAt: 0 }, now),
    ).toBe(false);
  });

  it("输入之后两秒内有输出就不安静", () => {
    const lastOutputAt = now - (OBSERVED_QUIET_MS - 1);
    expect(
      observedQuiet(
        { pending: false, lastInputAt: now - 5_000, lastOutputAt },
        now,
      ),
    ).toBe(false);
    expect(
      observedQuiet(
        {
          pending: false,
          lastInputAt: now - 5_000,
          lastOutputAt: now - OBSERVED_QUIET_MS,
        },
        now,
      ),
    ).toBe(true);
  });

  it("什么都没发生过的会话算安静", () => {
    expect(
      observedQuiet(
        { pending: false, lastInputAt: undefined, lastOutputAt: undefined },
        now,
      ),
    ).toBe(true);
  });
});

describe("silentStartIdle", () => {
  const now = 1_000_000;
  const quiet = {
    pending: false,
    lastInputAt: undefined,
    lastOutputAt: now - SILENT_START_QUIET_MS,
  };
  const gate = {
    startsSilently: true,
    reported: false,
    observed: quiet,
    sessionAgeMs: SILENT_START_MIN_AGE_MS,
    nowMs: now,
  };

  it("四条都成立才放行", () => {
    expect(silentStartIdle(gate)).toBe(true);
  });

  it("没标旗的 CLI 一律不走：没报第一条就是还没起来", () => {
    expect(silentStartIdle({ ...gate, startsSilently: false })).toBe(false);
  });

  it("上报过的节点不走：包括重启后读回来的那种", () => {
    expect(silentStartIdle({ ...gate, reported: true })).toBe(false);
  });

  it("终端域说不出话就不走", () => {
    expect(silentStartIdle({ ...gate, observed: undefined })).toBe(false);
  });

  it("有半截没提交的行就不走", () => {
    expect(
      silentStartIdle({ ...gate, observed: { ...quiet, pending: true } }),
    ).toBe(false);
  });

  it("刚吐过东西照样走：Codex 的空闲屏一直在动，输出不是信号", () => {
    expect(
      silentStartIdle({
        ...gate,
        observed: { ...quiet, lastOutputAt: now - (SILENT_START_QUIET_MS - 1) },
      }),
    ).toBe(true);
  });

  it("会话不够老就不走，年龄不知道也不走", () => {
    expect(
      silentStartIdle({ ...gate, sessionAgeMs: SILENT_START_MIN_AGE_MS - 1 }),
    ).toBe(false);
    expect(silentStartIdle({ ...gate, sessionAgeMs: undefined })).toBe(false);
  });
});
