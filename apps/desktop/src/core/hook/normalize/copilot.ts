import {
  type AgentEvent,
  DONE,
  type Payload,
  WAITING,
  WORKING,
  applyCommon,
  field,
  flag,
  newEvent,
  sessionEvent,
  stateEvent,
  text,
  truncate,
} from "./event";

/**
 * GitHub Copilot CLI hook payloads — 协作通道 §3.3.
 *
 * Copilot is the one provider whose payload does **not** name its own event.
 * Claude and Codex both send `hook_event_name`; Copilot sends a bare object —
 * `{sessionId, timestamp, cwd, …}` plus whatever that event adds — and the
 * event name exists only as the key in the hooks file. Verified against
 * Copilot CLI 1.0.83 on 2026-09-06 by installing a probe hook on every event
 * and dumping stdin: `sessionStart` arrived as
 *
 * ```json
 * {"sessionId":"…","timestamp":1788699265758,"cwd":"…","source":"new","initialPrompt":"…"}
 * ```
 *
 * with no event name anywhere. So the event is recovered from its shape, and
 * the shape test is written to be *specific*: each rule names a field pair
 * only one event carries, and the ambiguous pairs are ordered so the narrower
 * event wins (`subagentStop` before `agentStop` — both carry `stopReason`).
 *
 * An explicit name is still believed when one is present: the `notification`
 * payload documents a `hook_event_name`, and a future version that adds it to
 * the rest should be taken at its word rather than re-derived. Both the
 * camelCase names and the VS Code-compatible PascalCase aliases are accepted,
 * because both fire — the same probe run showed one invocation per event under
 * each spelling.
 *
 * `notification` is **four** events wearing one name. It is undocumented on
 * docs.github.com — the reference page lists eight events and this is not one
 * of them — so the source is the CLI's own changelog, 1.0.18 (2026-04-04),
 * which added a "notification hook event that fires asynchronously on shell
 * completion, permission prompts, elicitation dialogs, and agent completion".
 * The discriminator is `notification_type`, and the only value attested by a
 * primary source is `permission_prompt`.
 *
 * So exactly one value is translated, to `waiting`, and every other value is
 * dropped:
 *
 *   * a **shell completion** is not a state of the node — the turn that
 *     started the command is still running, and `postToolUse` already says so;
 *   * an **elicitation dialog** is plausibly `waiting` too, but no source
 *     names its `notification_type`, and inventing the string would make the
 *     mapping fire on nothing or on the wrong thing;
 *   * **agent completion** already has an authoritative event in `agentStop`,
 *     which carries the stop reason; a second, asynchronous `done` from a
 *     notification could only arrive later and overwrite a newer turn.
 *
 * Because it is asynchronous, a `notification` is never a fence: it is not
 * subscribed to gate anything, and nothing waits on its exit code.
 *
 * **`preCompact`** would bump a compaction epoch, and Copilot declares no
 * `contextUsage` for it to reset (§4). Claude's `PreCompact` is dropped for
 * the same reason.
 *
 * `preToolUse` never appears here because it is never subscribed: it is
 * Copilot's only blocking event and a non-zero exit denies the tool (§6).
 */
export function normalize(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const name = eventName(payload);
  if (name === undefined) return undefined;

  let event: AgentEvent | undefined;
  switch (name) {
    case "sessionStart":
      event = sessionEvent(nodeId, agentId, "start");
      // 1.0.83 creates the session *from* the first prompt: this arrives
      // roughly 20 ms after that prompt's `userPromptSubmitted`, with the
      // prompt echoed back. Told apart from a start that precedes any work,
      // the reducer can leave the turn already in flight alone instead of
      // resetting the `working` it just wrote (§5.4 rule 4).
      event.sessionOpenedByPrompt =
        text(payload, "initial_prompt", "initialPrompt") !== undefined;
      break;
    case "sessionEnd":
      event = sessionEvent(nodeId, agentId, "end");
      break;
    case "userPromptSubmitted":
      event = stateEvent(nodeId, agentId, WORKING);
      event.newTurn = true;
      event.lastMessage = text(payload, "prompt", "prompt");
      break;
    // Both tool events say the same thing about the node: the turn is still
    // running. A failed tool is not a failed turn — Copilot recovers from one
    // routinely — so `postToolUseFailure` does not set `errored`.
    case "postToolUse":
    case "postToolUseFailure":
      event = stateEvent(nodeId, agentId, WORKING);
      break;
    case "agentStop":
      event = stateEvent(nodeId, agentId, DONE);
      break;
    case "subagentStart":
      event = newEvent(nodeId, agentId, "subagent-start");
      event.subagentType = text(payload, "agent_name", "agentName");
      {
        const label =
          text(payload, "agent_description", "agentDescription") ??
          text(payload, "agent_display_name", "agentDisplayName");
        if (label !== undefined) event.taskLabel = truncate(label, 400);
      }
      break;
    case "subagentStop":
      event = newEvent(nodeId, agentId, "subagent-end");
      event.subagentType =
        text(payload, "agent_type", "agentType") ??
        text(payload, "agent_name", "agentName");
      event.result = text(payload, "response", "response");
      event.toolUseId = text(payload, "agent_id", "agentId");
      break;
    case "errorOccurred":
      event = errorOccurred(nodeId, agentId, payload);
      break;
    case "notification":
      event = notification(nodeId, agentId, payload);
      break;
    // See the module note.
    default:
      return undefined;
  }
  if (event === undefined) return undefined;
  applyCommon(event, payload);
  return event;
}

