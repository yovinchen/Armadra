import {
  type AgentEvent,
  BLOCKED,
  DONE,
  type Payload,
  WORKING,
  applyCommon,
  flag,
  sessionEvent,
  stateEvent,
  text,
} from "./event";

/**
 * Pi and Oh My Pi extension payloads — 协作通道 §3.3.
 *
 * One module for both: OMP is a fork of Pi's extension API and the overlap is
 * nearly total, so the difference is an alias table rather than a second
 * parser. The generated extension posts the flat `hookEventName` shape the
 * other adapters use, which is why `applyCommon` works here unchanged.
 *
 * Two mappings deserve their own sentence:
 *
 *   * **settling.** `agent_settled` (Pi) and `session_stop` (OMP 18.x) are the
 *     only events that mean "the CLI is genuinely idle" rather than "between
 *     two of its own steps", so they are the ones that carry `idle`.
 *     `agent_end` closes the turn but does not claim idleness — Pi can start
 *     another loop straight after it, and OMP even says so with
 *     `willContinue`.
 *   * **compaction.** `session_compact`, `auto_compaction_end` and
 *     `model_select` say nothing about what the node is doing; they are
 *     subscribed so the extension can push a fresh `getContextUsage()`
 *     reading, which travels on the separate `armadraContextUsage` payload.
 *     Here they are deliberately dropped: reporting `working` for a background
 *     compaction would drag an idle node out of the state the idle gate reads.
 *
 * `tool_call` is observed and never blocked. Pi lets a handler stop a tool,
 * but Armadra's permission semantics are "the CLI is asking"; §3.5 forbids
 * manufacturing a dialog the CLI never opened.
 */
export function normalize(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  const hook = text(payload, "hook_event_name", "hookEventName");
  if (hook === undefined) return undefined;

  let event: AgentEvent;
  switch (hook) {
    case "session_start":
      event = sessionEvent(nodeId, agentId, "start");
      break;
    case "session_shutdown":
      event = sessionEvent(nodeId, agentId, "end");
      break;
    case "before_agent_start":
      event = stateEvent(nodeId, agentId, WORKING);
      event.newTurn = true;
      event.lastMessage = text(payload, "prompt", "prompt");
      break;
    // `input` is not subscribed by the installer — the prompt already arrives
    // with `before_agent_start` — but a user who registers it by hand should
    // not put the node into an unknown state.
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "tool_call":
    case "tool_result":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "auto_retry_start":
    case "input":
      event = stateEvent(nodeId, agentId, WORKING);
      break;
    case "agent_end":
      // OMP schedules its own continuation and says so; the turn is not over
      // for the user, so it must not enter the done holdoff.
      if (flag(payload, "will_continue", "willContinue") === true) {
        return stateEvent(nodeId, agentId, WORKING);
      }
      event = stateEvent(nodeId, agentId, DONE);
      event.lastMessage = text(payload, "stop_reason", "stopReason");
      break;
    case "agent_settled":
    case "session_stop":
      event = stateEvent(nodeId, agentId, DONE);
      event.idle = true;
      break;
    // Not subscribed (§3.5 keeps the adapter observational), but mapped so a
    // hand-added handler reads as a wait rather than as nothing.
    case "tool_approval_requested":
      event = stateEvent(nodeId, agentId, BLOCKED);
      event.askKind = text(payload, "tool_name", "toolName");
      break;
    case "tool_approval_resolved":
      event = stateEvent(nodeId, agentId, WORKING);
      break;
    // Context-only events: see the module note.
    default:
      return undefined;
  }

  if (event.askKind === undefined) {
    event.askKind = text(payload, "tool_name", "toolName");
  }
  applyCommon(event, payload);
  return event;
}
