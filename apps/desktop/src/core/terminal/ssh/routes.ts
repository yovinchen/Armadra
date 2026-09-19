/**
 * The SSH surface: host keys, prompts, and the reachability button.
 *
 * Eight route entries, which is every `/api/ssh/…` path the route table lists
 * except the two askpass ones. Those stay unclaimed deliberately, and the
 * reason is written down here rather than left as an apparent omission: on the
 * Rust side `/api/ssh/askpass/prompts` is how the helper reaches the Runtime,
 * because it borrows the shared loopback HTTP listener. This core's helper
 * talks to a 0600 unix socket of its own (see `askpass.ts`), so the askpass
 * endpoint is not on the general HTTP surface at all. Nothing else ever called
 * those two paths, so leaving them 501 loses no caller — and it removes a
 * prompt-opening route from a listener other things can reach.
 */

import { badRequest, coreError, type ErrorResponse } from "../../http/errors";
import type { CoreRequest, HandlerResult } from "../../http/router";
import type { SshHost } from "../../settings/ssh-hosts";
import type { AskpassService } from "./askpass";
import { ScanFailed, forget as forgetKeys, scan, trust } from "./known-hosts";
import { PromptError } from "./prompts";

export interface SshRouteDeps {
  readonly dataDir: string;
  readonly askpass: AskpassService;
  /** The settings registry, read fresh on every call. */
  readonly host: (hostId: string) => SshHost | undefined;
  /**
   * The reachability probe. Injected because it is also what
   * `/api/execution-hosts/{id}/validate` asks, and the two must ask the same
   * question rather than two that could answer differently.
   */
  readonly probe: (
    host: SshHost,
  ) => Promise<{ readonly ok: boolean; readonly output: string }>;
  /** The Worker handshake, for `…/worker/test`. */
  readonly workerTest: (host: SshHost) => Promise<unknown>;
}

/** An unknown id is a 400, exactly like creating a terminal for one. */
function required(deps: SshRouteDeps, hostId: string): SshHost {
  const host = deps.host(hostId);
  if (host === undefined)
    throw new ScanFailed(400, "bad_request", "Unknown SSH host");
  return host;
}

/** Turns this domain's two error classes into the one error shape. */
export function asError(failure: unknown): ErrorResponse {
  if (failure instanceof ScanFailed || failure instanceof PromptError) {
    return coreError(failure.status, failure.code, failure.message);
  }
  return coreError(
    500,
    "internal",
    failure instanceof Error ? failure.message : String(failure),
  );
}

export async function testHost(
  deps: SshRouteDeps,
  hostId: string,
): Promise<HandlerResult> {
  return { status: 200, body: await deps.probe(required(deps, hostId)) };
}

export async function testWorker(
  deps: SshRouteDeps,
  hostId: string,
): Promise<HandlerResult> {
  return { status: 200, body: await deps.workerTest(required(deps, hostId)) };
}

export async function scanHostKeys(
  deps: SshRouteDeps,
  hostId: string,
): Promise<HandlerResult> {
  const found = await scan(deps.dataDir, required(deps, hostId));
  return { status: 200, body: found as unknown as Record<string, unknown> };
}

/**
 * `POST /api/ssh/hosts/{id}/host-keys` — trust one scanned line.
 *
 * `replace` has to be asked for: replacing an existing entry is what a changed
 * key needs, and "the key changed" is either a reinstall or an attack. Only
 * the person knows which, so it is never inferred from the fact that a
 * different key arrived.
 */
export function trustHostKey(
  deps: SshRouteDeps,
  hostId: string,
  request: CoreRequest,
): HandlerResult | ErrorResponse {
  const host = required(deps, hostId);
  let body: { line?: unknown; replace?: unknown };
  try {
    body = request.json();
  } catch {
    return badRequest("请求体不是 JSON");
  }
  if (typeof body?.line !== "string" || body.line.trim() === "") {
    return badRequest("缺少要信任的 host key 行");
  }
  trust(deps.dataDir, host, body.line, body.replace === true);
  return { status: 204 };
}

export function forgetHostKeys(
  deps: SshRouteDeps,
  hostId: string,
): HandlerResult {
  forgetKeys(deps.dataDir, required(deps, hostId));
  return { status: 204 };
}

/* ---------------------------------- prompts -------------------------------- */

/** `GET /api/ssh/prompts` — what is still waiting, for a client that reconnected. */
export function listPrompts(deps: SshRouteDeps): HandlerResult {
  return { status: 200, body: deps.askpass.prompts.waiting() };
}

/**
 * `POST /api/ssh/hosts/{hostId}/prompts/{promptId}` — a person's answer.
 *
 * The secret arrives here and is handed to the waiting helper. It is never
 * written down, never logged and never reusable: the registry removes the
 * entry as the helper reads it.
 */
export function answerPrompt(
  deps: SshRouteDeps,
  hostId: string,
  promptId: string,
  request: CoreRequest,
): HandlerResult | ErrorResponse {
  let body: { answer?: unknown };
  try {
    body = request.json();
  } catch {
    return badRequest("请求体不是 JSON");
  }
  if (typeof body?.answer !== "string") return badRequest("缺少 answer");
  // The host is part of the identity: answering somebody else's prompt is a
  // 404 rather than accepted.
  deps.askpass.prompts.answer(promptId, hostId, body.answer);
  return { status: 204 };
}

/** `DELETE …/prompts/{promptId}` — the person cancelled, or the node closed. */
export function cancelPrompt(
  deps: SshRouteDeps,
  promptId: string,
): HandlerResult {
  deps.askpass.prompts.close(promptId);
  return { status: 204 };
}
