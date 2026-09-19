import {
  create,
  fromBinary,
  toBinary,
  MAX_FRAME_BYTES,
  ErrorResponseSchema,
  PairDeviceRequestSchema,
  AuthenticatedSessionSchema,
  CurrentSessionRequestSchema,
  RefreshSessionRequestSchema,
  RenewCsrfRequestSchema,
  RenewCsrfResponseSchema,
  LogoutSessionRequestSchema,
  SessionClosedResponseSchema,
  ListDevicesRequestSchema,
  ListDevicesResponseSchema,
  RevokeDeviceRequestSchema,
  RevokeDeviceResponseSchema,
  type AuthenticatedSession,
  type ListDevicesResponse,
} from "@armadra/protocol";
import type { HostClientErrorCode } from "./index.js";
import type { HostNativeCredentials } from "./native.js";
import { isNativePageOrigin } from "./origins.js";

/** Secrets never reach a caller: neither the CSRF nor the native bearers. */
export type HostIdentitySession = Omit<
  AuthenticatedSession,
  "csrfToken" | "native"
>;
export type HostIdentityDevices = ListDevicesResponse;
/**
 * How credentials travel. The browser transport is the default: HttpOnly
 * cookies on the Host's HTTPS origin, which has to be the page's own. The
 * native transport is the packaged desktop shell's: plain loopback HTTP from
 * a native page origin, bearer secrets held in page memory, shared between
 * every client built on the same {@link HostNativeCredentials}
 * (docs/design/host-native-session.md §3).
 */
export type HostIdentityTransport =
  | { kind: "browser" }
  | { kind: "native"; credentials: HostNativeCredentials };
export interface HostIdentityClientOptions {
  baseUrl: string;
  hostId: string;
  hostInstanceId: string;
  /** Defaults to the actual browser page origin; required in non-browser tests. */
  pageOrigin?: string;
  transport?: HostIdentityTransport;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /**
   * Called whenever this client's CSRF token changes, including with `""` when
   * it is dropped. It exists so the page that owns this client can authorize
   * the *other* requests the same Host session covers — the Runtime calls the
   * Host proxies for a paired device — without a second holder renewing the
   * token behind this client's back. The value stays in memory: never store it,
   * put it in a URL, or send it anywhere but this Host's own origin.
   */
  onCsrfToken?: (token: string) => void;
}
/** Contains only stable metadata. Never retain a response body, ticket or URL. */
export class HostIdentityError extends Error {
  readonly name = "HostIdentityError";
  readonly retryable = false;
  constructor(
    readonly code: HostClientErrorCode,
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`Host identity request failed (${code}).`);
  }
}
const media = "application/x-protobuf";
const id = /^[0-9a-f]{32}$/;
const secret = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ticketPattern = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** Service and method names only; nothing that could reshape the request path. */
const servicePattern = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const remoteCodes = new Set([
  "INVALID_ARGUMENT",
  "UNSUPPORTED",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "BUSY",
  "TIMEOUT",
  "RESOURCE_EXHAUSTED",
  "UNKNOWN_OUTCOME",
  "INTERNAL",
]);
/** IdentityService methods whose bearer is the refresh secret, not access. */
const refreshBearer = new Set(["Refresh", "RenewCsrf", "Logout"]);
function invalid(): never {
  throw new HostIdentityError("INVALID_OPTIONS");
}
function unauthenticated(error: unknown): error is HostIdentityError {
  return (
    error instanceof HostIdentityError &&
    error.hostCode === "UNAUTHENTICATED" &&
    !error.outcomeUnknown
  );
}
function loopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}
/**
 * The page origin as the Host will see it in the `Origin` header. `URL.origin`
 * is `"null"` for a non-special scheme, so in that case it is spelled out from
 * the two parts that do survive. Every origin this library accepts is HTTP or
 * HTTPS, where `location.origin` is already the answer; the fallback is there
 * so an exotic host does not silently report no origin at all.
 */
function currentPageOrigin(): string | undefined {
  const location = globalThis.location;
  if (!location) return undefined;
  if (location.origin && location.origin !== "null") return location.origin;
  if (location.protocol && location.host)
    return `${location.protocol}//${location.host}`;
  return undefined;
}

