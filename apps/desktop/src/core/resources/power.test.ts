import { describe, expect, it } from "vitest";

import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  PowerService,
  inhibitCommand,
  inhibitorOf,
  LeaseNotFound,
} from "./power";

/**
 * 租约簿。抑制进程换成一个计数器：这里要证明的是**什么时候**起 / 停它，
 * 而真的起一个 `caffeinate` 会让单测在 CI 上顶着机器不睡。
 */

function book(options: { policy?: string; platform?: NodeJS.Platform } = {}) {
  let nowMs = 1_700_000_000_000;
  let running = 0;
  let started = 0;
  const service = new PowerService({
    policy: () => options.policy ?? "manual",
    platform: options.platform ?? "darwin",
    now: () => nowMs,
    inhibit: () => {
      running += 1;
      started += 1;
      return {
        stop: () => {
          running -= 1;
        },
      };
    },
  });
  return {
    service,
    advance: (seconds: number) => {
      nowMs += seconds * 1000;
    },
    get running() {
      return running;
    },
    get started() {
      return started;
    },
  };
}

describe("保持唤醒的租约", () => {
  it("第一条生效的租约起抑制进程，最后一条走掉杀掉它", () => {
    const held = book();
    expect(held.running).toBe(0);
    const first = held.service.acquire({ source: "manual", reason: "a" });
    const second = held.service.acquire({ source: "session", reason: "b" });
    expect(held.running).toBe(1);
    expect(held.started).toBe(1);

    held.service.release(first.id);
    expect(held.running).toBe(1);
    const state = held.service.release(second.id);
    expect(held.running).toBe(0);
    expect(state.holding).toBe(false);
    expect(state.leases).toEqual([]);
  });

  it("状态报的是策略、机制与全部租约", () => {
    const held = book();
    held.service.acquire({
      source: "session",
      reason: "long run",
      sessionId: "s-1",
      workspaceId: "ws-1",
    });
    const state = held.service.state();
    expect(state.policy).toBe("manual");
    expect(state.holding).toBe(true);
    expect(state.mechanism).toBe("caffeinate");
    expect(state.inhibitor).toEqual({
      platform: "macos",
      kind: "caffeinate",
      available: true,
      detail: null,
    });
    expect(state.leases).toHaveLength(1);
    expect(state.leases[0]).toMatchObject({
      source: "session",
      reason: "long run",
      sessionId: "s-1",
      workspaceId: "ws-1",
      active: true,
      blockedBy: null,
    });
  });

  it("被策略挡下的申请照样是一条租约，只是不生效", () => {
    const held = book({ policy: "agentSessions" });
    const manual = held.service.acquire({ source: "manual", reason: "按钮" });
    expect(manual.active).toBe(false);
    expect(manual.blockedBy).toBe("policy");
    expect(held.running).toBe(0);
    // 它仍然在表里：「为什么跑一半睡过去了」要有地方查。
    expect(held.service.state().leases).toHaveLength(1);

    const session = held.service.acquire({ source: "session", reason: "跑" });
    expect(session.active).toBe(true);
    expect(held.running).toBe(1);
  });

  it("never 谁都挡，manual 全放", () => {
    const none = book({ policy: "never" });
    for (const source of ["session", "automation", "manual"] as const) {
      expect(none.service.acquire({ source, reason: "x" }).active).toBe(false);
    }
    expect(none.running).toBe(0);

    const all = book({ policy: "manual" });
    for (const source of ["session", "automation", "manual"] as const) {
      expect(all.service.acquire({ source, reason: "x" }).active).toBe(true);
    }
    expect(all.started).toBe(1);
  });

  it("没有抑制机制的平台如实报 unsupported，而不是假装顶住了", () => {
    const held = book({ platform: "win32" });
    const lease = held.service.acquire({ source: "manual", reason: "x" });
    expect(lease.active).toBe(false);
    expect(lease.blockedBy).toBe("unavailable");
    expect(held.running).toBe(0);
    const state = held.service.state();
    expect(state.holding).toBe(false);
    expect(state.mechanism).toBeNull();
    expect(state.inhibitor).toEqual({
      platform: "windows",
      kind: null,
      available: false,
      detail: "unsupported",
    });
    expect(inhibitCommand("win32")).toBeUndefined();
  });

  it("没人续的租约到期自己消失，机器跟着被放开", () => {
    const held = book();
    held.service.acquire({ source: "manual", reason: "x", ttlSeconds: 10 });
    expect(held.running).toBe(1);
    held.advance(9);
    expect(held.service.state().leases).toHaveLength(1);
    held.advance(2);
    const state = held.service.state();
    expect(state.leases).toEqual([]);
    expect(state.holding).toBe(false);
    expect(held.running).toBe(0);
  });

  it("续期只推后到期，不动创建时刻", () => {
    const held = book();
    const lease = held.service.acquire({
      source: "manual",
      reason: "x",
      ttlSeconds: 10,
    });
    held.advance(8);
    const renewed = held.service.renew(lease.id, 30);
    expect(renewed.createdAt).toBe(lease.createdAt);
    expect(renewed.renewedAt).not.toBe(lease.renewedAt);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
      Date.parse(lease.expiresAt),
    );
    held.advance(20);
    expect(held.service.state().leases).toHaveLength(1);
  });

  it("续一条已经过期的租约是 404，不是悄悄复活它", () => {
    const held = book();
    const lease = held.service.acquire({
      source: "manual",
      reason: "x",
      ttlSeconds: 5,
    });
    held.advance(6);
    expect(() => held.service.renew(lease.id)).toThrow(LeaseNotFound);
  });

  it("TTL 缺省与上限都被夹住", () => {
    const held = book();
    const fallback = held.service.acquire({ source: "manual", reason: "x" });
    expect(
      Math.round(
        (Date.parse(fallback.expiresAt) - Date.parse(fallback.createdAt)) /
          1000,
      ),
    ).toBe(DEFAULT_TTL_SECONDS);
    const greedy = held.service.acquire({
      source: "manual",
      reason: "x",
      ttlSeconds: 86_400,
    });
    expect(
      Math.round(
        (Date.parse(greedy.expiresAt) - Date.parse(greedy.createdAt)) / 1000,
      ),
    ).toBe(MAX_TTL_SECONDS);
  });

  it("释放一条不存在的租约不是错误", () => {
    const held = book();
    expect(held.service.release("nope").leases).toEqual([]);
  });

  it("core 退出时所有租约被释放", () => {
    const held = book();
    held.service.acquire({ source: "manual", reason: "a" });
    held.service.acquire({ source: "session", reason: "b" });
    expect(held.running).toBe(1);
    held.service.stop();
    expect(held.running).toBe(0);
    expect(held.service.state().leases).toEqual([]);
  });

  it("两个平台各有自己的命令行", () => {
    expect(inhibitCommand("darwin")?.command).toBe("caffeinate");
    expect(inhibitCommand("linux")?.command).toBe("systemd-inhibit");
    expect(inhibitorOf("linux").kind).toBe("systemd-inhibit");
  });
});
