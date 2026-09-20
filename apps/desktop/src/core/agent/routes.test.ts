import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rfc3339 } from "../workspaces/support";
import { type AgentFixture, agentFixture } from "./fixture";

/**
 * Ported from the pre-merge implementation — the surfaces this
 * domain answers on the runtime listener.
 */

let fixture: AgentFixture;

function statusRow(
  nodeId: string,
  patch: Partial<{
    agentId: string;
    unread: number;
    transcriptPath: string;
    sessionId: string;
  }> = {},
): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, " +
        "updated_at, transcript_path, session_id) VALUES (?, ?, ?, 'done', ?, 1, 0, ?, ?, ?)",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      patch.agentId ?? "claude",
      patch.unread ?? 1,
      rfc3339(),
      patch.transcriptPath ?? null,
      patch.sessionId ?? null,
    );
}

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => {
  fixture.close();
});

describe("GET /api/agent-status/{nodeId}/transcript", () => {
  it("renders the node's own conversation one line per message", async () => {
    const node = fixture.agentNode("Claude");
    const path = join(fixture.directory, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "hello" } }),
        JSON.stringify({ type: "assistant", message: { content: "hi" } }),
      ].join("\n"),
    );
    statusRow(node, { transcriptPath: path });
    const answer = await fixture.call(
      "GET",
      `/api/agent-status/${node}/transcript`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ nodeId: node, truncated: false });
    expect(String((answer.body as { text: string }).text)).toBe(
      "[用户] hello\n[助手] hi",
    );
  });

  it("answers 501 for a provider that keeps nothing readable", async () => {
    // An empty excerpt would be indistinguishable from a session that has said
    // nothing yet, and the panel would draw the blank as the truth.
    const node = fixture.agentNode("OpenCode", "opencode");
    statusRow(node, { agentId: "opencode" });
    const answer = await fixture.call(
      "GET",
      `/api/agent-status/${node}/transcript`,
    );
    expect(answer.status).toBe(501);
  });

  it("answers 404 for a node that has never reported", async () => {
    const answer = await fixture.call(
      "GET",
      "/api/agent-status/nobody/transcript",
    );
    expect(answer.status).toBe(404);
  });

  it("answers 501 when the file is not a conversation it renders", async () => {
    const node = fixture.agentNode("Claude");
    const path = join(fixture.directory, "junk.jsonl");
    writeFileSync(path, "not json at all\n");
    statusRow(node, { transcriptPath: path });
    const answer = await fixture.call(
      "GET",
      `/api/agent-status/${node}/transcript`,
    );
    expect(answer.status).toBe(501);
  });
});

describe("POST /api/agent-status/{nodeId}/read", () => {
  it("clears the badge once and broadcasts only that once", async () => {
    const node = fixture.agentNode("Claude");
    statusRow(node, { unread: 1 });
    const first = await fixture.call("POST", `/api/agent-status/${node}/read`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ nodeId: node, unread: false });
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]?.event.type).toBe("agent.status");
    // A node that is already read is answered normally and not re-announced:
    // one pointless frame per finished turn on every workspace socket is what
    // this avoids.
    const second = await fixture.call("POST", `/api/agent-status/${node}/read`);
    expect(second.status).toBe(200);
    expect(fixture.events).toHaveLength(1);
  });
});

describe("POST /api/agent-status/{nodeId}/suggest-title", () => {
  it("prefers the transcript, then the pane, then the agent's own label", async () => {
    const node = fixture.agentNode("Claude");
    const path = join(fixture.directory, "t.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", cwd: "/a", message: { content: "port the index" } })}\n`,
    );
    statusRow(node, { transcriptPath: path });
    const fromTranscript = await fixture.call(
      "POST",
      `/api/agent-status/${node}/suggest-title`,
    );
    expect(fromTranscript.body).toEqual({
      title: "port the index",
      source: "transcript",
    });

    const second = fixture.agentNode("Second");
    statusRow(second);
    fixture.session(second, "claude");
    fixture.terminal.capture = "$ pnpm test\n";
    const fromTerminal = await fixture.call(
      "POST",
      `/api/agent-status/${second}/suggest-title`,
    );
    expect(fromTerminal.body).toEqual({
      title: "pnpm test",
      source: "terminal",
    });

    const third = fixture.agentNode("Third");
    statusRow(third);
    const fromAgent = await fixture.call(
      "POST",
      `/api/agent-status/${third}/suggest-title`,
    );
    // Always available and never wrong. No model is called for a rename.
    expect(fromAgent.body).toEqual({ title: "Claude Code", source: "agent" });
  });
});

describe("GET /api/conversations", () => {
  it("lists the index and refreshes it on demand", async () => {
    const listed = await fixture.call("GET", "/api/conversations");
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body)).toBe(true);
    const refreshed = await fixture.call("POST", "/api/conversations/refresh");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toHaveProperty("total");
  });
});

describe("GET /api/workspaces/{id}/deliveries", () => {
  it("answers the history without ever carrying a message body", async () => {
    fixture.database
      .prepare(
        "INSERT INTO agent_deliveries (trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt, body_chars, created_at) " +
          "VALUES ('t-1', ?, 'a', 'b', 'delivered', 'echo', 42, ?)",
      )
      .run(fixture.workspaceId, rfc3339());
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/deliveries`,
    );
    expect(answer.status).toBe(200);
    const rows = answer.body as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      traceId: "t-1",
      outcome: "delivered",
      bodyChars: 42,
    });
    expect(JSON.stringify(rows[0])).not.toContain('body":');
  });

  it("answers 404 for a workspace nobody has, not an empty list", async () => {
    const answer = await fixture.call("GET", "/api/workspaces/nope/deliveries");
    expect(answer.status).toBe(404);
  });
});