/**
 * Copilot reports recoverable errors it goes on to retry — a model call that
 * timed out, a tool that threw — and `agentStop` still ends the turn
 * afterwards. Only an unrecoverable one is a turn ending badly, so only that
 * one is reported; anything else would race the `agentStop` that is coming.
 */
function errorOccurred(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  if (flag(payload, "recoverable", "recoverable") !== false) return undefined;
  const event = stateEvent(nodeId, agentId, DONE);
  event.errored = true;
  const error = field(payload, "error", "error");
  event.lastMessage =
    (error === undefined ? undefined : text(error, "message", "message")) ??
    text(payload, "error", "error");
  return event;
}

/**
 * A permission prompt is on screen, or nothing this can attribute.
 *
 * The type is compared exactly. A prefix or substring test would let a value
 * this code has never seen — `permission_prompt_dismissed`, say — light up the
 * header as "needs you" for a question nobody is being asked.
 */
function notification(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const kind = text(payload, "notification_type", "notificationType");
  if (kind !== "permission_prompt") return undefined;
  return stateEvent(nodeId, agentId, WAITING);
}

/**
 * The event this payload came from, as the camelCase name the hooks file uses.
 *
 * An explicit name wins; otherwise the shape decides. Every shape rule below
 * keys on a field the docs list for exactly one event, and the order resolves
 * the two overlaps: `subagentStop` and `agentStop` both carry `stopReason`,
 * and `postToolUseFailure` and `errorOccurred` both carry `error` (a string in
 * one, an object in the other).
 */
function eventName(payload: Payload): string | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const named = text(payload, "hook_event_name", "hookEventName");
  if (named !== undefined) {
    const canonical = canonicalName(named);
    if (canonical !== undefined) return canonical;
  }
  const has = (key: string): boolean => field(payload, key, key) !== undefined;

  if (has("agentId") && has("response")) return "subagentStop";
  if (has("agentName")) return "subagentStart";
  if (has("toolName")) {
    return has("error") ? "postToolUseFailure" : "postToolUse";
  }
  const error = field(payload, "error", "error");
  if (
    has("errorContext") ||
    (typeof error === "object" && error !== null && !Array.isArray(error))
  ) {
    return "errorOccurred";
  }
  if (has("trigger") && has("customInstructions")) return "preCompact";
  if (has("notification_type") || has("notificationType")) {
    return "notification";
  }
  if (has("stopReason") || has("stop_hook_active")) return "agentStop";
  if (has("prompt")) return "userPromptSubmitted";
  // Last, because they are the least distinctive fields Copilot sends: a
  // session's `source` and its `reason` are single words that another event
  // could plausibly grow later.
  if (has("source")) return "sessionStart";
  if (has("reason")) return "sessionEnd";
  return undefined;
}

/**
 * camelCase name, or the VS Code-compatible PascalCase alias, to the one
 * spelling the rest of this module uses.
 */
function canonicalName(named: string): string | undefined {
  const aliases: Record<string, string> = {
    sessionStart: "sessionStart",
    SessionStart: "sessionStart",
    sessionEnd: "sessionEnd",
    SessionEnd: "sessionEnd",
    userPromptSubmitted: "userPromptSubmitted",
    UserPromptSubmit: "userPromptSubmitted",
    postToolUse: "postToolUse",
    PostToolUse: "postToolUse",
    postToolUseFailure: "postToolUseFailure",
    PostToolUseFailure: "postToolUseFailure",
    agentStop: "agentStop",
    Stop: "agentStop",
    subagentStart: "subagentStart",
    SubagentStart: "subagentStart",
    subagentStop: "subagentStop",
    SubagentStop: "subagentStop",
    errorOccurred: "errorOccurred",
    ErrorOccurred: "errorOccurred",
    preCompact: "preCompact",
    PreCompact: "preCompact",
    notification: "notification",
    Notification: "notification",
  };
  return aliases[named];
}
