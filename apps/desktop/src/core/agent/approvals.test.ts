import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rfc3339 } from "../workspaces/support";
import {
  ORPHAN_MINUTES,
  answerApproval,
  answerKeys,
  approvalAudit,
  getApproval,
  hasOpenApproval,
  insertApproval,
  pendingDir,
  sweepOrphans,
  validPendingId,
  writeAnswerFile,
} from "./approvals";
import { type AgentFixture, agentFixture } from "./fixture";
import { isAwaitingHuman } from "./status";

/**
 * Ported from `apps/runtime/src/api/tests/approvals.rs`,
 * `collab/tests/approvals.rs` and `db/tests/agent_status.rs`, plus the
 * cross-device CAS the Go Host adds in `agenthost/approvals.go`.
 */

let fixture: AgentFixture;
let nodeId: string;

beforeEach(() => {
  fixture = agentFixture();
  nodeId = fixture.agentNode("Claude");
  insertApproval(fixture.collab, {
    pendingId: "p-1",
    nodeId,
    workspaceId: fixture.workspaceId,
    request: { tool: "Bash" },
  });
});

afterEach(() => {
  fixture.close();
});

describe("answering a permission request", () => {
  it("records the answer and publishes it to the workspace", async () => {
    const { approval, route } = await answerApproval(fixture.collab, "p-1", {
      decision: "allow",
    });
    expect(approval.answer).toBe("allow");
    expect(approval.revision).toBe(1);
    // No client was waiting on a pending file, and the node has no PTY.
    expect(route).toBe("none");
    const published = fixture.events.at(-1);
    expect(published?.event.type).toBe("agent.approval");
    expect(published?.event).toMatchObject({ pendingId: "p-1", nodeId });
    const request = (published?.event as { request: Record<string, unknown> })
      .request;
    expect(request.resolved).toBe(true);
    expect(request.decision).toBe("allow");
  });

  it("answers over HTTP with the route beside the record", async () => {
    const answer = await fixture.call("POST", "/api/approvals/p-1/answer", {
      decision: "deny",
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      id: "p-1",
      answer: "deny",
      route: "none",
      revision: 1,
    });
  });

  it("refuses a second answer, and says so as a conflict", async () => {
    await answerApproval(fixture.collab, "p-1", { decision: "allow" });
    const second = await fixture.call("POST", "/api/approvals/p-1/answer", {
      decision: "deny",
    });
    expect(second.status).toBe(409);
    expect(getApproval(fixture.collab, "p-1").answer).toBe("allow");
  });

  it("refuses a decision that is not allow or deny", async () => {
    const answer = await fixture.call("POST", "/api/approvals/p-1/answer", {
      decision: "maybe",
    });
    expect(answer.status).toBe(400);
    expect(getApproval(fixture.collab, "p-1").answer).toBeNull();
  });

  it("lets the first of two devices win the revision race", async () => {
    // Both devices read revision 0 and both try to write revision 1. The
    // second is refused before any file is touched, which is the whole point:
    // recording first is what makes "answered exactly once" true.
    const first = await answerApproval(fixture.collab, "p-1", {
      decision: "allow",
      answeredBy: "device-a",
      expectedRevision: 0,
    });
    expect(first.approval.revision).toBe(1);
    await expect(
      answerApproval(fixture.collab, "p-1", {
        decision: "deny",
        answeredBy: "device-b",
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    const stored = getApproval(fixture.collab, "p-1");
    expect(stored.answer).toBe("allow");
    expect(stored.answeredBy).toBe("device-a");
    expect(stored.revision).toBe(1);
  });

  it("audits the loser as well as the winner", async () => {
    await answerApproval(fixture.collab, "p-1", {
      decision: "allow",
      answeredBy: "device-a",
    });
    await answerApproval(fixture.collab, "p-1", {
      decision: "deny",
      answeredBy: "device-b",
    }).catch(() => undefined);
    await fixture.call("POST", "/api/approvals/p-1/answer", {
      decision: "maybe",
    });
    const trail = approvalAudit(fixture.collab, "p-1");
    expect(trail).toHaveLength(3);
    expect(trail[0]).toMatchObject({
      decision: "allow",
      answeredBy: "device-a",
      accepted: true,
      appliedRevision: 1,
      route: "none",
      refusal: "",
    });
    expect(trail[1]).toMatchObject({
      decision: "deny",
      answeredBy: "device-b",
      accepted: false,
      appliedRevision: null,
      refusal: "already_answered",
    });
    expect(trail[2]).toMatchObject({
      decision: "maybe",
      accepted: false,
      refusal: "decision_invalid",
    });
  });

  it("writes the answer file when a client is polling for one", async () => {
    const directory = pendingDir(fixture.collab);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "p-1.json"), "{}");
    const { route } = await answerApproval(fixture.collab, "p-1", {
      decision: "allow",
    });
    expect(route).toBe("file");
    expect(readFileSync(join(directory, "p-1.answer"), "utf8")).toBe("allow");
  });

  it("falls back to the keys a human would press", async () => {
    fixture.session(nodeId, "claude");
    const { route } = await answerApproval(fixture.collab, "p-1", {
      decision: "deny",
    });
    expect(route).toBe("keys");
    // Claude's prompt is a numbered menu: 3 is "no, and tell it what to do".
    expect(fixture.terminal.writes.at(-1)?.data).toBe("3\r");
  });
});

describe("the answer keys", () => {
  it("covers every CLI in the registry and never answers nothing", () => {
    expect(answerKeys("claude", "allow")).toBe("1\r");
    expect(answerKeys("claude", "deny")).toBe("3\r");
    for (const agent of ["codex", "opencode", "pi", "omp", "copilot"]) {
      expect(answerKeys(agent, "allow")).toBe("y\r");
      expect(answerKeys(agent, "deny")).toBe("n\r");
    }
    // A provider this build has never heard of still gets an answer: the CLI
    // is blocked either way, and `n` is the safe guess.
    expect(answerKeys("invented", "deny")).toBe("n\r");
  });
});

describe("the pending directory", () => {
  it("refuses an id that could name a file we did not write", () => {
    expect(validPendingId("node-1-123-456")).toBe(true);
    expect(validPendingId("../escape")).toBe(false);
    expect(validPendingId("a/b")).toBe(false);
    expect(validPendingId("")).toBe(false);
    expect(validPendingId("x".repeat(201))).toBe(false);
    expect(() => writeAnswerFile("/tmp", "../escape", "allow")).toThrow();
  });

  it("says no when nobody is polling, rather than writing an orphan", () => {
    const directory = pendingDir(fixture.collab);
    mkdirSync(directory, { recursive: true });
    expect(writeAnswerFile(directory, "p-1", "allow")).toBe(false);
  });

  it("sweeps the files a killed client left behind", () => {
    const directory = pendingDir(fixture.collab);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "old.json"), "{}");
    writeFileSync(join(directory, "old.answer"), "allow");
    writeFileSync(join(directory, "notes.txt"), "not ours");
    // Nothing is old yet.
    expect(sweepOrphans(directory, ORPHAN_MINUTES * 60_000)).toBe(0);
    // Everything is old enough now, but only our own extensions go.
    expect(sweepOrphans(directory, -1)).toBe(2);
    expect(readFileSync(join(directory, "notes.txt"), "utf8")).toBe("not ours");
  });
});

describe("the safety gate the terminal domain asks about", () => {
  it("reports an open question, and does not invent one", () => {
    expect(hasOpenApproval(fixture.collab, nodeId)).toBe(true);
    expect(hasOpenApproval(fixture.collab, "nobody")).toBe(false);
  });

  it("calls a node blocked or waiting, and nothing else", () => {
    // Nothing has reported: "we do not know" is not evidence of a prompt, and
    // treating it as one would make every terminal unwritable until its first
    // report arrived.
    expect(isAwaitingHuman(fixture.database, nodeId)).toBe(false);
    const setState = (state: string): void => {
      fixture.database
        .prepare(
          "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at) " +
            "VALUES (?, ?, 'claude', ?, 0, 1, 0, ?) " +
            "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state",
        )
        .run(nodeId, fixture.workspaceId, state, rfc3339());
    };
    for (const state of ["blocked", "waiting"]) {
      setState(state);
      expect(isAwaitingHuman(fixture.database, nodeId)).toBe(true);
    }
    for (const state of ["idle", "working", "done", "error"]) {
      setState(state);
      expect(isAwaitingHuman(fixture.database, nodeId)).toBe(false);
    }
  });
});
