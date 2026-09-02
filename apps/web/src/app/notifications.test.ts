import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "@ai-coding-canvas/shared";

import {
  NOTIFY_THROTTLE_MS,
  createAgentNotifier,
  notificationFor,
  notificationText,
  type NotifierDeps,
} from "./notifications";

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";

function status(partial: Partial<AgentStatus> = {}): AgentStatus {
  return {
    nodeId: NODE,
    workspaceId: WORKSPACE,
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: "2026-09-04T10:00:00.000Z",
    ...partial,
  };
}

interface Harness {
  deps: NotifierDeps;
  notify: ReturnType<typeof vi.fn>;
  playSound: ReturnType<typeof vi.fn>;
  background: { value: boolean };
  settings: { notifyDone: boolean; notifyNeedsYou: boolean; sound: boolean };
}

function harness(): Harness {
  const notify = vi.fn();
  const playSound = vi.fn();
  const background = { value: true };
  const settings = { notifyDone: true, notifyNeedsYou: true, sound: true };
  return {
    notify,
    playSound,
    background,
    settings,
    deps: {
      notify,
      playSound,
      isBackground: () => background.value,
      titleOf: () => "claude · 前端",
      settings: () => settings,
      now: () => Date.now(),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T10:00:00.000Z"));
});

afterEach(() => vi.useRealTimers());

describe("notificationFor", () => {
  it("fires on entering blocked or waiting, once per state", () => {
    expect(notificationFor(undefined, status({ state: "blocked" }))).toBe(
      "attention",
    );
    expect(
      notificationFor(
        status({ state: "blocked" }),
        status({ state: "blocked" }),
      ),
    ).toBeNull();
    // 等授权和等回答是两件事，切换时再叫一次。
    expect(
      notificationFor(
        status({ state: "blocked" }),
        status({ state: "waiting" }),
      ),
    ).toBe("attention");
  });

  it("fires once when a turn ends", () => {
    expect(
      notificationFor(status({ state: "working" }), status({ state: "done" })),
    ).toBe("done");
    expect(
      notificationFor(status({ state: "done" }), status({ state: "done" })),
    ).toBeNull();
  });

  it("stays quiet for a restored `done`", () => {
    expect(
      notificationFor(
        status({ state: "working" }),
        status({ state: "done", restored: true }),
      ),
    ).toBeNull();
  });

  /** 合成收尾不是结果：没跑完的回合不该弹「已完成」。 */
  it("stays quiet for a synthetic close", () => {
    for (const lastMessage of [
      "stale=true no hook report for 20 minutes",
      "terminated=true the terminal exited before the turn ended",
    ]) {
      expect(
        notificationFor(status({ state: "working" }), {
          ...status({ state: "done" }),
          interrupted: true,
          lastMessage,
        }),
      ).toBeNull();
    }
  });

  it("stays quiet while the agent is working", () => {
    expect(
      notificationFor(status({ state: "done" }), status({ state: "working" })),
    ).toBeNull();
  });
});

describe("notificationText", () => {
  it("is Chinese and names the node", () => {
    expect(notificationText("attention", "claude").title).toBe("claude 需要你");
    expect(notificationText("done", "claude").title).toBe("claude 已完成");
  });
});

describe("createAgentNotifier", () => {
  it("stays silent while the window is in the foreground", () => {
    const h = harness();
    h.background.value = false;
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "done" }));
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.playSound).not.toHaveBeenCalled();
  });

  it("notifies and plays a sound when the window is in the background", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "working" }));
    notifier.handle(status({ state: "done" }));
    expect(h.notify).toHaveBeenCalledWith(
      "claude · 前端 已完成",
      expect.any(String),
      NODE,
    );
    expect(h.playSound).toHaveBeenCalledWith("done");
  });

  it("throttles to one alert per node per 5s", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS - 1);
    notifier.handle(status({ state: "waiting" }));
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.playSound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.playSound).toHaveBeenCalledTimes(2);
  });

  it("throttles per node, not globally", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    notifier.handle(status({ nodeId: "other", state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("honours the notification and sound switches independently", () => {
    const h = harness();
    h.settings.notifyDone = false;
    h.settings.notifyNeedsYou = false;
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.playSound).toHaveBeenCalledTimes(1);

    h.settings.sound = false;
    h.settings.notifyNeedsYou = true;
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS);
    notifier.handle(status({ state: "waiting" }));
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  /**
   * §24.1 通知页把一个开关拆成两个：关掉「后台完成」不该顺带把「需要你」
   * 也关掉，反过来也一样。
   */
  it("gates 完成 and 需要你 on their own switches", () => {
    const h = harness();
    h.settings.notifyDone = false;
    const notifier = createAgentNotifier(h.deps);

    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS);
    notifier.handle(status({ state: "done" }));
    expect(h.notify).toHaveBeenCalledTimes(1);

    h.settings.notifyDone = true;
    h.settings.notifyNeedsYou = false;
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS);
    notifier.handle(status({ nodeId: "second", state: "waiting" }));
    expect(h.notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS);
    notifier.handle(status({ nodeId: "second", state: "done" }));
    expect(h.notify).toHaveBeenCalledTimes(2);
  });
});
