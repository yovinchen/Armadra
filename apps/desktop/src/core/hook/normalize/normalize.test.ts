import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  BLOCKED,
  DONE,
  WAITING,
  WORKING,
  flag,
  newEvent,
  normalize,
  normalizeAs,
  number,
  serializeEvent,
  stateEvent,
  text,
  truncate,
} from "./index";

/**
 * Every provider's payload → event mapping, driven from the payloads the
 * Rust adapters were verified against.
 */

function claude(payload: unknown): AgentEvent | undefined {
  return normalize("claude", "node-a", payload);
}

function codex(payload: unknown): AgentEvent | undefined {
  return normalize("codex", "node-a", payload);
}

function copilot(payload: unknown): AgentEvent | undefined {
  return normalize("copilot", "node-a", payload);
}

function opencode(payload: unknown): AgentEvent | undefined {
  return normalize("opencode", "node-a", payload);
}

function pi(payload: unknown): AgentEvent | undefined {
  return normalize("pi", "node-a", payload);
}

describe("the shared event shape", () => {
  it("serializes with the shared field names", () => {
    const event = stateEvent("node-a", "claude", DONE);
    event.errored = true;
    event.sessionId = "s-1";
    const json = serializeEvent(event);
    expect(json.nodeId).toBe("node-a");
    expect(json.agentId).toBe("claude");
    expect(json.kind).toBe("state");
    expect(json.state).toBe("done");
    expect(json.errored).toBe(true);
    expect(json.sessionId).toBe("s-1");
    // Absent optionals are omitted, never null.
    expect("newTurn" in json).toBe(false);
    expect("pendingId" in json).toBe(false);
    expect("interrupted" in json).toBe(false);

    expect(serializeEvent(newEvent("node-a", "claude", "subagent-start")).kind)
      .toBe("subagent-start");
    expect(serializeEvent(newEvent("n", "claude", "subagent-end")).kind).toBe(
      "subagent-end",
    );
  });

  it("tolerates both casings and rejects blanks in the accessors", () => {
    const payload = {
      session_id: "  s-1  ",
      toolUseId: "t-1",
      empty: "   ",
      duration: 120,
      async: true,
      nulled: null,
    };
    expect(text(payload, "session_id", "sessionId")).toBe("s-1");
    expect(text(payload, "tool_use_id", "toolUseId")).toBe("t-1");
    expect(text(payload, "empty", "empty")).toBeUndefined();
    expect(text(payload, "nulled", "nulled")).toBeUndefined();
    expect(text(payload, "missing", "missing")).toBeUndefined();
    expect(number(payload, "duration", "duration")).toBe(120);
    expect(flag(payload, "async", "async")).toBe(true);
  });

  it("cuts long messages on a code-point boundary", () => {
    const long = "汉".repeat(20_050);
    expect([...truncate(long, 20_000)]).toHaveLength(20_000);
    expect(truncate("short", 20_000)).toBe("short");
  });

  it("falls back to the Claude shape for an unknown provider", () => {
    const event = normalize("custom:wrapper", "node-a", {
      hook_event_name: "Stop",
    });
    expect(event?.state).toBe(DONE);
    expect(event?.agentId).toBe("custom:wrapper");
    expect(normalize("custom:wrapper", "node-a", { nope: 1 })).toBeUndefined();
  });

  it("parses a custom agent as its base and attributes it to itself", () => {
    // Copilot's vocabulary, not Claude's: the fallback parser would find
    // nothing here, so this only passes if the base picked the parser.
    const event = normalizeAs("copilot", "custom:wrapper", "node-a", {
      hookEventName: "agentStop",
    });
    expect(event?.agentId).toBe("custom:wrapper");
    expect(event?.state).toBe(DONE);
    expect(
      normalize("custom:wrapper", "node-a", { hookEventName: "agentStop" }),
    ).toBeUndefined();
  });
});

