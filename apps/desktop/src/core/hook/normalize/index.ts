import * as claude from "./claude";
import * as codex from "./codex";
import * as copilot from "./copilot";
import type { AgentEvent, Payload } from "./event";
import * as opencode from "./opencode";
import * as pi from "./pi";

export * from "./event";

/**
 * Dispatch on the provider the hook was installed for. `custom:*` CLIs are
 * assumed to speak the Claude Code hook shape, which is the de-facto format
 * third-party wrappers copy; if they do not, nothing matches and the report is
 * ignored rather than mis-attributed.
 *
 * `provider` picks the parser, `agentId` is what the event is attributed to.
 * The two differ for a custom agent: its hooks are the base agent's — the
 * installed hook line literally runs `armadra-hook <base>` — but the node, the
 * session row and the status badge are keyed by the custom id.
 */
export function normalizeAs(
  provider: string,
  agentId: string,
  nodeId: string,
  payload: Payload,
): AgentEvent | undefined {
  switch (provider) {
    case "codex":
      return codex.normalize(nodeId, agentId, payload);
    case "copilot":
      return copilot.normalize(nodeId, agentId, payload);
    case "opencode":
      return opencode.normalize(nodeId, agentId, payload);
    // One parser for both: OMP is a fork of Pi's extension API and the
    // vocabularies differ by an alias, not by a shape.
    case "pi":
    case "omp":
      return pi.normalize(nodeId, agentId, payload);
    default:
      return claude.normalize(nodeId, agentId, payload);
  }
}

/** Prefer {@link normalizeAs} when the caller knows the base agent. */
export function normalize(
  agentId: string,
  nodeId: string,
  payload: Payload,
): AgentEvent | undefined {
  return normalizeAs(agentId, agentId, nodeId, payload);
}
