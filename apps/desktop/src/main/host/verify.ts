import {
  HelloRequestSchema,
  type HostStatus,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  create,
  toBinary,
} from "@armadra/protocol";
import {
  HELLO_PATH,
  HTTP_TIMEOUT_MS,
  STDOUT_LIMIT,
} from "../../shell-core/host/config";
import { failHost, hostError } from "../../shell-core/host/errors";
import {
  checkHello,
  checkHelloContentType,
  checkOrigin,
  checkPreflight,
} from "../../shell-core/host/verify";

/**
 * Proving that the Host on the reported endpoint answers as itself, to the
 * origin the page will actually use. The rules are in
 * `shell-core/host/verify.ts`; this file is only the two HTTP round trips that
 * feed them. Ported from `src-tauri/src/host/verify.rs:99-191`.
 */

export async function verifyOrigin(
  status: HostStatus,
  origin: string,
): Promise<void> {
  const endpoint = `${status.httpEndpoint}${HELLO_PATH}`;

  // A real browser sends a preflight for application/x-protobuf. Checking only
  // POST from native code would miss a broken or absent browser-origin
  // permission.
  const preflight = await send(endpoint, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const preflightDenied = checkPreflight(
    preflight.status,
    preflight.headers.get("access-control-allow-origin"),
    preflight.headers.get("access-control-allow-methods"),
    preflight.headers.get("access-control-allow-headers"),
    origin,
  );
  if (preflightDenied) failHost(preflightDenied);

  const request = create(HelloRequestSchema, {
    clientId: "armadra-desktop-host-launch",
    protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
  });
  const response = await send(endpoint, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-protobuf",
      Accept: "application/x-protobuf",
    },
    body: toBinary(HelloRequestSchema, request) as BodyInit,
  });
  const denied = checkOrigin(
    response.status,
    response.headers.get("access-control-allow-origin"),
    origin,
  );
  if (denied) failHost(denied);
  if (!checkHelloContentType(response.headers.get("content-type"))) {
    failHost(hostError("invalidHello"));
  }
  const declared = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declared) && declared > STDOUT_LIMIT) {
    failHost(hostError("httpOutputLimit"));
  }
  const wire = await readBounded(response, STDOUT_LIMIT);
  const mismatch = checkHello(wire, status);
  if (mismatch) failHost(mismatch);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout and an unreachable endpoint are different answers: one means
    // the Host is slow, the other that nothing is there.
    const timedOut =
      error instanceof DOMException && error.name === "TimeoutError";
    failHost(hostError(timedOut ? "httpTimeout" : "httpUnavailable"));
  }
}

/**
 * Reads the body, refusing to grow past the limit. A declared
 * `Content-Length` is checked first, but a chunked answer can lie about — or
 * omit — it, so the running total is the check that actually holds.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      failHost(hostError("httpUnavailable"));
    }
    if (step.done) break;
    const chunk = step.value;
    if (chunk.length > limit - total) failHost(hostError("httpOutputLimit"));
    total += chunk.length;
    chunks.push(chunk);
  }
  const wire = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    wire.set(chunk, offset);
    offset += chunk.length;
  }
  return wire;
}
