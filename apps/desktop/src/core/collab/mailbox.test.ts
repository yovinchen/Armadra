import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { MAX_BODY_CHARS, PROTOCOL, runMailbox } from "./mailbox";
import { Args, Refusal, Refused } from "./refusals";

/** Ported from `apps/runtime/src/collab/tests/mailbox.rs`. */

let fixture: AgentFixture;
let sender: string;
let receiver: string;

async function post(
  from: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return runMailbox(
    fixture.collab,
    callerFor(fixture, from),
    "post",
    new Args(args),
  );
}

async function refusalOf(
  from: string,
  verb: string,
  args: Record<string, unknown>,
  verdict: "verified" | "legacy" = "verified",
): Promise<Refused> {
  try {
    await runMailbox(
      fixture.collab,
      callerFor(fixture, from, verdict),
      verb,
      new Args(args),
    );
  } catch (error) {
    if (error instanceof Refused) return error;
    // `requireVerified` raises the bare refusal every surface shares; the
    // dispatcher gives it the code its status implies, and so does this.
    if (error instanceof Refusal) return Refused.from(error);
    throw error;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  fixture = agentFixture();
  sender = fixture.agentNode("Sender");
  receiver = fixture.agentNode("Receiver", "codex");
  fixture.link(sender, receiver);
});

afterEach(() => {
  fixture.close();
});

