import {
  type AgentEvent,
  BLOCKED,
  DONE,
  type Payload,
  WORKING,
  field,
  sessionEvent,
  stateEvent,
  text,
  truncate,
} from "./event";

/**
 * opencode plugin payloads.
 *
 * opencode has no hook configuration: a plugin subscribes to one `event` bus
 * and receives `{ type | event, properties }`. That means there is no "before
 * the turn starts" signal — the closest thing is a `message.updated` whose
 * message has `role: "user"`, which is why the new-turn detection here looks
 * inside `properties` instead of at the topic alone.
 *
 * Topics are matched by prefix (`tool.`) where the bus is known to add
 * variants, and exactly elsewhere, so a future `tool.execute.retry` still
 * reads as `working` while an unrelated topic stays ignored.
 */
export function normalize(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  // The plugin forwards the bus event verbatim; opencode has used both `type`
  // and `event` for the topic across versions.
  const topic =
    text(payload, "event", "type") ?? text(payload, "type", "event");
  if (topic === undefined || topic === "") return undefined;
  const raw = field(payload, "properties", "properties");
  const properties =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw
      : undefined;

  let event: AgentEvent;
  switch (topic) {
    case "session.idle":
      event = stateEvent(nodeId, agentId, DONE);
      break;
    case "session.error":
      event = stateEvent(nodeId, agentId, DONE);
      event.errored = true;
      event.lastMessage = text(properties, "error", "error");
      break;
    case "message.updated":
    case "message.part.updated":
      // Only the user's own message opens a turn; the assistant's stream
      // updates the same topic dozens of times per turn.
      if (!isUserMessage(properties)) return undefined;
      event = stateEvent(nodeId, agentId, WORKING);
      event.newTurn = true;
      break;
    case "permission.asked":
    case "permission.updated":
    case "permission.replied":
      event = stateEvent(nodeId, agentId, BLOCKED);
      event.pendingId = permissionId(properties);
      event.askKind = text(properties, "type", "kind") ?? "permission";
      event.lastMessage = text(properties, "title", "title");
      break;
    case "session.deleted":
      event = sessionEvent(nodeId, agentId, "end");
      break;
    default:
      if (!topic.startsWith("tool.")) return undefined;
      event = stateEvent(nodeId, agentId, WORKING);
      break;
  }

  event.sessionId = sessionId(properties);
  return event;
}

/**
 * `message.updated` nests the message under `info` in current opencode, and
 * used to inline it; both shapes are read.
 */
function isUserMessage(properties: Payload): boolean {
  const info = field(properties, "info", "info");
  const role = field(info, "role", "role") ?? field(properties, "role", "role");
  return typeof role === "string" && role.toLowerCase() === "user";
}

function sessionId(properties: Payload): string | undefined {
  const info = field(properties, "info", "info");
  const found =
    (info === undefined ? undefined : text(info, "sessionID", "sessionId")) ??
    text(properties, "sessionID", "sessionId") ??
    text(properties, "session_id", "sessionID");
  return found === undefined ? undefined : truncate(found, 200);
}

function permissionId(properties: Payload): string | undefined {
  const found =
    text(properties, "id", "permissionID") ??
    text(properties, "permissionID", "permissionId");
  return found === undefined ? undefined : truncate(found, 200);
}
