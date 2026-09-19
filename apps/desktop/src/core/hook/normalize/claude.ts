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
 * Claude Code hook payloads.
 *
 * Every payload is a flat object with `hook_event_name` plus the session
 * identity (`session_id`, `transcript_path`, `cwd`). The two events that need
 * interpretation rather than translation:
 *
 *   * **`Notification`** is overloaded. Claude uses it both for "I need
 *     permission to run this" and for "I have been idle for a while". The
 *     first is a real `blocked`; the second is only a *rescue* hint, because
 *     the `Stop` hook is the authoritative end of a turn and the idle notice
 *     can arrive long after it (contract §5.4).
 *   * **`PreToolUse` for `AskUserQuestion`** is a question, not work: the turn
 *     is still open but the CLI is waiting for a human. The reducer holds that
 *     until the answer arrives, so a `Stop` in between must not read as `done`.
 */

/** Tools whose whole purpose is to ask the human something. */
const QUESTION_TOOLS = ["AskUserQuestion", "ExitPlanMode"];

export function normalize(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const hook = text(payload, "hook_event_name", "hookEventName");
  if (hook === undefined) return undefined;
  const toolName = text(payload, "tool_name", "toolName");

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
    case "PreToolUse": {
      const asking =
        toolName !== undefined && QUESTION_TOOLS.includes(toolName);
      event = stateEvent(nodeId, agentId, asking ? WAITING : WORKING);
      if (asking) {
        event.awaitingInput = true;
        event.askKind = toolName;
      }
      break;
    }
    case "PostToolUse":
      event = stateEvent(nodeId, agentId, WORKING);
      break;
    case "PermissionRequest":
      event = stateEvent(nodeId, agentId, BLOCKED);
      event.askKind = toolName ?? "permission";
      break;
    case "Notification":
      event = notification(nodeId, agentId, payload);
      break;
    case "Stop":
      event = stateEvent(nodeId, agentId, DONE);
      break;
    case "StopFailure":
      event = stateEvent(nodeId, agentId, DONE);
      event.errored = true;
      break;
    case "SubagentStart":
      event = newEvent(nodeId, agentId, "subagent-start");
      event.subagentType = text(payload, "subagent_type", "subagentType");
      {
        const label =
          text(payload, "description", "description") ??
          text(payload, "prompt", "prompt");
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
        number(payload, "total_tool_use_count", "totalToolUseCount") ??
        number(payload, "tool_uses", "toolUses");
      event.result =
        text(payload, "result", "result") ??
        text(payload, "last_assistant_message", "lastAssistantMessage");
      break;
    default:
      return undefined;
  }
  if (event === undefined) return undefined;

  event.toolUseId = text(payload, "tool_use_id", "toolUseId");
  if (event.lastMessage === undefined) {
    event.lastMessage = text(
      payload,
      "last_assistant_message",
      "lastAssistantMessage",
    );
  }
  // Claude sets `stop_hook_active` when a Stop hook already ran for this turn;
  // an explicit `interrupted` (Esc) is what actually ends a turn early.
  if (flag(payload, "interrupted", "interrupted") === true) {
    event.interrupted = true;
  }
  applyCommon(event, payload);
  return event;
}

/**
 * `Notification` carries a human sentence, not a machine field, so the
 * classification is deliberately narrow: anything we do not recognise is
 * dropped rather than guessed into a state change.
 */
function notification(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const message = text(payload, "message", "message") ?? "";
  const lowered = message.toLowerCase();
  const kind = field(payload, "notification_type", "notificationType");
  const explicitPermission =
    typeof kind === "string" && kind.toLowerCase() === "permission";

  if (
    explicitPermission ||
    lowered.includes("permission") ||
    lowered.includes("approve")
  ) {
    const event = stateEvent(nodeId, agentId, BLOCKED);
    event.askKind = text(payload, "tool_name", "toolName") ?? "permission";
    event.lastMessage = message;
    return event;
  }
  if (lowered.includes("waiting for your input") || lowered.includes("idle")) {
    // Rescue only: `Stop` remains the authority on turn ends. The reducer
    // applies this to a `working` node and to nothing else.
    const event = stateEvent(nodeId, agentId, DONE);
    event.idle = true;
    event.lastMessage = message;
    return event;
  }
  return undefined;
}
