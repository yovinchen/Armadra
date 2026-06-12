import { describe, expect, it } from "vitest";
import { RUN_AGENT_EVENT } from "../canvas/shortcuts";
import { NODE_ACTIONS, NODE_COMMANDS } from "./actions";
import { NODE_META } from "./meta";

describe("NODE_COMMANDS", () => {
  it("uses the same event name B1 dispatches on ⌘⏎", () => {
    // `AcpSurface` listens on this name; `canvas/shortcuts.ts` dispatches it.
    expect(NODE_COMMANDS.runAgent).toBe(RUN_AGENT_EVENT);
  });
});

describe("NODE_ACTIONS", () => {
  it("covers every node type with the ids from the design table", () => {
    const ids = Object.fromEntries(
      Object.keys(NODE_META).map((type) => [
        type,
        NODE_ACTIONS[type as keyof typeof NODE_META]({
          nodeId: "00000000-0000-0000-0000-000000000000",
          workspaceId: null,
        }).map((action) => action.id),
      ]),
    );
    expect(ids).toEqual({
      task: ["task.dispatch", "task.edit"],
      agent: ["agent.run", "agent.renegotiate", "agent.push"],
      terminal: ["terminal.rerun", "terminal.reconnect"],
      diff: ["diff.acceptAll", "diff.revertAll", "diff.exportPatch"],
      file: ["file.openEditor", "file.addToAgent"],
      context: ["context.inject", "context.refresh"],
      log: ["log.export"],
      image: ["image.send", "image.annotate"],
      note: ["note.send", "note.toTask", "note.split"],
      browser: ["browser.send", "browser.screenshot", "browser.open"],
    });
  });

  it("marks the reserved actions disabled with an explanation", () => {
    const reserved = [
      ...NODE_ACTIONS.agent({ nodeId: "n", workspaceId: null }),
      ...NODE_ACTIONS.note({ nodeId: "n", workspaceId: null }),
      ...NODE_ACTIONS.browser({ nodeId: "n", workspaceId: null }),
      ...NODE_ACTIONS.image({ nodeId: "n", workspaceId: null }),
    ].filter((action) =>
      [
        "agent.push",
        "note.split",
        "browser.screenshot",
        "image.annotate",
      ].includes(action.id),
    );
    expect(reserved).toHaveLength(4);
    for (const action of reserved) {
      expect(action.disabled).toBe(true);
      expect(action.tooltip).toBeTruthy();
    }
  });
});
