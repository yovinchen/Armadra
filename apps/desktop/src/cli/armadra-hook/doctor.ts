/** `armadra-hook doctor` — five lines that answer "why is my agent grey?". */

import {
  discoverCandidates,
  endpointFilePath,
  envVar,
  loadEndpoint,
  nodeToken,
} from "./endpoint.js";
import type { Endpoint } from "./endpoint.js";
import { getRequest, send } from "./http.js";
import { HOOK_CLIENT_REVISION } from "./usage.js";

export async function run(): Promise<number> {
  const nodeId = envVar("ARMADRA_NODE_ID");
  const file = endpointFilePath();
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  out(`endpoint file: ${file ?? "(ARMADRA_ENDPOINT_FILE is not set)"}`);

  const loaded = file === undefined ? undefined : loadEndpoint(file);
  const endpoint = loaded !== undefined && "ok" in loaded ? loaded.ok : undefined;
  if (loaded === undefined) out("endpoint load: skipped (no path)");
  else if (endpoint === undefined) out(`endpoint load: failed (${(loaded as { error: string }).error})`);
  else {
    out(
      `endpoint load: ok (port=${endpoint.port ?? "-"}, socket=${endpoint.sock ?? "-"}, ` +
        `version=${endpoint.version ?? "-"}, client=${HOOK_CLIENT_REVISION})`,
    );
  }

  // Failover candidates (W0.3): every place this invocation would try, in
  // order, which can differ from the single path above once
  // ARMADRA_ENDPOINT_FILE is stale or unset — `context`/`canvas`/hook reports
  // all walk this same list.
  const candidates = discoverCandidates();
  if (candidates.length === 0) out("candidates: none (no endpoint is advertised anywhere)");
  else out(`candidates: ${candidates.map((candidate) => candidate.path).join(", ")}`);

  out(`verify: ${await verify(candidates, nodeId)}`);

  if (nodeId === undefined) out("tokens: unknown (ARMADRA_NODE_ID is not set)");
  else if (endpoint === undefined) out("tokens: unknown (endpoint file did not load)");
  else {
    out(
      `tokens: hook=${present(endpoint.hookToken !== undefined)}, ` +
        `node=${present(nodeToken(endpoint, nodeId) !== undefined)} (node id ${nodeId})`,
    );
  }

  return nodeId !== undefined && endpoint !== undefined ? 0 : 1;
}

/**
 * Same transport-failure-only failover as the control path, but usable
 * without a node id (`doctor` is often run to find out *why*
 * `ARMADRA_NODE_ID` looks wrong in the first place).
 */
async function verify(candidates: Endpoint[], nodeId: string | undefined): Promise<string> {
  if (candidates.length === 0) return "skipped (no candidate endpoint)";
  let lastError = "";
  for (const candidate of candidates) {
    const headers: [string, string][] = [
      ["X-Armadra-Hook-Client", HOOK_CLIENT_REVISION],
      ["X-Armadra-Hook-Token", candidate.hookToken ?? ""],
    ];
    const token = nodeId === undefined ? undefined : nodeToken(candidate, nodeId);
    if (token !== undefined) headers.push(["X-Armadra-Node-Token", token]);
    const outcome = await send(candidate, getRequest("/verify", headers));
    if ("ok" in outcome) {
      const body = outcome.ok.body.trim().split("\n").join(" ").slice(0, 200);
      return `GET /verify -> ${outcome.ok.status} ${body} (via ${candidate.path})`;
    }
    lastError = outcome.error;
  }
  return `GET /verify failed on all ${candidates.length} candidate(s) (last error: ${lastError})`;
}

function present(value: boolean): string {
  return value ? "present" : "absent";
}