function identityEndpoint(
  value: string,
  pageOrigin: string | undefined,
  native: boolean,
): URL {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  )
    invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  )
    invalid();
  if (native) {
    // The one combination the browser rule can never admit, and the only one
    // the native transport does: a loopback HTTP Host, asked by the desktop
    // shell's own page origin.
    if (
      url.protocol !== "http:" ||
      !loopbackHost(url.hostname) ||
      !isNativePageOrigin(pageOrigin)
    )
      invalid();
  } else if (url.protocol !== "https:" || pageOrigin !== url.origin) invalid();
  return url;
}
function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function bounded(
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
    throw new HostIdentityError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_FRAME_BYTES);
  let size = 0,
    complete = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        complete = true;
        return buffer.slice(0, size);
      }
      if (!(value instanceof Uint8Array))
        throw new HostIdentityError("MALFORMED_RESPONSE");
      if (value.byteLength > MAX_FRAME_BYTES - size)
        throw new HostIdentityError("RESPONSE_TOO_LARGE");
      buffer.set(value, size);
      size += value.byteLength;
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Browser Cookie transport by default: access/refresh are never read by
 * JavaScript. Mutations are serialized, never automatically retried, and CSRF
 * is private memory. Dispose on Host changes; a late transport cannot revive
 * old state. The native transport keeps the same rules with the secrets in a
 * shared {@link HostNativeCredentials} instead of cookies. */
