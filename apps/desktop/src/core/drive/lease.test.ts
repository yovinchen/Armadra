import { describe, expect, it } from "vitest";
import {
  type Actor,
  DriveLease,
  LEASE_CODES,
  LEASE_GENERATION,
  LEASE_HELD_BY_AGENT,
  LEASE_HELD_BY_HUMAN,
  LEASE_REVOKED,
  agentActor,
  humanActor,
  leaseRefusalText,
} from "./lease";
import {
  AGENT_IDLE_SECONDS,
  HUMAN_IDLE_SECONDS,
  LeaseMachine,
} from "../browser/lease";

/**
 * 中立的那台状态机：它的**行为**由 `browser/lease.test.ts` 一行不改地守着
 * （那份用例是提取正确与否的判据）。这里只测提取本身带来的那一点新东西——
 * 窗口由构造函数传进来，两个域各是各的。
 */

const T0 = new Date("2026-09-20T09:00:00Z");
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

const TERMINAL = { humanIdleSeconds: 10, agentIdleSeconds: 120 };
const human = (): Actor => humanActor("device-a", "Laptop");
const agent = (): Actor => agentActor("node-7", "sess-7", "Claude");

describe("驱动租约（中立模块）", () => {
  it("空闲窗口来自构造函数，不是模块里的默认值", () => {
    const terminal = new DriveLease(0, TERMINAL);
    terminal.request(agent(), T0);
    // 浏览器的 30 秒过去了，终端的 120 秒还没有。
    expect(terminal.expire(at(AGENT_IDLE_SECONDS + 1))).toBe(false);
    expect(terminal.currentState()).toBe("agent");
    expect(terminal.expire(at(TERMINAL.agentIdleSeconds))).toBe(true);
    expect(terminal.currentState()).toBe("free");

    const browser = new LeaseMachine(0);
    browser.request(agent(), T0);
    expect(browser.expire(at(AGENT_IDLE_SECONDS))).toBe(true);
  });

  it("人的窗口两边一样长", () => {
    const terminal = new DriveLease(0, TERMINAL);
    terminal.request(human(), T0);
    expect(terminal.expire(at(HUMAN_IDLE_SECONDS - 1))).toBe(false);
    expect(terminal.expire(at(HUMAN_IDLE_SECONDS))).toBe(true);
  });

  it("两个域各持一份实例：接管浏览器不碰终端", () => {
    const browser = new LeaseMachine(0);
    const terminal = new DriveLease(0, TERMINAL);
    terminal.request(agent(), T0);
    browser.takeover(human(), T0);
    expect(browser.currentState()).toBe("humanTakeover");
    expect(terminal.currentState()).toBe("agent");
    expect(terminal.request(agent(), at(1))).toEqual({ kind: "granted" });
  });

  it("拒绝文案里的名词由各域传，码不变", () => {
    expect(LEASE_CODES).toEqual([
      LEASE_HELD_BY_HUMAN,
      LEASE_REVOKED,
      LEASE_HELD_BY_AGENT,
      LEASE_GENERATION,
    ]);
    expect(leaseRefusalText(LEASE_REVOKED, "terminal")).toBe(
      "LEASE_REVOKED: a person took over this terminal",
    );
    expect(leaseRefusalText(LEASE_REVOKED, "browser")).toBe(
      "LEASE_REVOKED: a person took over this browser",
    );
  });

  it("放掉别人的租约是拒绝，文案带本域的名词", () => {
    const terminal = new DriveLease(0, TERMINAL);
    terminal.request(agent(), T0);
    expect(() => terminal.release(human(), "terminal")).toThrowError(
      /LEASE_HELD_BY_AGENT: another agent is using this terminal/,
    );
  });
});
