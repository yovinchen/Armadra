import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import {
  CanvasPresence,
  LEASE_HELD,
  type PresenceSnapshot,
  parseClientId,
  parseDeviceName,
} from "./presence";

/**
 * 在线表与编辑租约的规则，用一只假钟逐条走：争用、接管、空闲释放、断线
 * 释放、没有租约的写入被拒，以及最常见的那一种——只有一个人时什么都不发生。
 */
describe("canvas presence and the edit lease", () => {
  const WS = "ws";
  const BOARD = "board";
  const A = "client-aaaaaaaa";
  const B = "client-bbbbbbbb";
  let clock: number;
  let frames: PresenceSnapshot[];
  let presence: CanvasPresence;

  beforeEach(() => {
    clock = Date.parse("2026-09-26T08:00:00Z");
    frames = [];
    presence = new CanvasPresence({
      publish: (_, snapshot) => frames.push(snapshot),
      now: () => clock,
      ttlMs: 30_000,
      idleMs: 180_000,
    });
  });

  const beat = (clientId: string, active = false, deviceName = clientId) =>
    presence.heartbeat(WS, BOARD, { clientId, deviceName, active });

  function refusal(run: () => void): DomainError {
    try {
      run();
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("hands a lone client the lease on its first heartbeat, and stays quiet after", () => {
    const first = beat(A);
    expect(first.lease?.clientId).toBe(A);
    expect(first.clients.map((client) => client.clientId)).toEqual([A]);
    expect(frames).toHaveLength(1);
    // 续期心跳不发帧：一个人开着画布一整天，事件流上只有一帧。
    for (let round = 0; round < 10; round += 1) {
      clock += 10_000;
      beat(A);
    }
    expect(frames).toHaveLength(1);
    // 它的写入一路放行。
    expect(() => presence.authorizeWrite(WS, BOARD, A)).not.toThrow();
  });

  it("lets a write that arrives before the first heartbeat take the free lease", () => {
    presence.authorizeWrite(WS, BOARD, A);
    expect(presence.snapshot(BOARD).lease?.clientId).toBe(A);
  });

  it("keeps a second client read-only while the first holds the lease", () => {
    beat(A, false, "MacBook");
    const second = beat(B, true, "iPad");
    expect(second.lease?.clientId).toBe(A);
    expect(second.clients).toHaveLength(2);
    const refused = refusal(() => presence.authorizeWrite(WS, BOARD, B));
    expect(refused.status).toBe(423);
    expect(refused.code).toBe(LEASE_HELD);
    expect(refused.message).toContain("MacBook");
    // 显式拿（不带接管）也一样被拒。
    const asked = refusal(() =>
      presence.acquire(WS, BOARD, {
        clientId: B,
        deviceName: "iPad",
        takeover: false,
      }),
    );
    expect(asked.code).toBe(LEASE_HELD);
  });

  it("refuses a write with no client id while somebody holds the lease", () => {
    beat(A);
    const refused = refusal(() =>
      presence.authorizeWrite(WS, BOARD, undefined),
    );
    expect(refused.code).toBe(LEASE_HELD);
  });

  it("lets an anonymous write through a free lease without taking it", () => {
    presence.authorizeWrite(WS, BOARD, undefined);
    expect(presence.snapshot(BOARD).lease).toBeNull();
  });

  it("transfers the lease on an explicit takeover", () => {
    beat(A);
    beat(B);
    const taken = presence.acquire(WS, BOARD, {
      clientId: B,
      deviceName: "iPad",
      takeover: true,
    });
    expect(taken.lease?.clientId).toBe(B);
    expect(taken.lease?.deviceName).toBe("iPad");
    expect(frames.at(-1)?.lease?.clientId).toBe(B);
    // 原持有者此后的写入被拒，新持有者放行。
    expect(refusal(() => presence.authorizeWrite(WS, BOARD, A)).code).toBe(
      LEASE_HELD,
    );
    expect(() => presence.authorizeWrite(WS, BOARD, B)).not.toThrow();
  });

  it("releases an idle holder's lease to a client that is active", () => {
    beat(A);
    beat(B);
    // A 一直在心跳但没人碰它；B 也没动时租约不动。
    for (let elapsed = 0; elapsed < 200_000; elapsed += 10_000) {
      clock += 10_000;
      beat(A);
      beat(B);
    }
    // 空闲超时 + 有别人在看：放手。
    presence.sweep();
    expect(presence.snapshot(BOARD).lease).toBeNull();
    // 两个都没动时不分——谁都不该凭一次心跳把租约拿走。
    clock += 1_000;
    beat(B);
    expect(presence.snapshot(BOARD).lease).toBeNull();
    // B 动了手，下一次心跳就拿到。
    expect(beat(B, true).lease?.clientId).toBe(B);
  });

  it("does not release an idle lease when nobody else is watching", () => {
    beat(A);
    for (let elapsed = 0; elapsed < 600_000; elapsed += 10_000) {
      clock += 10_000;
      beat(A);
    }
    presence.sweep();
    expect(presence.snapshot(BOARD).lease?.clientId).toBe(A);
  });

  it("releases the lease when the holder stops heartbeating, and hands it to the one left", () => {
    beat(A);
    beat(B);
    // A 断线：只有 B 在续期。
    for (let elapsed = 0; elapsed <= 40_000; elapsed += 10_000) {
      clock += 10_000;
      beat(B);
    }
    presence.sweep();
    const after = presence.snapshot(BOARD);
    expect(after.clients.map((client) => client.clientId)).toEqual([B]);
    expect(after.lease?.clientId).toBe(B);
    expect(frames.at(-1)?.lease?.clientId).toBe(B);
  });

  it("releases the lease on an explicit leave", () => {
    beat(A);
    beat(B);
    const left = presence.leave(WS, BOARD, A);
    expect(left.clients.map((client) => client.clientId)).toEqual([B]);
    expect(left.lease?.clientId).toBe(B);
    // 最后一个走了之后什么都不留。
    const empty = presence.leave(WS, BOARD, B);
    expect(empty.clients).toEqual([]);
    expect(empty.lease).toBeNull();
    expect(presence.snapshot(BOARD).clients).toEqual([]);
  });

  it("forgets a board whose last client expired", () => {
    beat(A);
    clock += 60_000;
    presence.sweep();
    expect(presence.snapshot(BOARD)).toEqual({
      boardId: BOARD,
      clients: [],
      lease: null,
    });
  });

  it("validates the client id and cleans the device name", () => {
    expect(() => parseClientId("short")).toThrow();
    expect(() => parseClientId("has space in it")).toThrow();
    expect(parseClientId(A)).toBe(A);
    expect(parseDeviceName(undefined)).toBe("");
    expect(parseDeviceName("  Mac\u0007 ")).toBe("Mac");
    expect([...parseDeviceName("名".repeat(100))]).toHaveLength(64);
  });
});
