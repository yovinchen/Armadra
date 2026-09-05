import { HostIdentityError } from "../identity.js";

import { page } from "./validate.js";

export const SERVICE = "GithubService";
/** A page has to fit the Host frame budget with room for long Issue bodies. */
export const MAX_PAGE = 100;

/**
 * What went wrong, in terms the panel can act on. `rateLimited` is separate
 * from `network` because waiting is the repair, and `unsupported` is separate
 * from `permission` because one is "this Host has no GitHub credential" and the
 * other is "this device may not use it".
 */
export type HostGithubFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "response"
  | "cancelled"
  | "network";

/** Carries only stable metadata; never a response body, token or URL. */
export class HostGithubError extends Error {
  readonly name = "HostGithubError";
  constructor(
    readonly failure: HostGithubFailure,
    /** A mutation that reached the Host but whose result was never read. */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`Host GitHub request failed (${failure}).`);
  }
}

export function reject(failure: HostGithubFailure): never {
  throw new HostGithubError(failure);
}

/**
 * Maps a transport failure onto a repair. An unrecognised remote code stays
 * `network` rather than being softened into `invalid`: a write whose outcome
 * was not read must make the caller reload, not retry.
 */
export function classifyGithubFailure(error: unknown): HostGithubError {
  if (error instanceof HostGithubError) return error;
  if (!(error instanceof HostIdentityError))
    return new HostGithubError("network");
  const { code, hostCode, httpStatus, outcomeUnknown } = error;
  const fail = (failure: HostGithubFailure) =>
    new HostGithubError(failure, outcomeUnknown, httpStatus, hostCode);
  if (code === "CANCELLED" || code === "TIMEOUT") return fail("cancelled");
  if (code === "INVALID_OPTIONS") return fail("invalid");
  if (
    code === "MALFORMED_RESPONSE" ||
    code === "RESPONSE_TOO_LARGE" ||
    code === "UNEXPECTED_CONTENT_TYPE"
  )
    return fail("response");
  if (code !== "REMOTE_ERROR") return fail("network");
  switch (hostCode) {
    case "UNAUTHENTICATED":
      return fail("unauthenticated");
    case "PERMISSION_DENIED":
      return fail("permission");
    case "UNSUPPORTED":
      return fail("unsupported");
    case "NOT_FOUND":
      return fail("notFound");
    case "CONFLICT":
      return fail("conflict");
    case "RESOURCE_EXHAUSTED":
      return fail("rateLimited");
    case "INVALID_ARGUMENT":
      return fail("invalid");
    default:
      return fail("network");
  }
}

let counter = 0;
export function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `github-${Date.now().toString(36)}-${counter}`;
}