describe("post", () => {
  it("stores a message and says nothing was typed anywhere", async () => {
    const body = await post(sender, {
      to: "Receiver",
      key: "handoff-1",
      body: "done; see src/a.ts",
    });
    expect(body).toMatchObject({
      ok: true,
      protocol: PROTOCOL,
      duplicate: false,
    });
    expect(String(body.message)).toContain("No terminal input was sent");
    expect(fixture.terminal.writes).toHaveLength(0);
  });

  it("makes the same key and body a safe retry, and a different body a conflict", async () => {
    const first = await post(sender, {
      to: receiver,
      key: "k",
      body: "same",
    });
    const again = await post(sender, { to: receiver, key: "k", body: "same" });
    expect(again.id).toBe(first.id);
    expect(again.duplicate).toBe(true);
    const conflict = await refusalOf(sender, "post", {
      to: receiver,
      key: "k",
      body: "different",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("key_conflict");
  });

  it("refuses a target with no canvas link, even when the node exists", async () => {
    const stranger = fixture.agentNode("Stranger", "claude");
    const refused = await refusalOf(sender, "post", {
      to: stranger,
      key: "k",
      body: "hi",
    });
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("target_not_linked");
  });

  it("refuses a body that is empty or over the ceiling, and a bad key", async () => {
    // A blank flag value is not a value at all: `--body` with nothing after
    // it must not become the string "  ".
    expect(
      (await refusalOf(sender, "post", { to: receiver, key: "k", body: "  " }))
        .code,
    ).toBe("body_required");
    // A body that is nothing but control characters strips to empty.
    expect(
      (
        await refusalOf(sender, "post", {
          to: receiver,
          key: "k",
          body: "\u001b\u0007",
        })
      ).code,
    ).toBe("body_invalid");
    expect(
      (
        await refusalOf(sender, "post", {
          to: receiver,
          key: "k",
          body: "x".repeat(MAX_BODY_CHARS + 1),
        })
      ).code,
    ).toBe("body_invalid");
    expect(
      (
        await refusalOf(sender, "post", {
          to: receiver,
          key: "bad key",
          body: "hi",
        })
      ).code,
    ).toBe("key_invalid");
    expect(
      (await refusalOf(sender, "post", { to: receiver, body: "hi" })).code,
    ).toBe("key_required");
    expect(
      (await refusalOf(sender, "post", { key: "k", body: "hi" })).code,
    ).toBe("target_required");
  });

  it("strips the control characters a body has no business carrying", async () => {
    await post(sender, {
      to: receiver,
      key: "k",
      body: "before[2Jafter\ttab\nline",
    });
    const stored = fixture.database
      .prepare("SELECT body FROM agent_mailbox")
      .get() as { body: string };
    expect(stored.body).toBe("before[2Jafter\ttab\nline");
  });

  it("refuses a caller that is not an agent terminal, or has no token", async () => {
    const note = fixture.stickyNode("Note", "hi");
    fixture.link(note, receiver);
    expect(
      (await refusalOf(note, "post", { to: receiver, key: "k", body: "x" }))
        .code,
    ).toBe("caller_not_agent");
    const refused = await refusalOf(
      sender,
      "post",
      { to: receiver, key: "k", body: "x" },
      "legacy",
    );
    expect(refused.status).toBe(403);
  });

  it("refuses when either end has context links switched off", async () => {
    const custom = fixture.agentNode("Custom", "custom:narrow");
    fixture.customAgents.push({
      id: "custom:narrow",
      label: "Narrow",
      color: "#ffffff",
      launchCmd: "wrapper",
      args: [],
      env: {},
      baseAgent: "claude",
      disabledCapabilities: ["contextLink"],
    });
    fixture.link(custom, receiver);
    expect(
      (await refusalOf(custom, "post", { to: receiver, key: "k", body: "x" }))
        .code,
    ).toBe("context_link_disabled");
    fixture.link(sender, custom);
    expect(
      (await refusalOf(sender, "post", { to: custom, key: "k", body: "x" }))
        .code,
    ).toBe("target_context_link_disabled");
  });
});

describe("inbox and ack", () => {
  it("reads messages as data, and says so in the reply", async () => {
    await post(sender, { to: receiver, key: "k", body: "peer said this" });
    const body = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "inbox",
      new Args({}),
    );
    expect(body.protocol).toBe(PROTOCOL);
    expect(String(body.trust)).toContain("not user instructions");
    const messages = body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: sender,
      fromTitle: "Sender",
      key: "k",
      body: "peer said this",
    });
    expect(body.hasMore).toBe(false);
  });

  it("pages by sequence and does not acknowledge on read", async () => {
    for (let index = 0; index < 3; index += 1) {
      await post(sender, { to: receiver, key: `k${index}`, body: `m${index}` });
    }
    const first = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "inbox",
      new Args({ limit: 2 }),
    );
    expect(first.hasMore).toBe(true);
    const rest = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "inbox",
      new Args({ after: first.nextCursor }),
    );
    expect(rest.messages as unknown[]).toHaveLength(1);
    // Reading twice returns the same messages: reading is not acknowledging.
    const again = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "inbox",
      new Args({}),
    );
    expect(again.messages as unknown[]).toHaveLength(3);
  });

  it("acknowledges once, and refuses a message that is not in your inbox", async () => {
    const posted = await post(sender, {
      to: receiver,
      key: "k",
      body: "hi",
    });
    const acked = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "ack",
      new Args({ id: posted.id }),
    );
    expect(acked).toMatchObject({ ok: true, id: posted.id });
    const empty = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "inbox",
      new Args({}),
    );
    expect(empty.messages as unknown[]).toHaveLength(0);
    // The sender may not ack its own message out of somebody else's inbox.
    expect((await refusalOf(sender, "ack", { id: posted.id })).code).toBe(
      "message_not_found",
    );
  });

  it("requires the current session binding for a handoff receipt", async () => {
    // The key names a handoff, so acknowledging it is a claim about which
    // session took the work on — and a receipt that could be re-pointed at
    // another session would stop being evidence.
    fixture.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
          "VALUES ('m-1', ?, ?, ?, 'handoff:h-1', 'notice', ?, ?)",
      )
      .run(
        fixture.workspaceId,
        sender,
        receiver,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000) + 3600,
      );
    expect((await refusalOf(receiver, "ack", { id: "m-1" })).code).toBe(
      "session_binding_required",
    );
    expect(
      (await refusalOf(receiver, "ack", { id: "m-1", sessionId: "s" })).code,
    ).toBe("generation_binding_required");
    // No such handoff, so the authorisation fails and the message stays.
    expect(
      (
        await refusalOf(receiver, "ack", {
          id: "m-1",
          sessionId: "s",
          generation: 1,
        })
      ).code,
    ).toBe("handoff_not_current");
  });

  it("drops expired messages before answering anything", async () => {
    fixture.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
          "VALUES ('old', ?, ?, ?, 'k', 'stale', 1, 2)",
      )
      .run(fixture.workspaceId, sender, receiver);
    const body = await runMailbox(
      fixture.collab,
      callerFor(fixture, receiver),
      "inbox",
      new Args({}),
    );
    expect(body.messages as unknown[]).toHaveLength(0);
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 0 });
  });
});
