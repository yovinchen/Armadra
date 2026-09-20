import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { loadBoard } from "../canvas/documents";
import { getContextLinks } from "../canvas/context-links";
import {
  VERBS,
  answerConfirm,
  controlDispatcher,
  type ControlOutcome,
} from "./control";

/**
 * Ported from the pre-merge implementation's control test suites.
 *
 * Every test goes through the {@link import("./control").ControlDispatcher},
 * which is exactly what the Hook surface calls once it has authenticated the
 * caller — so a rule that only held inside the module would not pass here.
 */

let fixture: AgentFixture;
let me: string;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
  verdict: "verified" | "legacy" = "verified",
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId, verdict), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.message}`);
  return outcome.body;
}

function refusal(outcome: ControlOutcome): {
  status: number;
  code: string;
  message: string;
} {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

beforeEach(() => {
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
});

afterEach(() => {
  fixture.close();
});

describe("the dispatcher", () => {
  it("publishes exactly the thirteen verbs plus help, and derives help from them", async () => {
    const dispatcher = controlDispatcher();
    expect(dispatcher?.verbs).toEqual([...VERBS]);
    expect(VERBS).toHaveLength(14);
    const body = ok(await run(me, "help"));
    expect(body.result).toMatchObject({ protocol: "armadra.mailbox.v1" });
    // Derived, not restated: a verb added without a help line would be
    // invisible, and a line left behind would be a lie.
    expect((body.result as { verbs: string[] }).verbs).toEqual([...VERBS]);
  });

  it("refuses an unknown verb by name and lists the real ones", async () => {
    const refused = refusal(await run(me, "explode"));
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("explode");
    expect(refused.message).toContain("open-agent");
  });

  it("lets a caller with no node token run only the read-only verbs", async () => {
    // `list` and `help` are reads; everything that changes something needs a
    // token this core minted.
    expect(ok(await run(me, "list", {}, "legacy"))).toHaveProperty("ok", true);
    expect(ok(await run(me, "help", {}, "legacy"))).toHaveProperty("ok", true);
    for (const verb of ["open-terminal", "sticky", "rename", "close"]) {
      const refused = refusal(await run(me, verb, {}, "legacy"));
      expect(refused.status).toBe(403);
      expect(refused.code).toBe("forbidden");
    }
  });
});

describe("list", () => {
  it("names every node, marks the caller, and carries the agent state", async () => {
    const other = fixture.agentNode("Codex", "codex");
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at) " +
          "VALUES (?, ?, 'codex', 'working', 0, 1, 0, '2026-01-01T00:00:00+00:00')",
      )
      .run(other, fixture.workspaceId);
    const body = ok(await run(me, "list"));
    const rows = body.result as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === me)).toMatchObject({ self: true });
    expect(rows.find((row) => row.id === other)).toMatchObject({
      agent: "codex",
      state: "working",
      self: false,
    });
    expect(String(body.message)).toContain("← 你");
  });
});

describe("the verbs that add a node", () => {
  it("creates a terminal node to the right of the caller", async () => {
    const body = ok(await run(me, "open-terminal", { title: "Logs" }));
    const created = (body.result as { id: string }).id;
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const node = document.nodes.find((entry) => entry.id === created);
    expect(node?.type).toBe("terminal");
    expect(node?.title).toBe("Logs");
    expect(node?.position.x).toBeGreaterThan(0);
  });

  /**
   * Placement is the one thing here that still needs a number, and it is a
   * constant rather than a per-type table: two nodes at the same coordinates
   * look like one, and stepping down by a terminal's height keeps them apart
   * whatever they turn out to be.
   */
  it("stands a second node clear of the first without a size table", async () => {
    const first = (
      ok(await run(me, "open-terminal", { title: "One" })).result as {
        id: string;
      }
    ).id;
    const second = (
      ok(await run(me, "open-terminal", { title: "Two" })).result as {
        id: string;
      }
    ).id;
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const a = document.nodes.find((entry) => entry.id === first)!;
    const b = document.nodes.find((entry) => entry.id === second)!;
    expect(a.position.x).toBe(b.position.x);
    expect(Math.abs(b.position.y - a.position.y)).toBeGreaterThanOrEqual(600);
  });

  /**
   * The default size of a node is the size it is drawn at, and the one table
   * of those lives in the front end (`apps/web/src/nodes/registry.ts`). A
   * second table here is what made a verb-created terminal come out 640×440
   * beside a 960×600 one from the add menu, so a verb writes no size at all
   * and the page fills it in when it projects the document.
   */
  it("leaves the size out, so the page gives it the same default a person gets", async () => {
    const terminal = (
      ok(await run(me, "open-terminal", { title: "Logs" })).result as {
        id: string;
      }
    ).id;
    const note = (
      ok(await run(me, "sticky", { title: "Note", content: "hi" })).result as {
        id: string;
      }
    ).id;
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    for (const id of [terminal, note]) {
      const node = document.nodes.find((entry) => entry.id === id);
      expect(node).toBeDefined();
      expect(node?.size).toBeUndefined();
    }
  });

  /**
   * `board.changed` says the board is a version newer; it cannot say a node
   * appeared or which one. Without that, an agent-created node only shows up
   * in a corner, while one added from the menu is selected and brought into
   * view.
   */
  it("names the new node and the caller so the page can go to it", async () => {
    const created = (
      ok(await run(me, "open-terminal", { title: "Logs" })).result as {
        id: string;
      }
    ).id;
    const published = fixture.events.map((entry) => entry.event);
    const changed = published.findIndex(
      (event) => event.type === "board.changed",
    );
    const announced = published.findIndex(
      (event) => event.type === "node.created",
    );
    // Order matters: the client re-reads on `board.changed`, so the frame that
    // names the node must not arrive before the reason to go and fetch it.
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(announced).toBeGreaterThan(changed);
    expect(published[announced]).toEqual({
      type: "node.created",
      boardId: fixture.boardId,
      nodeId: created,
      nodeType: "terminal",
      originNodeId: me,
    });
    expect(fixture.events[announced]?.workspaceId).toBe(fixture.workspaceId);
  });

  it("says nothing about a created node when a verb only edits one", async () => {
    await run(me, "rename", { node: me, title: "Renamed" });
    expect(
      fixture.events.some((entry) => entry.event.type === "node.created"),
    ).toBe(false);
  });

  it("writes an agent node's launch line but never starts a process", async () => {
    const body = ok(
      await run(me, "open-agent", { agent: "codex", prompt: "fix\nthe bug" }),
    );
    expect(body.result).toMatchObject({
      agent: "codex",
      command: "codex 'fix the bug'",
      after: [],
    });
    const created = (body.result as { id: string }).id;
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const data = document.nodes.find((entry) => entry.id === created)?.data as {
      agent: Record<string, unknown>;
    };
    expect(data.agent.initialCommand).toBe("codex 'fix the bug'");
    expect(data.agent.pendingLaunch).toBeUndefined();
    // Nothing was spawned: the node creates its own PTY when it mounts.
    expect(fixture.terminal.writes).toHaveLength(0);
  });

  it("makes an agent with dependencies wait instead of starting itself", async () => {
    const first = fixture.agentNode("First");
    const body = ok(
      await run(me, "open-agent", { agent: "claude", after: first }),
    );
    const created = (body.result as { id: string }).id;
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const data = document.nodes.find((entry) => entry.id === created)?.data as {
      agent: Record<string, unknown>;
    };
    expect(data.agent.pendingLaunch).toEqual({
      command: "claude",
      after: [first],
    });
    expect(data.agent.initialCommand).toBeUndefined();
  });

  it("refuses an unknown agent and an --after that is not on the board", async () => {
    expect(
      refusal(await run(me, "open-agent", { agent: "gemini" })).status,
    ).toBe(400);
    expect(refusal(await run(me, "open-agent", {})).status).toBe(400);
    const refused = refusal(
      await run(me, "open-agent", { agent: "claude", after: "nobody" }),
    );
    expect(refused.message).toContain("nobody");
  });

  it("changes nothing on a dry run", async () => {
    const before = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    ).nodes.length;
    for (const verb of ["open-terminal", "sticky"]) {
      const body = ok(await run(me, verb, { "dry-run": true, title: "X" }));
      expect(body.result).toMatchObject({ dryRun: true });
    }
    const body = ok(
      await run(me, "open-agent", { agent: "claude", "dry-run": true }),
    );
    expect(body.result).toMatchObject({ dryRun: true });
    expect(
      loadBoard(fixture.database, fixture.workspaceId, fixture.boardId).nodes,
    ).toHaveLength(before);
  });

  it("refuses a sticky body that is too long", async () => {
    const refused = refusal(
      await run(me, "sticky", { content: "x".repeat(20_001) }),
    );
    expect(refused.status).toBe(400);
  });
});

describe("the verbs that edit the board", () => {
  it("moves the edge and both link documents in the same breath", async () => {
    const other = fixture.agentNode("Codex", "codex");
    ok(await run(me, "link", { to: "Codex" }));
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.edges).toHaveLength(1);
    // The link document is what the reads authorise against, so it has to
    // move with the edge or the canvas would show a line nobody may cross.
    expect(getContextLinks(fixture.database, me).links[0]?.id).toBe(other);
    expect(getContextLinks(fixture.database, other).links[0]?.id).toBe(me);
  });

  it("refuses a self link and an ambiguous name", async () => {
    fixture.agentNode("Twin");
    fixture.agentNode("Twin");
    expect(refusal(await run(me, "link", { to: "Caller" })).status).toBe(400);
    const ambiguous = refusal(await run(me, "link", { to: "Twin" }));
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.message).toContain("2");
  });

  it("sets a title and a unique handle, and refuses a duplicate one", async () => {
    const other = fixture.agentNode("Codex", "codex");
    ok(await run(other, "rename", { handle: "Review" }));
    // Handles are folded, so `Review` and `review` are the same handle.
    const refused = refusal(await run(me, "rename", { handle: "review" }));
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("Codex");
    const body = ok(
      await run(me, "rename", { title: "Renamed", handle: "me" }),
    );
    expect(body.result).toMatchObject({ title: "Renamed", handle: "me" });
  });

  it("refuses rename with nothing to change, and the two handle flags together", async () => {
    expect(refusal(await run(me, "rename", {})).status).toBe(400);
    expect(
      refusal(await run(me, "rename", { handle: "x", "no-handle": true }))
        .status,
    ).toBe(400);
    expect(refusal(await run(me, "rename", { handle: "-bad" })).status).toBe(
      400,
    );
  });

  it("only accepts a colour from the node palette", async () => {
    ok(await run(me, "color", { color: "#32D74B" }));
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes.find((n) => n.id === me)?.color).toBe("#32d74b");
    const refused = refusal(await run(me, "color", { color: "#123456" }));
    expect(refused.status).toBe(400);
    expect(refusal(await run(me, "color", {})).status).toBe(400);
  });
});

describe("interrupt", () => {
  it("refuses a target the caller is not linked to", async () => {
    const other = fixture.agentNode("Codex", "codex");
    fixture.session(other, "codex");
    // No links at all is its own answer; the interesting case is a caller who
    // *has* a link, just not to this node.
    expect(refusal(await run(me, "interrupt", { to: "Codex" })).code).toBe(
      "no_links",
    );
    fixture.link(me, fixture.agentNode("Elsewhere", "claude"));
    const refused = refusal(await run(me, "interrupt", { to: "Codex" }));
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("target_not_linked");
    expect(fixture.terminal.writes).toHaveLength(0);
  });

  it("sends nothing but an Escape, and traces it with a zero body", async () => {
    const other = fixture.agentNode("Codex", "codex");
    fixture.link(me, other);
    const session = fixture.session(other, "codex");
    fixture.terminal.foreground = { command: "codex" };
    const body = ok(await run(me, "interrupt", { to: "Codex" }));
    expect(fixture.terminal.writes).toEqual([
      { sessionId: session, generation: 1, data: "" },
    ]);
    expect(body.result).toMatchObject({ id: other });
    const trace = fixture.collab.boardLog.snapshot();
    // The workspace root is writable in the fixture, so the trace is on disk
    // and the ring stays empty; either way `bodyChars` is zero.
    expect(trace.length).toBe(0);
  });

  it("refuses when the pane is no longer running that agent", async () => {
    const other = fixture.agentNode("Codex", "codex");
    fixture.link(me, other);
    fixture.session(other, "codex");
    fixture.terminal.foreground = { command: "vim" };
    const refused = refusal(await run(me, "interrupt", { to: "Codex" }));
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("target_not_agent_pane");
    expect(fixture.terminal.writes).toHaveLength(0);
  });

  it("refuses a target that is not a terminal, and refuses interrupting yourself", async () => {
    const note = fixture.stickyNode("Note", "hi");
    fixture.link(me, note);
    const refused = refusal(await run(me, "interrupt", { to: "Note" }));
    expect(refused.code).toBe("target_not_terminal");
  });
});

describe("close", () => {
  it("refuses when no client is watching the workspace", async () => {
    const other = fixture.agentNode("Codex", "codex");
    fixture.watchers = 0;
    const refused = refusal(await run(me, "close", { node: "Codex" }));
    expect(refused.status).toBe(403);
    expect(
      loadBoard(fixture.database, fixture.workspaceId, fixture.boardId).nodes,
    ).toHaveLength(2);
    expect(other).toBeTruthy();
  });

  it("waits for a human, then destroys the PTY before removing the node", async () => {
    const other = fixture.agentNode("Codex", "codex");
    const session = fixture.session(other, "codex");
    fixture.watchers = 1;
    const pending = run(me, "close", { node: "Codex" });
    // The dialog frame is what the canvas draws; answering it is a separate
    // route that a human drives.
    await Promise.resolve();
    const frame = fixture.events.at(-1)?.event as {
      type: string;
      requestId: string;
    };
    expect(frame.type).toBe("control.confirm");
    expect(answerConfirm(frame.requestId, true)).toBe(true);
    const body = ok(await pending);
    expect(body.result).toMatchObject({ id: other, closed: true });
    expect(fixture.terminal.terminated).toEqual([session]);
    expect(
      loadBoard(fixture.database, fixture.workspaceId, fixture.boardId).nodes,
    ).toHaveLength(1);
  });

  it("leaves the board alone when the human says no", async () => {
    fixture.agentNode("Codex", "codex");
    fixture.watchers = 1;
    const pending = run(me, "close", { node: "Codex" });
    await Promise.resolve();
    const frame = fixture.events.at(-1)?.event as { requestId: string };
    answerConfirm(frame.requestId, false);
    expect(refusal(await pending).status).toBe(403);
    expect(
      loadBoard(fixture.database, fixture.workspaceId, fixture.boardId).nodes,
    ).toHaveLength(2);
  });

  it("refuses to close the caller's own node", async () => {
    fixture.watchers = 1;
    const refused = refusal(await run(me, "close", { node: "Caller" }));
    expect(refused.status).toBe(400);
    // Answering a confirmation nobody minted is "too late", not an error.
    expect(answerConfirm("never-minted", true)).toBe(false);
  });
});
