import {
  type HelloResponse,
  HelloResponseSchema,
  type HostManagementResult,
  HostManagementResultSchema,
  type HostStatus,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  fromBinary,
} from "@armadra/protocol";
import { type HostLaunchError, hostError } from "./errors";

/**
 * What a reported Host has to prove before the desktop shell trusts it.
 *
 * Ported from `src-tauri/src/host/verify.rs`. The decoding is the generated
 * `@armadra/protocol` reader, never a hand-written parser: `proto/` is the one
 * source of truth for the wire (AGENTS.md), and a second parser here would be
 * a second definition of the message that nobody regenerates.
 */

export type Decoded<T> =
  | { ok: true; value: T }
  | { ok: false; error: HostLaunchError };

function decodeManagement(wire: Uint8Array): HostManagementResult | undefined {
  try {
    return fromBinary(HostManagementResultSchema, wire);
  } catch {
    return undefined;
  }
}

/**
 * The Host in a `start`/`stop` answer, if it is running, well-formed, and on
 * exactly the endpoint that was asked for.
 */
export function decodeRunning(
  wire: Uint8Array,
  expectedEndpoint: string | undefined,
): Decoded<HostStatus> {
  const result = decodeManagement(wire);
  if (result === undefined)
    return { ok: false, error: hostError("malformedResult") };
  if (result.state.case === "stopped")
    return { ok: false, error: hostError("notRunning") };
  if (result.state.case !== "running")
    return { ok: false, error: hostError("malformedResult") };
  const status = result.state.value;
  if (
    status.hostId.trim() === "" ||
    status.hostInstanceId.trim() === "" ||
    status.processId === 0 ||
    status.startedAtUnixMs <= 0n
  ) {
    return { ok: false, error: hostError("malformedResult") };
  }
  // A Host we asked to hold no port must report exactly that. An endpoint
  // appearing where none was asked for means we are looking at a Host started
  // with a different configuration, which is a mismatch, not a bonus.
  if (status.httpEndpoint !== (expectedEndpoint ?? "")) {
    return { ok: false, error: hostError("endpointMismatch") };
  }
  return { ok: true, value: status };
}

/**
 * Whether `wire` describes a running Host that holds no HTTP port at all.
 *
 * Only this shell ever started such a Host — packaged builds asked for
 * `--listen none` before the page's native session needed the loopback port —
 * so meeting one at startup means an older build of the desktop left it
 * behind, not that somebody else configured a Host on this machine.
 */
export function portlessRunning(wire: Uint8Array): boolean {
  const decoded = decodeRunning(wire, undefined);
  return decoded.ok && decoded.value.httpEndpoint === "";
}

/** Whether a `stop` answer confirms the Host actually stopped. */
export function decodeStopped(wire: Uint8Array): boolean {
  return decodeManagement(wire)?.state.case === "stopped";
}

/**
 * The CORS answer has to name our origin exactly. A wildcard, a different
 * origin, or a non-success status are all the same refusal: this Host was not
 * configured to serve the page we are about to load.
 */
export function checkOrigin(
  status: number,
  allowOrigin: string | null | undefined,
  origin: string,
): HostLaunchError | undefined {
  const success = status >= 200 && status < 300;
  return success && allowOrigin === origin
    ? undefined
    : hostError("originDenied");
}

/**
 * A real browser sends a preflight for `application/x-protobuf`. Checking only
 * POST from native code would miss a broken or absent browser-origin
 * permission, so the preflight's method and header lists are checked too.
 */
export function checkPreflight(
  status: number,
  allowOrigin: string | null | undefined,
  allowMethods: string | null | undefined,
  allowHeaders: string | null | undefined,
  origin: string,
): HostLaunchError | undefined {
  const denied = checkOrigin(status, allowOrigin, origin);
  if (denied) return denied;
  const methods = (allowMethods ?? "")
    .split(",")
    .some((value) => value.trim() === "POST");
  const headers = (allowHeaders ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase() === "content-type");
  return methods && headers ? undefined : hostError("originDenied");
}

/** The `Hello` answer must be protobuf; a JSON error page is not a Hello. */
export function checkHelloContentType(
  contentType: string | null | undefined,
): boolean {
  const value = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return value === "application/x-protobuf";
}

/**
 * The Host that answered over HTTP has to be the Host the CLI reported. A
 * different identity on the endpoint we were told about means something else
 * is serving it.
 */
export function checkHello(
  wire: Uint8Array,
  status: HostStatus,
): HostLaunchError | undefined {
  let hello: HelloResponse;
  try {
    hello = fromBinary(HelloResponseSchema, wire);
  } catch {
    return hostError("invalidHello");
  }
  const version = hello.protocol;
  if (version === undefined) return hostError("invalidHello");
  if (
    version.major !== PROTOCOL_MAJOR ||
    version.minor > PROTOCOL_MINOR ||
    hello.maxFrameBytes === 0
  ) {
    return hostError("protocolMismatch");
  }
  if (
    hello.hostId !== status.hostId ||
    hello.hostInstanceId !== status.hostInstanceId
  ) {
    return hostError("identityMismatch");
  }
  return undefined;
}
