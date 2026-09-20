import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DriveLease, WorkspaceEvent } from "@armadra/shared";

import { dispatchWorkspaceEvent } from "@/api/events";
import { DriveBadge, driveLabel } from "./DriveBadge";

/**
 * 节点头的「谁在驱动」（设计 `agent-delivery.md` §6）。
 *
 * 状态只从 `terminal.lease` 来：这个用例证明徽标不做任何推断，包括「我刚才
 * 敲过所以是我」。
 */

const lease = (
  state: DriveLease["state"],
  holder?: DriveLease["holder"],
): DriveLease => ({
  state,
  generation: 2,
  expiresAt: "",
  ...(holder ? { holder } : {}),
});

const frame = (nodeId: string, value: DriveLease): WorkspaceEvent =>
  ({
    type: "terminal.lease",
    sessionId: "session-1",
    nodeId,
    lease: value,
  }) as WorkspaceEvent;

afterEach(cleanup);

describe("driveLabel", () => {
  it("空闲、没有持有者、没有事件，都不画", () => {
    expect(driveLabel(undefined)).toBeUndefined();
    expect(driveLabel(lease("free"))).toBeUndefined();
    expect(driveLabel(lease("human"))).toBeUndefined();
  });

  it("人与接管是两句话", () => {
    const holder = { kind: "human", id: "local", displayName: "" } as const;
    expect(driveLabel(lease("human", holder))?.key).toBe("terminal.drive.you");
    expect(driveLabel(lease("humanTakeover", holder))?.key).toBe(
      "terminal.drive.takeover",
    );
  });

  it("Agent 用名字，没名字退回节点 id", () => {
    expect(
      driveLabel(
        lease("agent", { kind: "agent", id: "node-7", displayName: "codex-1" }),
      ),
    ).toEqual({ key: "terminal.drive.agent", name: "codex-1" });
    expect(
      driveLabel(
        lease("agent", { kind: "agent", id: "node-7", displayName: "" }),
      ),
    ).toEqual({ key: "terminal.drive.agent", name: "node-7" });
  });
});

describe("DriveBadge", () => {
  it("人敲键翻成「你在驱动」，租约过期就消失", () => {
    render(<DriveBadge nodeId="node-a" />);
    expect(screen.queryByTestId).toBeDefined();
    expect(document.querySelector('[data-slot="terminal-driver"]')).toBeNull();

    act(() => {
      dispatchWorkspaceEvent(
        frame(
          "node-a",
          lease("agent", {
            kind: "agent",
            id: "node-b",
            displayName: "codex-1",
          }),
        ),
      );
    });
    expect(screen.getByText("Agent codex-1 在驱动")).toBeTruthy();

    act(() => {
      dispatchWorkspaceEvent(
        frame(
          "node-a",
          lease("human", { kind: "human", id: "local", displayName: "" }),
        ),
      );
    });
    expect(screen.getByText("你在驱动")).toBeTruthy();

    act(() => {
      dispatchWorkspaceEvent(frame("node-a", lease("free")));
    });
    expect(document.querySelector('[data-slot="terminal-driver"]')).toBeNull();
  });

  it("别的节点的租约与自己无关", () => {
    render(<DriveBadge nodeId="node-a" />);
    act(() => {
      dispatchWorkspaceEvent(
        frame(
          "node-z",
          lease("human", { kind: "human", id: "local", displayName: "" }),
        ),
      );
    });
    expect(document.querySelector('[data-slot="terminal-driver"]')).toBeNull();
  });

  it("会话退出就没有「谁在驱动」这回事", () => {
    render(<DriveBadge nodeId="node-a" />);
    act(() => {
      dispatchWorkspaceEvent(
        frame(
          "node-a",
          lease("human", { kind: "human", id: "local", displayName: "" }),
        ),
      );
    });
    expect(screen.getByText("你在驱动")).toBeTruthy();
    act(() => {
      dispatchWorkspaceEvent({
        type: "terminal.exit",
        sessionId: "session-1",
        nodeId: "node-a",
      } as WorkspaceEvent);
    });
    expect(document.querySelector('[data-slot="terminal-driver"]')).toBeNull();
  });
});
