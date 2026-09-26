/**
 * A hand-rolled HTTP/1.1 client, the same one the Rust client carries.
 *
 * We only ever talk to a loopback TCP port or a unix socket owned by the same
 * user, so there is no TLS, no redirect handling, no keep-alive and no
 * connection pool. `node:http` is not used because it reorders and rewrites
 * headers (`Host`, `Connection`, capitalisation) and the exact bytes are the
 * contract here: the pre-merge implementation asserts the header list in order.
 */

import * as net from "node:net";

import { envVar } from "./endpoint.js";
import type { Endpoint } from "./endpoint.js";

/** How long a single connect attempt may take. */
export const CONNECT_TIMEOUT_MS = 500;
/** How long the whole request/response exchange may take, by default. */
export const TOTAL_TIMEOUT_MS = 1500;

/**
 * The default budget, with an escape hatch for callers on a slow box. The Rust
 * client has no such knob; `ARMADRA_HOOK_TIMEOUT_MS` exists here because a
 * JavaScript client pays an interpreter start before the first connect, and a
 * user on a loaded machine needs a way to widen the window without rebuilding.
 * Out-of-range and unparseable values fall back to the Rust constant.
 */
export function totalTimeoutMs(): number {
  const raw = envVar("ARMADRA_HOOK_TIMEOUT_MS");
  if (raw === undefined) return TOTAL_TIMEOUT_MS;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 600_000
    ? parsed
    : TOTAL_TIMEOUT_MS;
}

/**
 * Everything needed to render one request, kept as data so tests can assert on
 * the exact bytes without opening a socket.
 */
export interface HookRequest {
  method: "GET" | "POST";
  path: string;
  headers: [string, string][];
  body?: Buffer;
}

export function getRequest(
  path: string,
  headers: [string, string][],
): HookRequest {
  return { method: "GET", path, headers };
}

export function postJsonRequest(
  path: string,
  headers: [string, string][],
  body: Buffer,
): HookRequest {
  return { method: "POST", path, headers, body };
}

/**
 * Serialises the request exactly as it goes on the wire.
 *
 * Header order is fixed (`Host`, `Connection`, caller headers, then the
 * content headers) so that the integration tests can byte-compare.
 */
export function requestBytes(request: HookRequest): Buffer {
  const lines = [
    `${request.method} ${request.path} HTTP/1.1\r\n`,
    "Host: 127.0.0.1\r\n",
    "Connection: close\r\n",
    ...request.headers.map(([name, value]) => `${name}: ${value}\r\n`),
  ];
  if (request.body !== undefined) {
    lines.push("Content-Type: application/json\r\n");
    lines.push(`Content-Length: ${request.body.length}\r\n`);
  }
  lines.push("\r\n");
  const head = Buffer.from(lines.join(""), "utf8");
  return request.body === undefined
    ? head
    : Buffer.concat([head, request.body]);
}

/** A parsed response. The body is small, so it is buffered whole. */
export interface HookResponse {
  status: number;
  contentType?: string;
  body: string;
}

export function isSuccess(response: HookResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * Sends `request` to the runtime, preferring the unix socket and falling back
 * to loopback TCP. The two attempts share one budget so a hanging socket
 * cannot make the hook take twice as long.
 */
/**
 * A failed exchange. `sent` means the request bytes had already left: the
 * runtime may have acted on them, so nobody may send the same request again —
 * a resent `open-agent` opens a second node, a resent `click` clicks twice.
 */
export interface SendFailure {
  readonly error: string;
  readonly sent?: boolean;
}

export async function send(
  endpoint: Endpoint,
  request: HookRequest,
  total = totalTimeoutMs(),
): Promise<{ ok: HookResponse } | SendFailure> {
  const deadline = Date.now() + total;
  const bytes = requestBytes(request);
  let lastError = "no transport configured";

  if (endpoint.sock !== undefined && process.platform !== "win32") {
    const attempt = await exchange(
      { path: endpoint.sock },
      bytes,
      deadline,
      `cannot connect to ${endpoint.sock}`,
    );
    if ("ok" in attempt) return attempt;
    // Delivered but unanswered: falling back to TCP would send it twice.
    if (attempt.sent === true) return attempt;
    lastError = attempt.error;
  }

  if (endpoint.port !== undefined) {
    const attempt = await exchange(
      { host: "127.0.0.1", port: endpoint.port },
      bytes,
      deadline,
      `cannot connect to 127.0.0.1:${endpoint.port}`,
    );
    if ("ok" in attempt) return attempt;
    lastError = attempt.error;
  }

  return { error: lastError };
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * One connect + write + read-to-completion. Resolves with a response the
 * moment the framing says the answer is whole, so a peer that holds the socket
 * open past a bodyless `204` does not burn the budget.
 */
function exchange(
  target: net.NetConnectOpts,
  bytes: Buffer,
  deadline: number,
  connectLabel: string,
): Promise<{ ok: HookResponse } | SendFailure> {
  return new Promise((resolve) => {
    if (remaining(deadline) === 0) {
      resolve({ error: `${connectLabel}: timed out before connecting` });
      return;
    }
    let settled = false;
    const chunks: Buffer[] = [];
    let connected = false;
    let received = 0;

    const socket = net.connect(target);
    socket.setNoDelay(true);

    const finish = (outcome: { ok: HookResponse } | SendFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      socket.destroy();
      resolve(outcome);
    };

    /**
     * Turns a socket failure into a success when the bytes already in hand are
     * a complete response: the runtime answers a hook report with a bodyless
     * `204` and closes at once, and reporting the reset as a transport error
     * would throw away an answer we have already received.
     */
    const finishWithError = (message: string): void => {
      const complete = tryParse(Buffer.concat(chunks));
      finish(
        complete === undefined
          ? { error: message, sent: connected }
          : { ok: complete },
      );
    };

    const connectTimer = setTimeout(
      () => {
        if (!connected) finishWithError(`${connectLabel}: Operation timed out`);
      },
      Math.min(CONNECT_TIMEOUT_MS, Math.max(1, remaining(deadline))),
    );
    const totalTimer = setTimeout(
      () => finishWithError("cannot read response: timed out"),
      Math.max(1, remaining(deadline)),
    );

    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.write(bytes);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      // Stop early when the framing says we already have everything; some
      // servers hold the socket open past the final byte.
      const complete = tryParse(Buffer.concat(chunks));
      if (complete !== undefined) finish({ ok: complete });
      else if (received > 8 * 1024 * 1024)
        finish({ error: "hook response is implausibly large" });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finishWithError(`${connectLabel}: ${errnoText(error)}`);
    });
    socket.on("end", () => {
      const parsed = parseResponse(Buffer.concat(chunks));
      finish(
        "ok" in parsed ? parsed : { error: parsed.error, sent: connected },
      );
    });
    socket.on("close", () => {
      const parsed = parseResponse(Buffer.concat(chunks));
      finish(
        "ok" in parsed ? parsed : { error: parsed.error, sent: connected },
      );
    });
  });
}

