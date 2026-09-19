import { afterEach, describe, expect, it } from "vitest";
import { install as installSettings, settingsDomain } from "../settings";
import { uuidV7 } from "../workspaces/support";
import { type HookFixture, hookFixture, insertSession } from "./fixture";
import { getApproval } from "./store";

/**
 * The wire contract: what a report persists, broadcasts and leaves unread.
 *
 * Ported from `apps/runtime/src/hook/tests/{auth,reports}.rs`, against the
 * same payloads.
 */

let open: HookFixture[] = [];

function fixture(withSettings = false): HookFixture {
  const made = hookFixture(withSettings ? [installSettings] : []);
  open.push(made);
  return made;
}

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

function types(fixture: HookFixture): string[] {
  return fixture.published.map((event) => event.type);
}

describe("the bearer and the per-node token", () => {
  it("gates every hook route with the bearer", async () => {
    const it_ = fixture();

    // No bearer at all.
    expect((await it_.postHook("claude", { nodeId: it_.nodeId }, {})).status)
      .toBe(403);
    // The client sends the header even when the endpoint file had no token.
    expect(
      (
        await it_.postHook(
          "claude",
          { nodeId: it_.nodeId },
          { "x-armadra-hook-token": "" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await it_.postHook(
          "claude",
          { nodeId: it_.nodeId },
          { "x-armadra-hook-token": "not-the-token" },
        )
      ).status,
    ).toBe(403);

    const verify = async (
      token: string | undefined,
    ): Promise<number> =>
      (
        (await it_.server.router.dispatch("GET", "/verify", {
          method: "GET",
          path: "/verify",
          query: new URLSearchParams(),
          headers:
            token === undefined ? {} : { "x-armadra-hook-token": token },
          body: Buffer.alloc(0),
          raw: undefined as never,
          json: <T>() => null as T,
        })) as { status: number }
      ).status;
    expect(await verify(it_.bearer)).toBe(204);
    expect(await verify(undefined)).toBe(403);
  });

  it("refuses a forged node token and treats a missing one as legacy", async () => {
    const it_ = fixture();
    const good = it_.service.issueNodeToken(it_.nodeId);
    const kid = good.slice(0, good.indexOf("."));

    // Our key id, wrong MAC: someone is guessing.
    expect(
      (
        await it_.postHook(
          "claude",
          {
            nodeId: it_.nodeId,
            payload: { hook_event_name: "Stop" },
          },
          {
            "x-armadra-hook-token": it_.bearer,
            "x-armadra-node-token": `${kid}.wrong`,
          },
        )
      ).status,
    ).toBe(403);
    expect(it_.status(), "nothing was written").toBeUndefined();

    // No node token at all: accepted, but flagged unverified.
    expect(
      (
        await it_.postHook(
          "claude",
          {
            nodeId: it_.nodeId,
            payload: { hook_event_name: "UserPromptSubmit" },
          },
          { "x-armadra-hook-token": it_.bearer },
        )
      ).status,
    ).toBe(204);
    const status = it_.status();
    expect(status?.state).toBe("working");
    expect(status?.verified).toBe(false);

    // With the real token the row is verified.
    expect(await it_.report({ hook_event_name: "Stop" })).toBe(204);
    expect(it_.status()?.verified).toBe(true);
  });
});

describe("what a report persists and broadcasts", () => {
  /**
   * 协作通道 §3.2. The source is stamped by the route from the provider,
   * stored on the row and published with it, so a client can draw "done (as
   * reported by a hook)" apart from "done, as far as the output pump can
   * tell". The payload cannot name its own channel.
   */
  it("records the channel a report arrived on and publishes it", async () => {
    const it_ = fixture();
    expect(await it_.report({ hook_event_name: "UserPromptSubmit" })).toBe(204);
    const status = it_.status();
    expect(status?.state).toBe("working");
    expect(status?.stateSource).toBe("hook");

    const published = it_.published.find(
      (event) => event.type === "agent.status",
    ) as { status: { stateSource?: string } } | undefined;
    expect(published?.status.stateSource).toBe("hook");

    // A body that says otherwise is not consulted: the route derives the
    // source from the provider it was posted to.
    expect(
      await it_.report({
        hook_event_name: "Stop",
        stateSource: "extension",
      }),
    ).toBe(204);
    expect(it_.status()?.stateSource).toBe("hook");
  });

  it("persists a turn, broadcasts it and leaves the node unread", async () => {
    const it_ = fixture();
    expect(
      await it_.report({
        hook_event_name: "SessionStart",
        session_id: "s-1",
        transcript_path: "/tmp/t.jsonl",
      }),
    ).toBe(204);
    const first = it_.published[0] as {
      type: string;
      status: Record<string, unknown>;
    };
    expect(first.type).toBe("agent.status");
    expect(first.status.nodeId).toBe(it_.nodeId);
    expect(first.status.sessionId).toBe("s-1");
    expect("state" in first.status, "a fresh session is idle").toBe(false);

    await it_.report({ hook_event_name: "UserPromptSubmit" });
    await it_.report({
      hook_event_name: "Stop",
      last_assistant_message: "all done",
    });

    const status = it_.status();
    expect(status?.state).toBe("done");
    expect(status?.unread).toBe(true);
    expect(status?.sessionId).toBe("s-1");
    expect(status?.transcriptPath).toBe("/tmp/t.jsonl");
    expect(status?.lastEventAt).toBeDefined();

    // The published copy carries the CLI's last message; the row does not.
    const done = it_.published
      .filter(
        (event): event is { type: "agent.status"; status: AnyStatus } =>
          event.type === "agent.status",
      )
      .map((event) => event.status)
      .filter((one) => one.state === "done")
      .at(-1);
    expect(done?.lastMessage).toBe("all done");
    expect(status?.lastMessage).toBeUndefined();
  });

  /**
   * The web pill needs to tell a failed turn from a clean one, so `errored`
   * and `interrupted` have to survive the reducer, SQLite and the broadcast.
   */
  it("makes a failed turn distinguishable on the wire", async () => {
    const it_ = fixture();
    await it_.report({ hook_event_name: "UserPromptSubmit" });
    // A turn in flight has no verdict at all.
    expect(it_.status()?.errored).toBeUndefined();
    expect(it_.status()?.interrupted).toBeUndefined();

    it_.published.length = 0;
    await it_.report({ hook_event_name: "StopFailure" });
    const failed = it_.status();
    expect(failed?.state).toBe("done");
    expect(failed?.errored).toBe(true);
    expect(failed?.interrupted).toBe(false);
    const event = it_.published[0] as { status: AnyStatus };
    expect(event.status.errored).toBe(true);
    expect(event.status.interrupted).toBe(false);

    // The next turn clears the verdict rather than leaving TURN FAILED up.
    it_.published.length = 0;
    await it_.report({ hook_event_name: "UserPromptSubmit" });
    expect(it_.status()?.errored, "the verdict belongs to the old turn")
      .toBeUndefined();
    expect(
      "errored" in (it_.published[0] as { status: AnyStatus }).status,
    ).toBe(false);

    // And a clean Stop says so explicitly.
    await it_.report({ hook_event_name: "Stop" });
    expect(it_.status()?.errored).toBe(false);
    expect(it_.status()?.interrupted).toBe(false);
  });

  it("turns a permission request into a pending approval", async () => {
    const it_ = fixture();
    const token = it_.service.issueNodeToken(it_.nodeId);
    const answer = await it_.postHook(
      "claude",
      {
        nodeId: it_.nodeId,
        pendingId: "pend-1",
        payload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "rm -rf ." },
        },
      },
      {
        "x-armadra-hook-token": it_.bearer,
        "x-armadra-node-token": token,
      },
    );
    expect(answer.status).toBe(204);

    const status = it_.status();
    expect(status?.state).toBe("blocked");
    expect(status?.pendingId).toBe("pend-1");

    const approval = getApproval(it_.core.database, "pend-1");
    const request = approval?.request as Record<string, unknown>;
    expect(request.tool_name).toBe("Bash");
    expect((request.tool_input as { command: string }).command).toBe("rm -rf .");
    expect(approval?.answer).toBeUndefined();

    expect(types(it_)).toContain("agent.approval");
    expect(types(it_)).toContain("agent.status");
  });

  it("broadcasts subagent events without touching the row", async () => {
    const it_ = fixture();
    await it_.report({ hook_event_name: "UserPromptSubmit" });
    it_.published.length = 0;

    await it_.report({
      hook_event_name: "SubagentStart",
      tool_use_id: "tu-1",
      subagent_type: "Explore",
    });
    const event = it_.published[0] as {
      type: string;
      event: Record<string, unknown>;
    };
    expect(event.type).toBe("agent.subagent");
    expect(event.event.kind).toBe("subagent-start");
    expect(event.event.subagentType).toBe("Explore");
    expect(it_.status()?.state, "the parent is unchanged").toBe("working");
  });

  it("accepts and drops the reports it cannot place", async () => {
    const it_ = fixture();
    const headers = { "x-armadra-hook-token": it_.bearer };

    // Unknown node.
    expect(
      (
        await it_.postHook(
          "claude",
          {
            nodeId: "00000000-0000-4000-8000-000000000000",
            payload: { hook_event_name: "Stop" },
          },
          headers,
        )
      ).status,
    ).toBe(204);
    // A node id that could escape the token directory.
    expect(
      (
        await it_.postHook(
          "claude",
          { nodeId: "../../etc", payload: { hook_event_name: "Stop" } },
          headers,
        )
      ).status,
    ).toBe(204);
    // Non-JSON stdin, wrapped by the client.
    expect(
      (
        await it_.postHook(
          "claude",
          {
            nodeId: it_.nodeId,
            payload: { raw: "a banner line", truncated: true },
          },
          headers,
        )
      ).status,
    ).toBe(204);
    // An event we never subscribed to.
    expect(
      (
        await it_.postHook(
          "claude",
          {
            nodeId: it_.nodeId,
            payload: { hook_event_name: "PreCompact" },
          },
          headers,
        )
      ).status,
    ).toBe(204);
    expect(it_.status(), "none of those wrote a row").toBeUndefined();
  });

  /**
   * A terminal is created before the board save that adds its node
   * necessarily lands, so a brand-new agent's `SessionStart` routinely
   * arrives while the node row is still in flight. Requiring node existence
   * here would drop it — the sweep can afford that guard because it is a
   * background correction with no deadline; a hook cannot.
   */
  it("accepts a real report for a node the board has not saved yet", async () => {
    const it_ = fixture();
    const orphan = uuidV7();
    it_.core.database
      .prepare(
        "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, kind, owner_node_id, " +
          "agent_id, status, created_at, session_key, backend_kind, generation, attach_state) " +
          "VALUES ('sess-1', ?, '/tmp', 'sh', 'terminal', ?, 'claude', 'running', ?, ?, 'direct', 0, 'live')",
      )
      .run(it_.workspaceId, orphan, new Date().toISOString(), orphan);
    expect(
      it_.core.database
        .prepare("SELECT 1 FROM nodes WHERE id = ?")
        .get(orphan),
      "the node row has not landed yet",
    ).toBeUndefined();

    const token = it_.service.issueNodeToken(orphan);
    expect(
      (
        await it_.postHook(
          "claude",
          {
            nodeId: orphan,
            payload: { hook_event_name: "SessionStart", session_id: "s-1" },
          },
          {
            "x-armadra-hook-token": it_.bearer,
            "x-armadra-node-token": token,
          },
        )
      ).status,
    ).toBe(204);
    const row = it_.core.database
      .prepare("SELECT session_id FROM agent_status WHERE node_id = ?")
      .get(orphan) as { session_id: string } | undefined;
    expect(row?.session_id, "a real report is never dropped for want of a node row")
      .toBe("s-1");
  });

  /**
   * Copilot end to end on its own path — 协作通道 §5.2. Worth its own route
   * test because Copilot is the one provider whose payload does not name its
   * event: a normalizer that regressed to "look for `hook_event_name`" would
   * pass every unit test in isolation and leave the node blank here.
   */
  it("understands a Copilot turn from its shape alone", async () => {
    const it_ = fixture();
    const token = it_.service.issueNodeToken(it_.nodeId);
    const kid = token.slice(0, token.indexOf("."));
    const verified = {
      "x-armadra-hook-token": it_.bearer,
      "x-armadra-node-token": token,
    };
    const legacy = { "x-armadra-hook-token": it_.bearer };
    const forged = {
      "x-armadra-hook-token": it_.bearer,
      "x-armadra-node-token": `${kid}.wrong`,
    };
    const body = (payload: unknown): unknown => ({
      nodeId: it_.nodeId,
      version: 1,
      payload,
    });

    // `prompt` and nothing else identifies the event.
    expect(
      (
        await it_.postHook(
          "copilot",
          body({ sessionId: "s-1", cwd: "/repo", prompt: "echo hello" }),
          verified,
        )
      ).status,
    ).toBe(204);
    let status = it_.status();
    expect(status?.agentId).toBe("copilot");
    expect(status?.state).toBe("working");
    expect(status?.stateSource).toBe("hook");
    expect(status?.verified).toBe(true);

    // `stopReason` + `stop_hook_active` is `agentStop`, and it is the only
    // event that reports where the session's transcript lives.
    expect(
      (
        await it_.postHook(
          "copilot",
          body({
            sessionId: "s-1",
            cwd: "/repo",
            transcriptPath:
              "/home/dev/.copilot/session-state/s-1/events.jsonl",
            stopReason: "end_turn",
            stop_hook_active: false,
          }),
          verified,
        )
      ).status,
    ).toBe(204);
    status = it_.status();
    expect(status?.state).toBe("done");
    expect(status?.sessionId).toBe("s-1");
    expect(status?.transcriptPath).toBe(
      "/home/dev/.copilot/session-state/s-1/events.jsonl",
    );
    expect(status?.unread).toBe(true);

    // No node token: accepted as a status report, but not verified.
    expect(
      (
        await it_.postHook(
          "copilot",
          body({ sessionId: "s-1", cwd: "/repo", prompt: "again" }),
          legacy,
        )
      ).status,
    ).toBe(204);
    expect(it_.status()?.verified).toBe(false);

    // Our key id with a wrong MAC is a forgery, and nothing it says lands.
    expect(
      (
        await it_.postHook(
          "copilot",
          body({ sessionId: "s-1", stopReason: "end_turn" }),
          forged,
        )
      ).status,
    ).toBe(403);
    expect(it_.status()?.state).toBe("working");

    // A permission prompt is on screen: the one `notification_type` with a
    // primary source behind it.
    expect(
      (
        await it_.postHook(
          "copilot",
          body({
            sessionId: "s-1",
            hook_event_name: "Notification",
            message: "Copilot needs permission",
            notification_type: "permission_prompt",
          }),
          verified,
        )
      ).status,
    ).toBe(204);
    expect(it_.status()?.state).toBe("waiting");

    // The same event carrying a type nobody has documented moves nothing.
    expect(
      (
        await it_.postHook(
          "copilot",
          body({
            sessionId: "s-1",
            hook_event_name: "Notification",
            notification_type: "shell_completion",
          }),
          verified,
        )
      ).status,
    ).toBe(204);
    expect(it_.status()?.state).toBe("waiting");
  });
});