/**
 * 同一条路径的第二个切片（设计 §4.6 的可见性、§10 的「排队 N」）：目标那一侧
 * 的人要看得见排在自己终端前面的是什么，并且能拒收一条。
 */
describe("GET /api/workspaces/{id}/deliveries?node=", () => {
  function queueRow(
    id: string,
    target: string,
    patch: Partial<{ source: string; state: string; reason: string }> = {},
  ): void {
    const now = Math.floor(Date.now() / 1000);
    fixture.database
      .prepare(
        "INSERT INTO agent_send_queue (id, workspace_id, source_node_id, target_node_id, origin, " +
          "message_key, body, hops, trail, created_at, expires_at, attempts, state, last_reason) " +
          "VALUES (?, ?, ?, ?, 'send', NULL, ?, 1, '[]', ?, ?, 0, ?, ?)",
      )
      .run(
        id,
        fixture.workspaceId,
        patch.source ?? "planner",
        target,
        "请你看一眼",
        now,
        now + 300,
        patch.state ?? "queued",
        patch.reason ?? null,
      );
  }

  it("列出排在这个目标前面的那些，带位置与理由，不带正文", async () => {
    const target = fixture.agentNode("Codex", "codex");
    queueRow("q-1", target, { reason: "LEASE_HELD_BY_HUMAN" });
    queueRow("q-2", target);
    queueRow("q-other", "somebody-else");
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/deliveries?node=${target}`,
    );
    expect(answer.status).toBe(200);
    const rows = answer.body as Record<string, unknown>[];
    expect(rows.map((row) => row.id)).toEqual(["q-1", "q-2"]);
    expect(rows[0]).toMatchObject({
      position: 1,
      bodyChars: 5,
      reason: "LEASE_HELD_BY_HUMAN",
    });
    expect(JSON.stringify(rows)).not.toContain("请你看一眼");
  });

  it("人拒收一条还排着的；已经在投的那条收不回来", async () => {
    const target = fixture.agentNode("Codex", "codex");
    queueRow("q-1", target);
    queueRow("q-2", target, { state: "delivering" });
    const cancelled = await fixture.call(
      "DELETE",
      `/api/workspaces/${fixture.workspaceId}/deliveries/q-1`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true });

    const late = await fixture.call(
      "DELETE",
      `/api/workspaces/${fixture.workspaceId}/deliveries/q-2`,
    );
    expect(late.body).toEqual({ cancelled: false });

    const rest = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/deliveries?node=${target}`,
    );
    expect((rest.body as { id: string }[]).map((row) => row.id)).toEqual([
      "q-2",
    ]);
  });

  it("别的工作空间的 id 删不掉这一条", async () => {
    const target = fixture.agentNode("Codex", "codex");
    queueRow("q-1", target);
    const answer = await fixture.call(
      "DELETE",
      "/api/workspaces/nope/deliveries/q-1",
    );
    expect(answer.status).toBe(404);
  });
});

describe("POST /api/control/confirm/{requestId}", () => {
  it("says the dialog was too late rather than failing", async () => {
    const answer = await fixture.call(
      "POST",
      "/api/control/confirm/never-minted",
      { approve: true },
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      requestId: "never-minted",
      approve: true,
      accepted: false,
    });
  });

  it("refuses a body that does not say yes or no", async () => {
    const answer = await fixture.call("POST", "/api/control/confirm/x", {});
    expect(answer.status).toBe(400);
  });
});

describe("the handoff routes", () => {
  it("prepares, previews, accepts and lists over HTTP", async () => {
    const source = fixture.agentNode("Source");
    const target = fixture.agentNode("Target", "codex");
    fixture.link(source, target);
    const sourceSession = fixture.session(source, "claude");
    const targetSession = fixture.session(target, "codex");

    const prepared = await fixture.call(
      "POST",
      `/api/workspaces/${fixture.workspaceId}/handoffs`,
      {
        sourceNodeId: source,
        sourceSessionId: sourceSession,
        sourceGeneration: 1,
        targetNodeId: target,
        targetSessionId: targetSession,
        targetGeneration: 1,
        sections: { goal: "finish it" },
        byteBudget: 8192,
        includeTranscript: false,
      },
    );
    expect(prepared.status).toBe(200);
    const view = prepared.body as {
      bundle: { handoffId: string };
      digest: string;
    };

    const fetched = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/handoffs/${view.bundle.handoffId}`,
    );
    expect(fetched.status).toBe(200);

    const accepted = await fixture.call(
      "POST",
      `/api/workspaces/${fixture.workspaceId}/handoffs/${view.bundle.handoffId}/accept`,
      { expectedDigest: view.digest },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: "queued", attempts: 1 });

    const listed = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/handoffs`,
    );
    expect(listed.body).toHaveLength(1);
    const forNode = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/handoffs?sourceNodeId=${target}`,
    );
    // Both directions: a target sees what was addressed to it.
    expect(forNode.body).toHaveLength(1);

    const cancelled = await fixture.call(
      "POST",
      `/api/workspaces/${fixture.workspaceId}/handoffs/${view.bundle.handoffId}/cancel`,
      {
        expectedDigest: (accepted.body as { digest: string }).digest,
      },
    );
    expect(cancelled.body).toMatchObject({ state: "cancelled" });
  });

  it("refuses a prepare body that is missing what it needs", async () => {
    const answer = await fixture.call(
      "POST",
      `/api/workspaces/${fixture.workspaceId}/handoffs`,
      { sections: { goal: "x" } },
    );
    expect(answer.status).toBe(400);
  });

  it("answers 404 for a handoff that is not in this workspace", async () => {
    const answer = await fixture.call(
      "GET",
      `/api/workspaces/${fixture.workspaceId}/handoffs/nope`,
    );
    expect(answer.status).toBe(404);
  });
});