export class HostIdentityClient {
  #url: URL;
  #hostId: string;
  #instanceId: string;
  #pageOrigin: string;
  #fetch: typeof fetch;
  #timeout: number;
  #csrf = "";
  #onCsrf?: (token: string) => void;
  #deviceId = "";
  #native?: HostNativeCredentials;
  #lifetime = new AbortController();
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: HostIdentityClientOptions) {
    this.#onCsrf = options.onCsrfToken;
    const transport = options.transport ?? { kind: "browser" };
    if (transport.kind === "native") {
      if (
        !transport.credentials ||
        typeof transport.credentials.serial !== "function"
      )
        invalid();
      this.#native = transport.credentials;
    } else if (transport.kind !== "browser") invalid();
    const pageOrigin = options.pageOrigin ?? currentPageOrigin();
    this.#url = identityEndpoint(
      options.baseUrl,
      pageOrigin,
      this.#native !== undefined,
    );
    this.#pageOrigin = pageOrigin ?? "";
    if (!id.test(options.hostId) || !id.test(options.hostInstanceId)) invalid();
    this.#hostId = options.hostId;
    this.#instanceId = options.hostInstanceId;
    this.#timeout = options.timeoutMs ?? 10_000;
    if (
      !Number.isFinite(this.#timeout) ||
      this.#timeout <= 0 ||
      this.#timeout > 2_147_483_647
    )
      invalid();
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") invalid();
    this.#fetch = fetcher.bind(globalThis);
  }
  #csrfToken(): string {
    return this.#native ? this.#native.csrf : this.#csrf;
  }
  // One assignment point, so every rotation and every drop is observed. A
  // listener that throws must not take the request down with it.
  #setCsrf(token: string): void {
    if (this.#native) this.#native.setCsrf(token);
    else this.#csrf = token;
    try {
      this.#onCsrf?.(token);
    } catch {
      /* A page that mishandles its own token still gets its response. */
    }
  }
  dispose(): void {
    // Shared native credentials outlive this client; only its own view ends.
    if (this.#native) {
      try {
        this.#onCsrf?.("");
      } catch {
        /* As above. */
      }
    } else this.#setCsrf("");
    this.#deviceId = "";
    this.#lifetime.abort(new HostIdentityError("CANCELLED"));
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const run = () => {
      if (this.#lifetime.signal.aborted)
        throw new HostIdentityError("CANCELLED");
      return action().then((value) => {
        if (this.#lifetime.signal.aborted)
          throw new HostIdentityError("CANCELLED");
        return value;
      });
    };
    // Clients sharing native credentials share one queue, so a rotation by
    // one never races a request from another.
    if (this.#native) return this.#native.serial(run);
    const result = this.#tail.then(run);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #rpc<T>(
    service: string,
    action: string,
    body: Uint8Array,
    decode: (wire: Uint8Array) => T,
    mutation: boolean,
    csrf = false,
  ): Promise<T> {
    const controller = new AbortController();
    let dispatched = false;
    const cancel = () =>
      controller.abort(
        new HostIdentityError("CANCELLED", mutation && dispatched),
      );
    this.#lifetime.signal.addEventListener("abort", cancel, { once: true });
    if (this.#lifetime.signal.aborted) cancel();
    const timer = setTimeout(
      () =>
        controller.abort(
          new HostIdentityError("TIMEOUT", mutation && dispatched),
        ),
      this.#timeout,
    );
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (csrf && !this.#csrfToken())
        throw new HostIdentityError(
          "REMOTE_ERROR",
          false,
          401,
          "UNAUTHENTICATED",
        );
      const url = new URL(this.#url);
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc/armadra.v1.${service}/${action}`;
      const headers: Record<string, string> = {
        "Content-Type": media,
        Accept: media,
      };
      if (csrf) headers["X-Armadra-CSRF"] = this.#csrfToken();
      if (
        this.#native &&
        !(service === "IdentityService" && action === "Pair")
      ) {
        // Same secret, same purpose as the cookie the browser would send:
        // refresh for the three refresh-bound methods, access for the rest.
        const token =
          service === "IdentityService" && refreshBearer.has(action)
            ? this.#native.refresh
            : this.#native.access;
        if (!token)
          throw new HostIdentityError(
            "REMOTE_ERROR",
            false,
            401,
            "UNAUTHENTICATED",
          );
        headers.Authorization = `Bearer ${token}`;
      }
      dispatched = true;
      const pending = this.#fetch(url.href, {
        method: "POST",
        headers,
        body: new Uint8Array(body),
        credentials: this.#native ? "omit" : "include",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      void pending.then(
        (response) => {
          if (controller.signal.aborted) cancelBody(response.body);
        },
        () => {},
      );
      const response = await abortable(pending, controller.signal);
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== media
      ) {
        cancelBody(response.body);
        throw new HostIdentityError(
          response.ok ? "UNEXPECTED_CONTENT_TYPE" : "HTTP_ERROR",
          mutation,
          response.status,
        );
      }
      const wire = await bounded(response, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        let code: string;
        try {
          code = fromBinary(ErrorResponseSchema, wire).code;
        } catch {
          throw new HostIdentityError(
            "MALFORMED_RESPONSE",
            mutation,
            response.status,
          );
        }
        if (!code)
          throw new HostIdentityError(
            "MALFORMED_RESPONSE",
            mutation,
            response.status,
          );
        const known = remoteCodes.has(code) ? code : "UNKNOWN";
        throw new HostIdentityError(
          "REMOTE_ERROR",
          mutation && (response.status >= 500 || known === "UNKNOWN_OUTCOME"),
          response.status,
          known,
        );
      }
      try {
        return decode(wire);
      } catch (error) {
        if (error instanceof HostIdentityError) throw error;
        throw new HostIdentityError(
          "MALFORMED_RESPONSE",
          mutation,
          response.status,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof HostIdentityError) {
        if (
          mutation &&
          dispatched &&
          ["RESPONSE_TOO_LARGE", "MALFORMED_RESPONSE"].includes(error.code)
        )
          throw new HostIdentityError(
            error.code,
            true,
            error.httpStatus,
            error.hostCode,
          );
        throw error;
      }
      throw new HostIdentityError("NETWORK_ERROR", mutation && dispatched);
    } finally {
      clearTimeout(timer);
      this.#lifetime.signal.removeEventListener("abort", cancel);
    }
  }
  #session(wire: Uint8Array, needsCSRF: boolean): HostIdentitySession {
    if (this.#lifetime.signal.aborted) throw new HostIdentityError("CANCELLED");
    const value = fromBinary(AuthenticatedSessionSchema, wire);
    if (
      value.hostId !== this.#hostId ||
      !value.device ||
      !id.test(value.device.deviceId) ||
      !id.test(value.device.principalId) ||
      value.device.revision < 1n ||
      value.device.role !== "owner" ||
      value.expiresAtUnixMs <= 0n ||
      !value.device.displayName ||
      value.scopes.length === 0 ||
      (needsCSRF && !secret.test(value.csrfToken))
    )
      throw new HostIdentityError("MALFORMED_RESPONSE");
    if (needsCSRF && this.#native) {
      // Pair and Refresh answer the native transport with the bearers the
      // cookies would otherwise carry; `expiresAtUnixMs` is the access expiry.
      const native = value.native;
      if (!native) throw new HostIdentityError("MALFORMED_RESPONSE");
      this.#native.store(
        native.accessToken,
        native.refreshToken,
        value.csrfToken,
        Number(value.expiresAtUnixMs),
      );
    }
    if (needsCSRF) this.#setCsrf(value.csrfToken);
    this.#deviceId = value.device.deviceId;
    const { csrfToken: _, native: __, ...visible } = value;
    return visible;
  }
  #current(): Promise<HostIdentitySession> {
    return this.#rpc(
      "IdentityService",
      "Current",
      toBinary(
        CurrentSessionRequestSchema,
        create(CurrentSessionRequestSchema),
      ),
      (wire) => this.#session(wire, false),
      false,
    );
  }
  async #renew(): Promise<void> {
    const value = await this.#rpc(
      "IdentityService",
      "RenewCsrf",
      toBinary(RenewCsrfRequestSchema, create(RenewCsrfRequestSchema)),
      (wire) => fromBinary(RenewCsrfResponseSchema, wire),
      true,
    );
    if (this.#lifetime.signal.aborted) throw new HostIdentityError("CANCELLED");
    if (!secret.test(value.csrfToken))
      throw new HostIdentityError("MALFORMED_RESPONSE", true);
    this.#setCsrf(value.csrfToken);
  }
  #refresh(): Promise<HostIdentitySession> {
    return this.#rpc(
      "IdentityService",
      "Refresh",
      toBinary(
        RefreshSessionRequestSchema,
        create(RefreshSessionRequestSchema),
      ),
      (wire) => this.#session(wire, true),
      true,
      true,
    );
  }
  /** Rotate the native session: recover a CSRF if none is held, then refresh. */
  async #refreshNative(): Promise<HostIdentitySession> {
    if (!this.#csrfToken()) await this.#renew();
    return this.#refresh();
  }
  /** Bring a held native access token back within its validity window. */
  async #freshen(): Promise<void> {
    const native = this.#native;
    if (native?.signedIn && !native.accessFresh(Date.now()))
      await this.#refreshNative();
  }
  /**
   * The native reopen flow. Held credentials are reused — refreshed only when
   * the access token is near expiry — and a session the Host no longer knows
   * (a restart, a revocation) is replaced by pairing with a fresh ticket from
   * the shell rather than reported as signed out: in the shell there is
   * nobody to paste a ticket.
   */
  async #resumeNative(
    native: HostNativeCredentials,
  ): Promise<HostIdentitySession> {
    if (native.signedIn) {
      try {
        if (native.accessFresh(Date.now())) return await this.#current();
        return await this.#refreshNative();
      } catch (error) {
        if (!unauthenticated(error)) throw error;
      }
      try {
        return await this.#refreshNative();
      } catch (error) {
        if (!unauthenticated(error)) throw error;
        native.clear();
        this.#deviceId = "";
      }
    }
    return this.#pair(await native.ticket());
  }
  /** Reopen flow: read Current, recover a bound CSRF, then rotate credentials.
   * Only an explicit UNAUTHENTICATED response permits trying refresh recovery. */
  resume(): Promise<HostIdentitySession | null> {
    const native = this.#native;
    if (native) return this.#serial(() => this.#resumeNative(native));
    return this.#serial(async () => {
      this.#setCsrf("");
      try {
        await this.#current();
      } catch (error) {
        if (
          !(error instanceof HostIdentityError) ||
          error.hostCode !== "UNAUTHENTICATED"
        )
          throw error;
      }
      try {
        await this.#renew();
        return await this.#refresh();
      } catch (error) {
        this.#setCsrf("");
        if (
          error instanceof HostIdentityError &&
          error.hostCode === "UNAUTHENTICATED"
        ) {
          this.#deviceId = "";
          return null;
        }
        throw error;
      }
    });
  }
  current(): Promise<HostIdentitySession> {
    return this.#serial(async () => {
      await this.#freshen();
      return this.#current();
    });
  }
  /**
   * Sends one request to another Host service over this signed-in session: the
   * same cookies, the same serialization queue, and — for a mutation — the CSRF
   * token this client renews and holds privately. The token never leaves the
   * class, and the raw response body is returned so the caller owns decoding.
   */
  send(
    service: string,
    action: string,
    body: Uint8Array,
    mutation: boolean,
  ): Promise<Uint8Array> {
    return this.#serial(async () => {
      if (
        !servicePattern.test(service) ||
        !servicePattern.test(action) ||
        !(body instanceof Uint8Array) ||
        body.byteLength > MAX_FRAME_BYTES
      )
        invalid();
      await this.#freshen();
      if (mutation && !this.#csrfToken()) await this.#renew();
      const dispatch = () =>
        this.#rpc(service, action, body, (wire) => wire, mutation, mutation);
      if (!this.#native) return dispatch();
      try {
        return await dispatch();
      } catch (error) {
        // A 401 means the Host did not run the request, so one rotation and
        // one retry are safe even for a mutation. Anything else propagates.
        if (!unauthenticated(error)) throw error;
        await this.#refreshNative();
        return dispatch();
      }
    });
  }
  async #pair(material: string): Promise<HostIdentitySession> {
    let ticket = material.trim();
    if (ticket.length > 8192) invalid();
    if (ticket.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ticket);
      } catch {
        return invalid();
      }
      if (!parsed || typeof parsed !== "object") invalid();
      const value = parsed as Record<string, unknown>;
      if (
        value.hostId !== this.#hostId ||
        value.hostInstanceId !== this.#instanceId ||
        value.origin !== this.#pageOrigin ||
        typeof value.ticket !== "string" ||
        typeof value.expiresAtUnixMs !== "string" ||
        !/^\d{1,19}$/.test(value.expiresAtUnixMs) ||
        BigInt(value.expiresAtUnixMs) <= BigInt(Date.now())
      )
        invalid();
      ticket = value.ticket;
    }
    if (!ticketPattern.test(ticket)) invalid();
    return this.#rpc(
      "IdentityService",
      "Pair",
      toBinary(
        PairDeviceRequestSchema,
        create(PairDeviceRequestSchema, {
          expectedHostId: this.#hostId,
          expectedInstanceId: this.#instanceId,
          ticket,
        }),
      ),
      (wire) => this.#session(wire, true),
      true,
    );
  }
  pair(material: string): Promise<HostIdentitySession> {
    return this.#serial(() => this.#pair(material));
  }
  refresh(): Promise<HostIdentitySession> {
    return this.#serial(async () => {
      if (!this.#csrfToken()) await this.#renew();
      return this.#refresh();
    });
  }
  listDevices(afterId = "", limit = 50): Promise<HostIdentityDevices> {
    return this.#serial(async () => {
      if (
        (afterId && !id.test(afterId)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        invalid();
      const page = await this.#rpc(
        "IdentityService",
        "ListDevices",
        toBinary(
          ListDevicesRequestSchema,
          create(ListDevicesRequestSchema, { afterId, limit }),
        ),
        (wire) => fromBinary(ListDevicesResponseSchema, wire),
        false,
      );
      if (
        page.devices.length > limit ||
        page.devices.some(
          (device) =>
            !id.test(device.deviceId) ||
            !id.test(device.principalId) ||
            device.revision < 1n ||
            !device.displayName,
        ) ||
        (page.hasMore && (!id.test(page.nextId) || page.nextId === afterId))
      )
        throw new HostIdentityError("MALFORMED_RESPONSE");
      return page;
    });
  }
  revokeDevice(deviceId: string, expectedRevision: bigint): Promise<void> {
    return this.#serial(async () => {
      if (
        !id.test(deviceId) ||
        expectedRevision < 1n ||
        expectedRevision > 9_223_372_036_854_775_807n
      )
        invalid();
      await this.#freshen();
      if (!this.#csrfToken()) await this.#renew();
      const value = await this.#rpc(
        "IdentityService",
        "RevokeDevice",
        toBinary(
          RevokeDeviceRequestSchema,
          create(RevokeDeviceRequestSchema, { deviceId, expectedRevision }),
        ),
        (wire) => fromBinary(RevokeDeviceResponseSchema, wire),
        true,
        true,
      );
      if (!value.revoked || value.deviceId !== deviceId)
        throw new HostIdentityError("MALFORMED_RESPONSE", true);
      if (deviceId === this.#deviceId) {
        this.#native?.clear();
        this.#setCsrf("");
        this.#deviceId = "";
      }
    });
  }
  logout(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#csrfToken()) await this.#renew();
      const value = await this.#rpc(
        "IdentityService",
        "Logout",
        toBinary(
          LogoutSessionRequestSchema,
          create(LogoutSessionRequestSchema),
        ),
        (wire) => fromBinary(SessionClosedResponseSchema, wire),
        true,
        true,
      );
      if (!value.closed)
        throw new HostIdentityError("MALFORMED_RESPONSE", true);
      this.#native?.clear();
      this.#setCsrf("");
      this.#deviceId = "";
    });
  }
}