describe("custom agents", () => {
  it("does not process a custom agent whose hooks capability is off", async () => {
    const it_ = fixture(true);
    settingsDomain()?.settings.patch({
      agents: {
        custom: [
          {
            id: "custom:narrow",
            label: "Narrow",
            launchCmd: "wrapper",
            baseAgent: "claude",
            disabledCapabilities: ["hooks"],
          },
        ],
      },
    });
    insertSession(it_, {
      id: "sess-1",
      status: "running",
      agentId: "custom:narrow",
    });
    const token = it_.service.issueNodeToken(it_.nodeId);
    expect(
      (
        await it_.postHook(
          "custom:narrow",
          { nodeId: it_.nodeId, payload: { hook_event_name: "Stop" } },
          {
            "x-armadra-hook-token": it_.bearer,
            "x-armadra-node-token": token,
          },
        )
      ).status,
    ).toBe(204);
    expect(it_.status()).toBeUndefined();
  });

  /**
   * A custom agent has no hooks of its own: the hook line the installer wrote
   * runs `armadra-hook <base>`, so the report arrives on the *base* provider's
   * path while the node is a `custom:` one. The node must keep its own id and
   * the payload must be read with the base's vocabulary (contract §24.1).
   */
  it("reports a custom agent through its base provider", async () => {
    const it_ = fixture(true);
    settingsDomain()?.settings.patch({
      agents: {
        custom: [
          {
            id: "custom:echo",
            label: "Echo",
            launchCmd: "/bin/echo",
            baseAgent: "copilot",
          },
        ],
      },
    });
    // The session row is what tells the ingest which agent owns the node.
    insertSession(it_, {
      id: "sess-1",
      status: "running",
      agentId: "custom:echo",
    });

    const token = it_.service.issueNodeToken(it_.nodeId);
    // Copilot's vocabulary on Copilot's path — the Claude adapter reads
    // nothing out of `agentStop`, so a `done` here proves the base picked the
    // parser.
    expect(
      (
        await it_.postHook(
          "copilot",
          { nodeId: it_.nodeId, payload: { hookEventName: "agentStop" } },
          {
            "x-armadra-hook-token": it_.bearer,
            "x-armadra-node-token": token,
          },
        )
      ).status,
    ).toBe(204);
    const status = it_.status();
    expect(status?.agentId).toBe("custom:echo");
    expect(status?.state).toBe("done");
  });
});

type AnyStatus = Record<string, unknown>;
