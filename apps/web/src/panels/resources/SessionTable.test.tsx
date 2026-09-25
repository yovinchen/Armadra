import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SessionResources } from "@armadra/shared";

vi.mock("@/session", () => ({
  sessionGateway: { terminate: vi.fn(() => Promise.resolve()) },
}));
vi.mock("@/sessions/SessionRow", () => ({ centerNode: vi.fn() }));

import { SessionTable } from "./SessionTable";
import { usePreferencesStore } from "@/app/preferences-store";

/**
 * 会话表的一条验收：**进程不在了就不占一行**。
 *
 * 以前退出的会话会留在列表里，CPU / 内存全是短横线，副标题写「进程已经不
 * 在了」——用户读到的是一堆再也不会更新的死行。跑丢但进程还在的会话由
 * 「孤立会话」区块单独列，这里不代劳。
 */

const session = (patch: Partial<SessionResources> = {}): SessionResources => ({
  sessionId: "s-1",
  sessionKey: "s-1",
  workspaceId: "w-1",
  nodeId: null,
  generation: 1,
  backend: "direct",
  location: "local",
  executionHostId: "local",
  cwd: "/tmp/alpha",
  pid: 100,
  alive: true,
  cpuPercent: 4,
  memoryBytes: 1024,
  memoryEstimated: true,
  childCount: 0,
  state: "runnable",
  startTimeUnixMs: 1_788_556_300_000,
  children: [],
  unknownReason: null,
  ...patch,
});

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => cleanup());

describe("会话表", () => {
  it("退出的会话和进程找不到的会话都不出现在列表里", () => {
    render(
      <SessionTable
        sessions={[
          session({ sessionId: "live", cwd: "/tmp/live" }),
          session({
            sessionId: "ended",
            cwd: "/tmp/ended",
            alive: false,
            pid: null,
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "exited",
          }),
          session({
            sessionId: "gone",
            cwd: "/tmp/gone",
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "not-found",
          }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );

    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.queryByText("ended")).toBeNull();
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("一个会话都不剩时是空状态，而不是一列死行", () => {
    render(
      <SessionTable
        sessions={[session({ alive: false, unknownReason: "exited" })]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("这个工作空间没有正在运行的会话")).toBeTruthy();
  });

  it("远端会话测不到指标，但仍然留在列表里", () => {
    render(
      <SessionTable
        sessions={[
          session({
            sessionId: "ssh",
            cwd: "/tmp/ssh",
            location: "remote",
            cpuPercent: null,
            memoryBytes: null,
            unknownReason: "remote",
          }),
        ]}
        sort="cpu"
        onSorted={() => {}}
      />,
    );
    expect(screen.getByText("ssh")).toBeTruthy();
    expect(screen.getByText("在远程主机上运行，本机测不到指标")).toBeTruthy();
  });
});