function errnoText(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ECONNREFUSED":
      return "Connection refused (os error 61)";
    case "ENOENT":
      return "No such file or directory (os error 2)";
    default:
      return error.message;
  }
}

/** Statuses that RFC 9110 defines as carrying no body at all. */
function hasNoBody(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

function statusCode(head: string): number | undefined {
  const first = head.split("\r\n")[0] ?? "";
  const field = first.split(/\s+/)[1];
  return field !== undefined && /^\d+$/.test(field) ? Number(field) : undefined;
}

function headerValue(head: string, name: string): string | undefined {
  for (const line of head.split("\r\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() === name) {
      return line.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** Returns a response only when the buffer already contains a complete one. */
export function tryParse(raw: Buffer): HookResponse | undefined {
  const headEnd = raw.indexOf("\r\n\r\n");
  if (headEnd < 0) return undefined;
  const head = raw.subarray(0, headEnd + 4).toString("utf8");
  const body = raw.subarray(headEnd + 4);
  const status = statusCode(head);
  // A `204 No Content` names no length and sends no body, so without this the
  // loop would wait for an EOF the runtime's already-closed socket cannot
  // deliver and the report would look like a transport failure.
  if (status !== undefined && hasNoBody(status)) {
    const parsed = parseResponse(raw);
    return "ok" in parsed ? parsed.ok : undefined;
  }
  const chunked = (headerValue(head, "transfer-encoding") ?? "")
    .toLowerCase()
    .includes("chunked");
  if (chunked) {
    if (
      body.indexOf("\r\n0\r\n") >= 0 ||
      body.subarray(0, 3).toString("latin1") === "0\r\n"
    ) {
      const parsed = parseResponse(raw);
      return "ok" in parsed ? parsed.ok : undefined;
    }
    return undefined;
  }
  const length = headerValue(head, "content-length");
  if (length === undefined || !/^\d+$/.test(length.trim())) return undefined;
  if (body.length < Number(length.trim())) return undefined;
  const parsed = parseResponse(raw);
  return "ok" in parsed ? parsed.ok : undefined;
}

/** Parses a complete HTTP/1.1 response, decoding chunked bodies. */
export function parseResponse(
  raw: Buffer,
): { ok: HookResponse } | { error: string } {
  const headEnd = raw.indexOf("\r\n\r\n");
  if (headEnd < 0) return { error: "truncated response" };
  const head = raw.subarray(0, headEnd + 4).toString("utf8");
  const status = statusCode(head);
  if (status === undefined) {
    return { error: `unparseable status line: ${head.split("\r\n")[0] ?? ""}` };
  }
  const rawBody = raw.subarray(headEnd + 4);
  const chunked = (headerValue(head, "transfer-encoding") ?? "")
    .toLowerCase()
    .includes("chunked");
  const lengthHeader = headerValue(head, "content-length");
  let body: Buffer;
  if (hasNoBody(status)) {
    body = Buffer.alloc(0);
  } else if (chunked) {
    body = decodeChunked(rawBody);
  } else if (lengthHeader !== undefined && /^\d+$/.test(lengthHeader.trim())) {
    body = rawBody.subarray(
      0,
      Math.min(Number(lengthHeader.trim()), rawBody.length),
    );
  } else {
    body = rawBody;
  }
  return {
    ok: {
      status,
      contentType: headerValue(head, "content-type"),
      body: body.toString("utf8"),
    },
  };
}

function decodeChunked(input: Buffer): Buffer {
  const out: Buffer[] = [];
  let rest = input;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) break;
    const sizeText = (
      rest.subarray(0, lineEnd).toString("utf8").split(";")[0] ?? ""
    ).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) break;
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) break;
    const start = lineEnd + 2;
    const end = Math.min(start + size, rest.length);
    out.push(rest.subarray(start, end));
    if (end + 2 > rest.length) break;
    rest = rest.subarray(end + 2);
  }
  return Buffer.concat(out);
}
