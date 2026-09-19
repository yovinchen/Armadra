/**
 * `/api/settings` and `/api/settings/local` — reading and patching the
 * preferences document.
 *
 * Ported from `apps/runtime/src/api/settings.rs`, minus one thing: the write
 * ownership gate. `ownership::require_local_write` existed because two
 * processes could write this document and one of them had to be told it was no
 * longer the writer. There is one process now, so the gate has nothing to
 * decide — the whole `ownership` module is on the deletion list (design §4.2),
 * and this is the first route that stops consulting it.
 */

import { badRequest, type ErrorResponse } from "../http/errors";
import type { CoreRequest, HandlerResult } from "../http/router";
import { localPaths } from "./local";
import type { JsonValue } from "./local";
import { BACKEND_CHOICES, LOG_RETENTION_CHOICES } from "./schema";
import type { SettingsStore } from "./store";

export interface SettingsRouteDeps {
  readonly settings: SettingsStore;
  /** `<data dir>/worker-settings.json`, so the page can say it, not imply it. */
  readonly workerSettingsFile: string;
}

export type ParsedBody =
  | { readonly ok: true; readonly value: JsonValue | undefined }
  | ErrorResponse;

/**
 * `request.json()`, with the throw turned into the envelope.
 *
 * `CoreRequest.json` raises `SyntaxError` on a bad document, which is the right
 * default for a caller that has already decided the body must parse. A route
 * that answers `{ code, message }` has not: a malformed body is that request's
 * failure, not the core's, and a 400 saying so is the answer. An empty body is
 * `undefined` rather than an error — which routes accept one is the route's own
 * rule, and "expected JSON" for a request that sent nothing says less than the
 * route can.
 */
export function readJsonBody(request: CoreRequest): ParsedBody {
  if (request.body.byteLength === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: request.json<JsonValue>() };
  } catch {
    return badRequest("The request body is not JSON");
  }
}

export function isParseFailure(value: ParsedBody): value is ErrorResponse {
  return !("ok" in value);
}

/** `GET /api/settings` — the merged document, unknown keys and all. */
export function getSettings(deps: SettingsRouteDeps): HandlerResult {
  return { status: 200, body: deps.settings.snapshot() };
}

/**
 * `GET /api/settings/local` — which keys belong to this execution host.
 *
 * The list lives here because this is what enforces it; a second copy in the
 * front end would be a second answer to "does this key travel", and the two
 * would drift.
 */
export function getLocalSettings(deps: SettingsRouteDeps): HandlerResult {
  return {
    status: 200,
    body: { paths: localPaths(), file: deps.workerSettingsFile },
  };
}

/**
 * `PATCH /api/settings` — a merge, so a key this build does not know about is
 * preserved rather than dropped.
 *
 * Two keys are checked before the merge rather than after. Both are closed
 * choice lists that `normalize` would silently snap back to a default, and a
 * settings page whose dropdown said one thing while the stored value said
 * another is worse than a refusal naming the field.
 */
export function patchSettings(
  deps: SettingsRouteDeps,
  request: CoreRequest,
): HandlerResult | ErrorResponse {
  const parsed = readJsonBody(request);
  if (isParseFailure(parsed)) return parsed;
  const patch = parsed.value;
  if (
    patch === undefined ||
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return badRequest("Settings patch must be an object");
  }
  const terminal = patch.terminal;
  if (typeof terminal === "object" && terminal !== null && !Array.isArray(terminal)) {
    const backend = terminal.backend;
    if (
      typeof backend === "string" &&
      !(BACKEND_CHOICES as readonly string[]).includes(backend)
    ) {
      return badRequest("Unknown terminal backend");
    }
  }
  const logs = patch.logs;
  if (typeof logs === "object" && logs !== null && !Array.isArray(logs)) {
    if ("retentionDays" in logs) {
      const days = logs.retentionDays;
      const valid =
        typeof days === "number" &&
        Number.isInteger(days) &&
        days >= 0 &&
        LOG_RETENTION_CHOICES.includes(days);
      if (!valid) return badRequest("Unknown log retention");
    }
  }
  return { status: 200, body: deps.settings.patch(patch) };
}
