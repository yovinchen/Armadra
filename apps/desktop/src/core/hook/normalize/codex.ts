import {
  type AgentEvent,
  BLOCKED,
  DONE,
  type Payload,
  WAITING,
  WORKING,
  applyCommon,
  field,
  flag,
  newEvent,
  number,
  sessionEvent,
  stateEvent,
  text,
  truncate,
} from "./event";

/**
 * Codex hook payloads.
 *
 * Codex's hook vocabulary is the Claude family with three differences that
 * matter here:
 *
 *   * subagents are identified by `agent_id`, not by the `tool_use_id` of the
 *     Task tool, because Codex spawns them as real agents rather than as a
 *     tool call;
 *   * `request_user_input` is a first-class way to ask the human a question —
 *     it arrives either as a tool name or as a notification type, and both
 *     mean `waiting`, not `working`;
 *   * Codex has no `StopFailure`; a failed turn is a `Stop` carrying an error.
 */

/** Both the tool name and the notification type Codex uses to ask a question. */
const REQUEST_USER_INPUT = "request_user_input";

export function normalize(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const hook = text(payload, "hook_event_name", "hookEventName");
  if (hook === undefined) return undefined;
  const toolName = text(payload, "tool_name", "toolName");
  const asksUser = toolName?.includes(REQUEST_USER_INPUT) === true;

  let event: AgentEvent | undefined;
  switch (hook) {
    case "SessionStart":
      event = sessionEvent(nodeId, agentId, "start");
      break;
    case "SessionEnd":
      event = sessionEvent(nodeId, agentId, "end");
      break;
    case "UserPromptSubmit":
      event = stateEvent(nodeId, agentId, WORKING);
      event.newTurn = true;
      event.lastMessage = text(payload, "prompt", "prompt");
      break;
    case "PreToolUse":
    case "PostToolUse":
      if (asksUser) {
        event = stateEvent(nodeId, agentId, WAITING);
        event.awaitingInput = true;
        event.askKind = toolName;
      } else {
        event = stateEvent(nodeId, agentId, WORKING);
      }
      break;
    case "PermissionRequest":
      event = stateEvent(nodeId, agentId, BLOCKED);
      event.askKind = toolName ?? "permission";
      break;
    case "Notification":
      event = notification(nodeId, agentId, payload);
      break;
    case "Stop":
    case "Interrupt":
      event = stateEvent(nodeId, agentId, DONE);
      if (
        hook === "Interrupt" ||
        flag(payload, "interrupted", "interrupted") === true
      ) {
        event.interrupted = true;
      }
      if (errored(payload)) event.errored = true;
      break;
    case "SubagentStart":
      event = newEvent(nodeId, agentId, "subagent-start");
      event.subagentType =
        text(payload, "subagent_type", "subagentType") ??
        text(payload, "model", "model");
      {
        const label =
          text(payload, "task", "task") ?? text(payload, "prompt", "prompt");
        if (label !== undefined) event.taskLabel = truncate(label, 400);
      }
      break;
    case "SubagentStop":
      event = newEvent(nodeId, agentId, "subagent-end");
      event.subagentType = text(payload, "subagent_type", "subagentType");
      event.durationMs = number(payload, "duration_ms", "durationMs");
      event.tokens =
        number(payload, "total_tokens", "totalTokens") ??
        number(payload, "tokens", "tokens");
      event.toolUses =
        number(payload, "tool_use_count", "toolUseCount") ??
        number(payload, "tool_uses", "toolUses");
      event.result =
        text(payload, "result", "result") ??
        text(payload, "last_agent_message", "lastAgentMessage");
      break;
    default:
      return undefined;
  }
  if (event === undefined) return undefined;

  // A Codex subagent is its own agent, so its id is the stable handle the
  // canvas keys temporary cards on. Fall back to the tool call for hosts that
  // report the Claude way.
  event.toolUseId =
    text(payload, "agent_id", "agentId") ??
    text(payload, "tool_use_id", "toolUseId");
  if (event.lastMessage === undefined) {
    event.lastMessage =
      text(payload, "last_agent_message", "lastAgentMessage") ??
      text(payload, "last_assistant_message", "lastAssistantMessage");
  }
  applyCommon(event, payload);
  return event;
}

function errored(payload: Payload): boolean {
  if (flag(payload, "errored", "errored") === true) return true;
  return field(payload, "error", "error") !== undefined;
}

function notification(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const kind =
    text(payload, "notification_type", "notificationType") ??
    text(payload, "type", "type") ??
    "";
  const message = text(payload, "message", "message") ?? "";
  const lowered = `${kind} ${message}`.toLowerCase();

  if (
    lowered.includes(REQUEST_USER_INPUT) ||
    lowered.includes("request user input")
  ) {
    const event = stateEvent(nodeId, agentId, WAITING);
    event.awaitingInput = true;
    event.askKind = REQUEST_USER_INPUT;
    if (message !== "") event.lastMessage = message;
    return event;
  }
  if (lowered.includes("permission") || lowered.includes("approve")) {
    const event = stateEvent(nodeId, agentId, BLOCKED);
    event.askKind = text(payload, "tool_name", "toolName") ?? "permission";
    if (message !== "") event.lastMessage = message;
    return event;
  }
  if (lowered.includes("idle") || lowered.includes("waiting for your input")) {
    const event = stateEvent(nodeId, agentId, DONE);
    event.idle = true;
    if (message !== "") event.lastMessage = message;
    return event;
  }
  return undefined;
}
