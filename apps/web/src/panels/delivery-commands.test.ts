import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, DriveLease } from "@armadra/shared";

import { makeNode } from "@/canvas/test-support";
import { terminalNodeCommands } from "./delivery-commands";

/**
 * 命令面板里对着一个具体终端说的那几条（设计 §10）。
 *
 * 守两件事：没有主语就一条都不出；接管与交还是互斥的两条，而不是一条带开关。
 */

const drives = vi.hoisted(() => ({ calls: [] as [string, string][] }));

vi.mock("@/api/terminals", () => ({
  terminalsApi: {
    driveTerminal: (sessionId: string, action: string) => {
      drives.calls.push([sessionId, action]);
      return Promise.resolve({});
    },
  },
}));

const t = (key: string, vars?: Record<string, string | number>) =>
  `${key}:${vars?.title ?? ""}`;

const lease = (state: DriveLease["state"]): DriveLease => ({
  state,
  generation: 1,
  expiresAt: "",
});

const terminal = makeNode("terminal", { title: "codex-1" }) as CanvasNode;

beforeEach(() => {
  drives.calls = [];
});

describe("terminalNodeCommands", () => {
  it("没有选中终端时一条都不出", () => {
    expect(
      terminalNodeCommands({ node: undefined, drive: undefined, t }),
    ).toEqual([]);
    expect(
      terminalNodeCommands({
        node: makeNode("sticky") as CanvasNode,
        drive: undefined,
        t,
      }),
    ).toEqual([]);
  });

  it("没有会话时只剩「看队列」：接管的对象是那个 PTY", () => {
    const commands = terminalNodeCommands({
      node: terminal,
      drive: undefined,
      t,
    });
    expect(commands.map((command) => command.id)).toEqual(["delivery.queue"]);
    expect(commands[0]?.label).toContain("codex-1");
  });

  it("Agent 在驱动给「接管」，人持有给「交还」，不同时给", () => {
    const takeover = terminalNodeCommands({
      node: terminal,
      drive: { sessionId: "s-1", lease: lease("agent") },
      t,
    });
    expect(takeover.map((command) => command.id)).toEqual([
      "delivery.queue",
      "delivery.takeover",
    ]);
    takeover[1]?.run();
    expect(drives.calls).toEqual([["s-1", "takeover"]]);

    const release = terminalNodeCommands({
      node: terminal,
      drive: { sessionId: "s-1", lease: lease("humanTakeover") },
      t,
    });
    expect(release.map((command) => command.id)).toEqual([
      "delivery.queue",
      "delivery.release",
    ]);
    release[1]?.run();
    expect(drives.calls).toEqual([
      ["s-1", "takeover"],
      ["s-1", "release"],
    ]);
  });
});
