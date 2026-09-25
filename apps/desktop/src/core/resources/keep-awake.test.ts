import { afterEach, describe, expect, it } from "vitest";

import { KeepAwake, WORKING_STALE_MS } from "./keep-awake";
import { PowerService } from "./power";

/**
 * 工作时自动持有的租约。抑制进程换成计数器，与 `power.test.ts` 同一个理由：
 * 要证明的是什么时候申请、什么时候放，而不是真的让 CI 机器醒着。
 */

let nowMs = 1_700_000_000_000;
let running = 0;
let stops: (() => void)[] = [];

function setUp(
  options: {
    enabled?: () => boolean;
    automation?: () => boolean;
    policy?: string;
  } = {},
) {
  const power = new PowerService({
    policy: () => options.policy ?? "manual",
    platform: "darwin",
    now: () => nowMs,
    inhibit: () => {
      running += 1;
      return {
        stop: () => {
          running -= 1;
        },
      };
    },
  });
  const keep = new KeepAwake({
    power,
    enabled: options.enabled ?? (() => true),
    automationActive: options.automation ?? (() => false),
    now: () => nowMs,
  });
  stops.push(() => {
    keep.stop();
    power.stop();
  });
  const sources = () =>
    power
      .state()
      .leases.map((lease) => lease.source)
      .sort();
  return { power, keep, sources };
}

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  running = 0;
});

describe("Agent 干活时的防休眠租约", () => {
  it("有节点在一轮里就持有一把，全部结束才放", () => {
    const { keep, sources } = setUp();
    keep.noteStatus("a", "working");
    keep.noteStatus("b", "working");
    expect(sources()).toEqual(["session"]);
    expect(running).toBe(1);
    keep.noteStatus("a", "done");
    expect(sources()).toEqual(["session"]);
    keep.noteStatus("b", "idle");
    expect(sources()).toEqual([]);
    expect(running).toBe(0);
  });

  it("停在一个问题上不算在干活，终端退出也放", () => {
    const { keep, sources } = setUp();
    keep.noteStatus("a", "working");
    keep.noteStatus("a", "blocked");
    expect(sources()).toEqual([]);
    keep.noteStatus("a", "working");
    keep.noteExit("a");
    expect(sources()).toEqual([]);
  });

  it("再有上报只续期，不换第二把", () => {
    const { keep, power } = setUp();
    keep.noteStatus("a", "working");
    const first = power.state().leases[0]?.id;
    nowMs += 60_000;
    keep.noteStatus("a", "working");
    const leases = power.state().leases;
    expect(leases).toHaveLength(1);
    expect(leases[0]?.id).toBe(first);
  });

  it("失联的 working 半小时后不再算数", () => {
    const { keep, sources } = setUp();
    keep.noteStatus("a", "working");
    nowMs += WORKING_STALE_MS;
    keep.reconcile();
    expect(sources()).toEqual([]);
  });

  it("自动化运行在进行时另持一把，关掉开关两把都放", () => {
    let enabled = true;
    let automation = true;
    const { keep, sources } = setUp({
      enabled: () => enabled,
      automation: () => automation,
    });
    keep.reconcile();
    expect(sources()).toEqual(["automation"]);
    keep.noteStatus("a", "working");
    expect(sources()).toEqual(["automation", "session"]);
    enabled = false;
    keep.reconcile();
    expect(sources()).toEqual([]);
    enabled = true;
    automation = false;
    keep.reconcile();
    expect(sources()).toEqual(["session"]);
  });

  it("被人在面板上放掉了，还在干活就重新申请", () => {
    const { keep, power, sources } = setUp();
    keep.noteStatus("a", "working");
    const id = power.state().leases[0]?.id ?? "";
    power.release(id);
    keep.reconcile();
    expect(sources()).toEqual(["session"]);
  });

  it("策略不放行时照样记下，但不生效", () => {
    const { keep, power } = setUp({ policy: "never" });
    keep.noteStatus("a", "working");
    expect(power.state().leases[0]).toMatchObject({
      source: "session",
      active: false,
      blockedBy: "policy",
    });
    expect(running).toBe(0);
  });
});