describe("Claude Code payloads", () => {
  it("runs a turn from prompt to stop", () => {
    const start = claude({
      hook_event_name: "SessionStart",
      session_id: "s-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      source: "startup",
    });
    expect(start?.kind).toBe("session");
    expect(start?.sessionPhase).toBe("start");
    expect(start?.sessionId).toBe("s-1");
    expect(start?.transcriptPath).toBe("/tmp/t.jsonl");
    expect(start?.state).toBeUndefined();

    const prompt = claude({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-1",
      prompt: "ship it",
    });
    expect(prompt?.state).toBe(WORKING);
    expect(prompt?.newTurn).toBe(true);
    expect(prompt?.lastMessage).toBe("ship it");

    for (const hook of ["PreToolUse", "PostToolUse"]) {
      const event = claude({
        hook_event_name: hook,
        tool_name: "Bash",
        tool_use_id: "tu-1",
      });
      expect(event?.state, hook).toBe(WORKING);
      expect(event?.toolUseId).toBe("tu-1");
      expect(event?.newTurn).toBeUndefined();
    }

    const stop = claude({
      hook_event_name: "Stop",
      last_assistant_message: "done here",
    });
    expect(stop?.state).toBe(DONE);
    expect(stop?.lastMessage).toBe("done here");
    expect(stop?.errored).toBeUndefined();

    const failure = claude({ hook_event_name: "StopFailure" });
    expect(failure?.state).toBe(DONE);
    expect(failure?.errored).toBe(true);

    expect(
      claude({ hook_event_name: "SessionEnd", reason: "exit" })?.sessionPhase,
    ).toBe("end");
  });

  it("keeps permission requests and questions in different states", () => {
    const permission = claude({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    expect(permission?.state).toBe(BLOCKED);
    expect(permission?.askKind).toBe("Bash");

    const question = claude({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
    });
    expect(question?.state).toBe(WAITING);
    expect(question?.awaitingInput).toBe(true);
    expect(question?.askKind).toBe("AskUserQuestion");
  });

  it("splits notifications into permission, idle and noise", () => {
    const permission = claude({
      hook_event_name: "Notification",
      message: "Claude needs your permission to use Bash",
    });
    expect(permission?.state).toBe(BLOCKED);
    expect(permission?.idle).toBeUndefined();

    const idle = claude({
      hook_event_name: "Notification",
      message: "Claude is waiting for your input",
    });
    expect(idle?.state).toBe(DONE);
    expect(idle?.idle).toBe(true);

    // Anything else is not a state change; guessing would fight the Stop hook.
    expect(
      claude({
        hook_event_name: "Notification",
        message: "Compacting conversation history",
      }),
    ).toBeUndefined();
  });

  it("carries identity and totals on subagent events", () => {
    const start = claude({
      hook_event_name: "SubagentStart",
      tool_use_id: "tu-9",
      subagent_type: "Explore",
      description: "find the bug",
    });
    expect(start?.kind).toBe("subagent-start");
    expect(start?.toolUseId).toBe("tu-9");
    expect(start?.subagentType).toBe("Explore");
    expect(start?.taskLabel).toBe("find the bug");
    expect(start?.state, "subagents never carry a main state").toBeUndefined();

    const stop = claude({
      hook_event_name: "SubagentStop",
      tool_use_id: "tu-9",
      duration_ms: 4200,
      total_tokens: 8123,
      total_tool_use_count: 7,
      result: "found it",
    });
    expect(stop?.kind).toBe("subagent-end");
    expect(stop?.durationMs).toBe(4200);
    expect(stop?.tokens).toBe(8123);
    expect(stop?.toolUses).toBe(7);
    expect(stop?.result).toBe("found it");
    expect(stop?.state).toBeUndefined();
  });

  it("ignores unknown and malformed payloads", () => {
    expect(claude({ hook_event_name: "PreCompact" })).toBeUndefined();
    expect(claude({ hook_event_name: "" })).toBeUndefined();
    expect(claude({ nothing: true })).toBeUndefined();
    expect(claude("a bare string")).toBeUndefined();
  });

  it("flags an interrupted turn", () => {
    const event = claude({ hook_event_name: "Stop", interrupted: true });
    expect(event?.interrupted).toBe(true);
    expect(event?.state).toBe(DONE);
  });
});

describe("Codex payloads", () => {
  it("maps the Claude family events the same way", () => {
    expect(
      codex({ hook_event_name: "SessionStart", session_id: "s-1" })
        ?.sessionPhase,
    ).toBe("start");
    const prompt = codex({ hook_event_name: "UserPromptSubmit" });
    expect(prompt?.state).toBe(WORKING);
    expect(prompt?.newTurn).toBe(true);
    expect(
      codex({ hook_event_name: "PreToolUse", tool_name: "shell" })?.state,
    ).toBe(WORKING);
    expect(codex({ hook_event_name: "PostToolUse" })?.state).toBe(WORKING);
    expect(codex({ hook_event_name: "Stop" })?.state).toBe(DONE);
    expect(codex({ hook_event_name: "SessionEnd" })?.sessionPhase).toBe("end");
  });

  it("reads request_user_input as waiting from either direction", () => {
    const byTool = codex({
      hook_event_name: "PreToolUse",
      tool_name: "experimental_request_user_input",
    });
    expect(byTool?.state).toBe(WAITING);
    expect(byTool?.awaitingInput).toBe(true);

    const byNotification = codex({
      hook_event_name: "Notification",
      notification_type: "request_user_input",
      message: "Which branch?",
    });
    expect(byNotification?.state).toBe(WAITING);
    expect(byNotification?.awaitingInput).toBe(true);
    expect(byNotification?.lastMessage).toBe("Which branch?");
  });

  it("blocks on permission requests and flags a failed turn", () => {
    expect(
      codex({ hook_event_name: "PermissionRequest", tool_name: "shell" })
        ?.state,
    ).toBe(BLOCKED);
    expect(
      codex({
        hook_event_name: "Notification",
        message: "Codex needs permission",
      })?.state,
    ).toBe(BLOCKED);
    const failed = codex({ hook_event_name: "Stop", error: "boom" });
    expect(failed?.state).toBe(DONE);
    expect(failed?.errored).toBe(true);
    const interrupted = codex({ hook_event_name: "Interrupt" });
    expect(interrupted?.state).toBe(DONE);
    expect(interrupted?.interrupted).toBe(true);
  });

  it("keys subagents by agent id", () => {
    const start = codex({
      hook_event_name: "SubagentStart",
      agent_id: "ag-7",
      task: "review the diff",
    });
    expect(start?.kind).toBe("subagent-start");
    expect(start?.toolUseId).toBe("ag-7");
    expect(start?.taskLabel).toBe("review the diff");
    expect(start?.state).toBeUndefined();

    const stop = codex({
      hook_event_name: "SubagentStop",
      agent_id: "ag-7",
      duration_ms: 900,
      tokens: 42,
    });
    expect(stop?.kind).toBe("subagent-end");
    expect(stop?.toolUseId).toBe("ag-7");
    expect(stop?.durationMs).toBe(900);
    expect(stop?.tokens).toBe(42);
  });

  it("ignores unknown events and noise notifications", () => {
    expect(codex({ hook_event_name: "PreCompact" })).toBeUndefined();
    expect(
      codex({ hook_event_name: "Notification", message: "hi" }),
    ).toBeUndefined();
    expect(codex({})).toBeUndefined();
  });
});

describe("GitHub Copilot payloads", () => {
  /**
   * The payloads here are the ones Copilot CLI 1.0.83 actually sent during the
   * probe run described in the adapter's module note, field for field.
   */
  it("runs a recorded turn from prompt to stop", () => {
    const start = copilot({
      sessionId: "94d20c9c-212a-4352-bd1e-5e783ccba452",
      timestamp: 1_788_699_265_758,
      cwd: "/repo",
      source: "new",
      initialPrompt: "echo hello",
    });
    expect(start?.kind).toBe("session");
    expect(start?.sessionPhase).toBe("start");
    expect(start?.sessionId).toBe("94d20c9c-212a-4352-bd1e-5e783ccba452");
    expect(start?.state).toBeUndefined();
    // This start arrived 46 ms *after* the prompt below, because that prompt
    // is what created the session.
    expect(start?.sessionOpenedByPrompt).toBe(true);

    const prompt = copilot({
      sessionId: "s-1",
      timestamp: 1_788_699_265_712,
      cwd: "/repo",
      prompt: "echo hello",
    });
    expect(prompt?.state).toBe(WORKING);
    expect(prompt?.newTurn).toBe(true);
    expect(prompt?.lastMessage).toBe("echo hello");

    const tool = copilot({
      sessionId: "s-1",
      cwd: "/repo",
      toolName: "bash",
      toolArgs: { command: "echo hello-from-probe" },
      toolResult: {
        resultType: "success",
        textResultForLlm: "hello-from-probe\n",
      },
    });
    expect(tool?.state).toBe(WORKING);
    expect(tool?.newTurn).toBeUndefined();

    const failure = copilot({
      sessionId: "s-1",
      cwd: "/repo",
      toolName: "bash",
      toolArgs: {},
      error: "exit status 1",
    });
    expect(failure?.state).toBe(WORKING);
    // A tool that failed is not a turn that failed.
    expect(failure?.errored).toBeUndefined();

    const stop = copilot({
      sessionId: "s-1",
      cwd: "/repo",
      transcriptPath: "/home/dev/.copilot/session-state/s-1/events.jsonl",
      stopReason: "end_turn",
      stop_hook_active: false,
    });
    expect(stop?.state).toBe(DONE);
    expect(stop?.errored).toBeUndefined();
    expect(stop?.transcriptPath).toBe(
      "/home/dev/.copilot/session-state/s-1/events.jsonl",
    );

    const end = copilot({ sessionId: "s-1", cwd: "/repo", reason: "complete" });
    expect(end?.kind).toBe("session");
    expect(end?.sessionPhase).toBe("end");
    expect(end?.sessionOpenedByPrompt).toBeFalsy();
  });

  it("does not mark a start without an initial prompt as opened by one", () => {
    const start = copilot({
      sessionId: "s-1",
      timestamp: 1_788_699_265_758,
      cwd: "/repo",
      source: "new",
    });
    expect(start?.sessionPhase).toBe("start");
    expect(start?.sessionOpenedByPrompt).toBe(false);

    // An empty string is not a prompt either.
    const blank = copilot({
      sessionId: "s-1",
      source: "resume",
      initialPrompt: "",
    });
    expect(blank?.sessionOpenedByPrompt).toBe(false);
  });

  it("carries subagent identity without touching the parent state", () => {
    const start = copilot({
      sessionId: "s-1",
      transcriptPath: "/tmp/events.jsonl",
      agentName: "explorer",
      agentDisplayName: "Explorer",
      agentDescription: "find the bug",
    });
    expect(start?.kind).toBe("subagent-start");
    expect(start?.subagentType).toBe("explorer");
    expect(start?.taskLabel).toBe("find the bug");
    expect(start?.state).toBeUndefined();

    const stop = copilot({
      sessionId: "s-1",
      transcriptPath: "/tmp/events.jsonl",
      agentId: "a-9",
      agentType: "explore",
      agentName: "explorer",
      response: "found it",
      stopReason: "end_turn",
    });
    expect(stop?.kind).toBe("subagent-end");
    expect(stop?.toolUseId).toBe("a-9");
    expect(stop?.subagentType).toBe("explore");
    expect(stop?.result).toBe("found it");
    expect(stop?.state).toBeUndefined();
  });

  it("never reads a subagent stop as the parent stopping", () => {
    // `subagentStop` and `agentStop` both say `stopReason: "end_turn"`.
    const event = copilot({
      sessionId: "s-1",
      agentId: "a-9",
      agentName: "explorer",
      response: "found it",
      stopReason: "end_turn",
    });
    expect(event?.kind).toBe("subagent-end");
    expect(event?.state).toBeUndefined();
  });

  it("ends the turn only on an unrecoverable error", () => {
    // The `agentStop` that follows is what ends this turn.
    expect(
      copilot({
        sessionId: "s-1",
        cwd: "/repo",
        error: { message: "socket hang up", name: "FetchError" },
        errorContext: "model_call",
        recoverable: true,
      }),
    ).toBeUndefined();

    const fatal = copilot({
      sessionId: "s-1",
      cwd: "/repo",
      error: { message: "no credentials", name: "AuthError" },
      errorContext: "system",
      recoverable: false,
    });
    expect(fatal?.state).toBe(DONE);
    expect(fatal?.errored).toBe(true);
    expect(fatal?.lastMessage).toBe("no credentials");
  });

  it("says needs-you only for a permission prompt notification", () => {
    const waiting = copilot({
      sessionId: "s-1",
      cwd: "/repo",
      hook_event_name: "Notification",
      message: "Copilot needs permission to run bash",
      notification_type: "permission_prompt",
    });
    expect(waiting?.state).toBe(WAITING);

    // The shape rule reaches the same event without a name, and the camelCase
    // spelling of the discriminator is the same discriminator.
    expect(
      copilot({ sessionId: "s-1", notificationType: "permission_prompt" })
        ?.state,
    ).toBe(WAITING);

    // A shell that finished is not a state.
    expect(
      copilot({
        sessionId: "s-1",
        hook_event_name: "notification",
        notification_type: "shell_completion",
      }),
    ).toBeUndefined();
    // A value nobody has documented is not guessed at either.
    expect(
      copilot({
        sessionId: "s-1",
        notification_type: "permission_prompt_dismissed",
      }),
    ).toBeUndefined();
    // And with no compaction epoch to bump, neither does preCompact.
    expect(
      copilot({
        sessionId: "s-1",
        transcriptPath: "/tmp/events.jsonl",
        trigger: "auto",
        customInstructions: "",
      }),
    ).toBeUndefined();
  });

  it("lets an explicit event name win over the shape", () => {
    // Shape alone would read this as a session start.
    const named = copilot({
      hookEventName: "userPromptSubmitted",
      sessionId: "s-1",
      source: "new",
      prompt: "go",
    });
    expect(named?.state).toBe(WORKING);
    expect(named?.newTurn).toBe(true);

    // The VS Code-compatible aliases fire under the same installer.
    expect(copilot({ hook_event_name: "Stop", sessionId: "s-1" })?.state).toBe(
      DONE,
    );

    // A name we do not know falls back to the shape rather than to nothing.
    expect(
      copilot({ hook_event_name: "SomethingNew", prompt: "go" })?.state,
    ).toBe(WORKING);
  });

  it("ignores payloads that say nothing", () => {
    expect(copilot({ sessionId: "s-1", cwd: "/repo" })).toBeUndefined();
    expect(copilot({ nothing: true })).toBeUndefined();
    expect(copilot("a bare string")).toBeUndefined();
    expect(copilot([])).toBeUndefined();
    // `preToolUse` is never installed (§6); if one arrived anyway it would
    // carry no result and must not be read as a finished tool call.
    expect(
      copilot({
        sessionId: "s-1",
        toolName: "bash",
        toolArgs: { command: "rm -rf /" },
      })?.state,
    ).toBe(WORKING);
  });
});

describe("opencode payloads", () => {
  it("opens a turn on a user message and closes it on idle", () => {
    const user = opencode({
      event: "message.updated",
      properties: { info: { role: "user", sessionID: "oc-1" } },
    });
    expect(user?.state).toBe(WORKING);
    expect(user?.newTurn).toBe(true);
    expect(user?.sessionId).toBe("oc-1");

    // The assistant's own stream must not restart the turn.
    expect(
      opencode({
        event: "message.updated",
        properties: { info: { role: "assistant" } },
      }),
    ).toBeUndefined();

    const idle = opencode({
      event: "session.idle",
      properties: { sessionID: "oc-1" },
    });
    expect(idle?.state).toBe(DONE);
    // `session.idle` is authoritative, not a rescue.
    expect(idle?.idle).toBeUndefined();
  });

  it("matches tool topics by prefix", () => {
    for (const topic of [
      "tool.execute.before",
      "tool.execute.after",
      "tool.registered",
    ]) {
      const event = opencode({ event: topic, properties: {} });
      expect(event?.state, topic).toBe(WORKING);
      expect(event?.newTurn).toBeUndefined();
    }
  });

  it("blocks on permissions and carries their id", () => {
    for (const topic of ["permission.asked", "permission.updated"]) {
      const event = opencode({
        event: topic,
        properties: { id: "perm-9", type: "bash", title: "run tests" },
      });
      expect(event?.state, topic).toBe(BLOCKED);
      expect(event?.pendingId).toBe("perm-9");
      expect(event?.askKind).toBe("bash");
      expect(event?.lastMessage).toBe("run tests");
    }
  });

  it("accepts the topic as `type` and flags errors", () => {
    expect(opencode({ type: "session.idle", properties: {} })?.state).toBe(
      DONE,
    );
    const failed = opencode({
      type: "session.error",
      properties: { error: "provider refused" },
    });
    expect(failed?.errored).toBe(true);
    expect(failed?.lastMessage).toBe("provider refused");
  });

  it("ignores unknown topics and non-JSON stdin", () => {
    expect(
      opencode({ event: "storage.write", properties: {} }),
    ).toBeUndefined();
    expect(opencode({ event: "" })).toBeUndefined();
    expect(opencode({ raw: "opencode printed a banner" })).toBeUndefined();
    expect(opencode([1, 2, 3])).toBeUndefined();
  });
});

describe("Pi and Oh My Pi payloads", () => {
  it("brackets a turn with the agent loop", () => {
    const start = pi({
      hookEventName: "session_start",
      provider: "pi",
      sessionId: "pi-1",
      transcriptPath: "/home/dev/.pi/agent/sessions/--repo--/1_2.jsonl",
      cwd: "/repo",
    });
    expect(start?.kind).toBe("session");
    expect(start?.sessionPhase).toBe("start");
    expect(start?.sessionId).toBe("pi-1");
    expect(start?.transcriptPath).toBe(
      "/home/dev/.pi/agent/sessions/--repo--/1_2.jsonl",
    );

    const before = pi({ hookEventName: "before_agent_start", prompt: "go" });
    expect(before?.state).toBe(WORKING);
    expect(before?.newTurn).toBe(true);
    expect(before?.lastMessage).toBe("go");

    for (const hook of [
      "agent_start",
      "turn_start",
      "turn_end",
      "tool_result",
    ]) {
      const event = pi({ hookEventName: hook });
      expect(event?.state, hook).toBe(WORKING);
      expect(event?.newTurn, hook).toBeUndefined();
    }

    const end = pi({ hookEventName: "agent_end" });
    expect(end?.state).toBe(DONE);
    // `agent_end` is not evidence of idleness.
    expect(end?.idle).toBeUndefined();

    expect(pi({ hookEventName: "session_shutdown" })?.sessionPhase).toBe("end");
  });

  it("claims idleness only on the settle events", () => {
    for (const hook of ["agent_settled", "session_stop"]) {
      const settled = pi({ hookEventName: hook, sessionId: "pi-1" });
      expect(settled?.state, hook).toBe(DONE);
      expect(settled?.idle, hook).toBe(true);
      expect(settled?.sessionId).toBe("pi-1");
    }
    for (const hook of ["agent_end", "turn_end", "session_start"]) {
      expect(pi({ hookEventName: hook })?.idle, hook).toBeUndefined();
    }
  });

  it("keeps the turn open for a scheduled continuation", () => {
    const event = pi({ hookEventName: "agent_end", willContinue: true });
    expect(event?.state).toBe(WORKING);
    expect(event?.idle).toBeUndefined();
  });

  it("observes and names tools but never blocks them", () => {
    const call = pi({ hookEventName: "tool_call", toolName: "bash" });
    expect(call?.state).toBe(WORKING);
    expect(call?.askKind).toBe("bash");
    expect(call?.pendingId).toBeUndefined();

    // An approval the user wired up by hand is a wait, not a decision we make.
    const asked = pi({
      hookEventName: "tool_approval_requested",
      toolName: "write",
    });
    expect(asked?.state).toBe(BLOCKED);
    expect(asked?.askKind).toBe("write");
    expect(pi({ hookEventName: "tool_approval_resolved" })?.state).toBe(
      WORKING,
    );
  });

  it("says nothing about the state for compaction and model events", () => {
    for (const hook of [
      "session_compact",
      "session_before_compact",
      "session.compacting",
      "auto_compaction_start",
      "auto_compaction_end",
      "model_select",
    ]) {
      expect(pi({ hookEventName: hook }), hook).toBeUndefined();
    }
  });

  it("ignores unknown events and non-JSON stdin", () => {
    expect(pi({ hookEventName: "resources_discover" })).toBeUndefined();
    expect(pi({ hookEventName: "" })).toBeUndefined();
    expect(pi({ raw: "pi printed a banner" })).toBeUndefined();
    expect(pi([1, 2, 3])).toBeUndefined();
  });

  it("serves Oh My Pi from the same parser under its own id", () => {
    const event = normalize("omp", "node-a", {
      hookEventName: "session_stop",
      sessionId: "omp-9",
    });
    expect(event?.agentId).toBe("omp");
    expect(event?.idle).toBe(true);
  });
});
