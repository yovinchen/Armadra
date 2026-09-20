import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { loadSession } from "./nodes";

/**
 * Which of a node's terminal sessions the verbs mean by "its terminal".
 *
 * A node can own more than one row: a tmux pane that outlived the app is
 * adopted on the next start and sits beside the session the node opened in
 * between. Picking the newest row regardless of status handed `context
 * terminal`, the scheduler and the approval gate a session whose process was
 * gone — which reads as "that node has no terminal" about a node that plainly
 * has one.
 */

let fixture: AgentFixture;

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => {
  fixture.close();
});

function kill(sessionId: string): void {
  fixture.database
    .prepare("UPDATE terminal_sessions SET status = 'exited' WHERE id = ?")
    .run(sessionId);
}

describe("the session a node is running", () => {
  it("is the running one, even when a dead row is newer", () => {
    const node = fixture.agentNode("Claude");
    const running = fixture.session(node, "claude");
    const later = fixture.session(node, "claude");
    kill(later);
    expect(loadSession(fixture.database, node)?.sessionId).toBe(running);
  });

  it("is the newest dead one when none is running", () => {
    const node = fixture.agentNode("Claude");
    const first = fixture.session(node, "claude", 1);
    const second = fixture.session(node, "claude", 2);
    kill(first);
    kill(second);
    // Still answered: "the last thing this node ran" is what a transcript
    // lookup wants, and it is not a claim that anything is alive.
    expect(loadSession(fixture.database, node)).toMatchObject({
      sessionId: second,
      generation: 2,
      status: "exited",
    });
  });

  it("is the highest generation among several running rows", () => {
    const node = fixture.agentNode("Claude");
    fixture.session(node, "claude", 1);
    const newest = fixture.session(node, "claude", 3);
    fixture.session(node, "claude", 2);
    expect(loadSession(fixture.database, node)?.sessionId).toBe(newest);
  });

  it("is nothing at all for a node that never opened one", () => {
    expect(
      loadSession(fixture.database, fixture.agentNode("Claude")),
    ).toBeUndefined();
  });
});
