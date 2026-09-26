/**
 * Everything the client needs to talk to the runtime for one invocation.
 *
 * `candidates` is the bounded, ordered list built by `discoverCandidates`
 * (W0.3): the address this terminal's environment was told to use, then a
 * couple of fallbacks for when that address no longer answers. {@link send} is
 * what walks it.
 */

import { discoverCandidates, envVar, nodeToken } from "./endpoint.js";
import type { Endpoint } from "./endpoint.js";
import { send as httpSend } from "./http.js";
import type { HookRequest, HookResponse } from "./http.js";
import { HOOK_CLIENT_REVISION } from "./usage.js";

export interface Session {
  nodeId: string;
  candidates: Endpoint[];
}

/**
 * Loads the node id and discovers the candidate endpoints. Distinct from
 * {@link send} finding every candidate unreachable: this is the "nowhere
 * advertises an endpoint at all" case, diagnosed before any network call.
 */
export function loadSession(): { ok: Session } | { error: string } {
  const nodeId = envVar("ARMADRA_NODE_ID");
  if (nodeId === undefined) {
    return {
      error: "ARMADRA_NODE_ID is not set (not running inside a canvas node)",
    };
  }
  const candidates = discoverCandidates();
  if (candidates.length === 0) {
    return {
      error:
        "no hook endpoint is advertised anywhere (checked ARMADRA_ENDPOINT_FILE and the " +
        "default data directory)",
    };
  }
  return { ok: { nodeId, candidates } };
}

/**
 * Header list for one specific candidate, in a fixed order so the bytes on the
 * wire are reproducible. The node token is re-read from that candidate's own
 * token directory every call — never cached across candidates — so an adopted
 * endpoint is always presented with its own token, not a stale one from a
 * different directory.
 */
export function headersFor(
  session: Session,
  candidate: Endpoint,
): [string, string][] {
  const headers: [string, string][] = [
    ["X-Armadra-Hook-Client", HOOK_CLIENT_REVISION],
    ["X-Armadra-Hook-Token", candidate.hookToken ?? ""],
  ];
  const token = nodeToken(candidate, session.nodeId);
  if (token !== undefined) headers.push(["X-Armadra-Node-Token", token]);
  return headers;
}

/**
 * Tries each candidate in order, building a fresh request for each one via
 * `build`. Only a transport-layer failure (refused connection, timeout,
 * missing socket or port) advances to the next candidate — any HTTP answer at
 * all, including a 4xx/5xx, is authoritative and ends the search immediately
 * (agent-integration.md §2.5).
 *
 * The error case here — every candidate existed but none is listening — is
 * deliberately worded differently from {@link loadSession}'s "nowhere
 * advertises an endpoint at all", so a person (or `doctor`) reading the
 * message can tell "nothing to try" from "found something, but it is dead".
 */
export async function send(
  session: Session,
  build: (session: Session, candidate: Endpoint) => HookRequest,
  /** Per-candidate budget; the hook default when absent. */
  total?: number,
): Promise<{ ok: HookResponse; candidate: Endpoint } | { error: string }> {
  let lastError = "";
  for (const candidate of session.candidates) {
    const outcome = await httpSend(candidate, build(session, candidate), total);
    if ("ok" in outcome) return { ok: outcome.ok, candidate };
    lastError = outcome.error;
  }
  return {
    error:
      `found ${session.candidates.length} hook endpoint candidate(s) but none is listening ` +
      `(last error: ${lastError})`,
  };
}
