import {
  create,
  fromBinary,
  toBinary,
  HelloRequestSchema,
  HelloResponseSchema,
  ErrorResponseSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type HelloResponse,
} from "@armadra/protocol";

export type { HelloResponse, CapabilityStatus } from "@armadra/protocol";
/** Explicitly unsupported surfaces a Host names in Hello (H04 / S02). */
export { CapabilityState } from "@armadra/protocol";

export type HostClientErrorCode =
  | "INVALID_OPTIONS"
  | "NETWORK_ERROR"
  | "CANCELLED"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "UNEXPECTED_CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "MALFORMED_RESPONSE"
  | "INCOMPATIBLE_PROTOCOL"
  | "REMOTE_ERROR";

const hostCodes = [
  "INVALID_ARGUMENT",
  "UNSUPPORTED",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "STALE_GENERATION",
  "DISCONNECTED",
  "BUSY",
  "TIMEOUT",
  "RESOURCE_EXHAUSTED",
  "UNKNOWN_OUTCOME",
  "SNAPSHOT_REQUIRED",
] as const;
export type HostErrorCode = (typeof hostCodes)[number] | "UNKNOWN";

/** Only stable, sanitized metadata is retained; no URL, raw body, or cause. */
export class HostClientError extends Error {
  readonly name = "HostClientError";
  constructor(
    readonly code: HostClientErrorCode,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly hostCode?: HostErrorCode,
  ) {
    super(`Host request failed (${code}).`);
  }
}

export interface HostClientOptions {
  baseUrl: string;
  clientId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function invalidOptions(): never {
  throw new HostClientError("INVALID_OPTIONS", false);
}

function endpoint(baseUrl: string): string {
  if (typeof baseUrl !== "string" || baseUrl !== baseUrl.trim())
    invalidOptions();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return invalidOptions();
  }
  if (
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    !["http:", "https:"].includes(url.protocol)
  )
    invalidOptions();
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "localhost." ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback) invalidOptions();
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc/armadra.v1.HostService/Hello`;
  return url.href;
}

function retryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function abortError(signal: AbortSignal): HostClientError {
  return signal.reason instanceof HostClientError
    ? signal.reason
    : new HostClientError("CANCELLED", false);
}

// Also handles injected fetch implementations/streams that do not implement
// AbortSignal themselves. All pending work receives a rejection handler.
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (
    length &&
    /^\d+$/.test(length) &&
    BigInt(length) > BigInt(MAX_FRAME_BYTES)
  ) {
    cancelBody(response.body);
    throw new HostClientError("RESPONSE_TOO_LARGE", false, response.status);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  // Single bounded buffer prevents an attacker from retaining unbounded
  // per-chunk metadata through a stream of tiny or zero-length chunks.
  const buffer = new Uint8Array(MAX_FRAME_BYTES);
  let size = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        completed = true;
        return buffer.slice(0, size);
      }
      if (!(value instanceof Uint8Array))
        throw new HostClientError("MALFORMED_RESPONSE", false, response.status);
      if (value.byteLength > MAX_FRAME_BYTES - size)
        throw new HostClientError("RESPONSE_TOO_LARGE", false, response.status);
      buffer.set(value, size);
      size += value.byteLength;
    }
  } finally {
    // Never await a hostile underlying source's cancel promise; the caller's
    // timeout/cancellation must settle even if the transport never settles.
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class HostClient {
  private readonly url: string;
  private readonly clientId: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: HostClientOptions) {
    this.url = endpoint(options.baseUrl);
    if (
      typeof options.clientId !== "string" ||
      !options.clientId.trim() ||
      new TextEncoder().encode(options.clientId).byteLength > 256
    )
      invalidOptions();
    this.clientId = options.clientId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    // Browser timers above the signed 32-bit limit overflow to a short timeout.
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    )
      invalidOptions();
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") invalidOptions();
    this.fetcher = fetcher.bind(globalThis);
  }

  /** Reads capabilities once. Never retries or assumes unadvertised features. */
  async hello(options: { signal?: AbortSignal } = {}): Promise<HelloResponse> {
    const controller = new AbortController();
    const onAbort = () =>
      controller.abort(new HostClientError("CANCELLED", false));
    const signal = options.signal;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(
      () => controller.abort(new HostClientError("TIMEOUT", true)),
      this.timeoutMs,
    );
    try {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const request = create(HelloRequestSchema, {
        clientId: this.clientId,
        protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      });
      const pending = this.fetcher(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          Accept: "application/x-protobuf",
        },
        body: new Uint8Array(toBinary(HelloRequestSchema, request)),
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      // An injected transport may resolve after timeout; dispose its late body.
      void pending.then(
        (response) => {
          if (controller.signal.aborted) cancelBody(response.body);
        },
        () => {},
      );
      const response = await abortable(pending, controller.signal);
      const type = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (type !== "application/x-protobuf") {
        cancelBody(response.body);
        throw new HostClientError(
          response.ok ? "UNEXPECTED_CONTENT_TYPE" : "HTTP_ERROR",
          !response.ok && retryableStatus(response.status),
          response.status,
        );
      }
      const wire = await readBounded(response, controller.signal);
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (!response.ok) {
        let remote;
        try {
          remote = fromBinary(ErrorResponseSchema, wire);
        } catch {
          throw new HostClientError(
            "MALFORMED_RESPONSE",
            false,
            response.status,
          );
        }
        if (!remote.code)
          throw new HostClientError(
            "MALFORMED_RESPONSE",
            false,
            response.status,
          );
        const hostCode: HostErrorCode = hostCodes.includes(
          remote.code as Exclude<HostErrorCode, "UNKNOWN">,
        )
          ? (remote.code as HostErrorCode)
          : "UNKNOWN";
        const retryable =
          ["BUSY", "DISCONNECTED", "TIMEOUT", "RESOURCE_EXHAUSTED"].includes(
            hostCode,
          ) && retryableStatus(response.status);
        throw new HostClientError(
          "REMOTE_ERROR",
          retryable,
          response.status,
          hostCode,
        );
      }
      let hello: HelloResponse;
      try {
        hello = fromBinary(HelloResponseSchema, wire);
      } catch {
        throw new HostClientError("MALFORMED_RESPONSE", false, response.status);
      }
      if (
        !hello.protocol ||
        !hello.hostInstanceId.trim() ||
        hello.maxFrameBytes === 0
      )
        throw new HostClientError("MALFORMED_RESPONSE", false, response.status);
      if (
        hello.protocol.major !== PROTOCOL_MAJOR ||
        hello.protocol.minor > PROTOCOL_MINOR
      )
        throw new HostClientError(
          "INCOMPATIBLE_PROTOCOL",
          false,
          response.status,
        );
      if (hello.protocol.minor >= 1 && !hello.hostId.trim())
        throw new HostClientError("MALFORMED_RESPONSE", false, response.status);
      return hello;
    } catch (error) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (error instanceof HostClientError) throw error;
      throw new HostClientError("NETWORK_ERROR", true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
export * from "./identity.js";
export * from "./automation.js";
export * from "./github.js";
export * from "./updates.js";
