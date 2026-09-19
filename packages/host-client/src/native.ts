import { HostIdentityError } from "./identity.js";

export { isNativePageOrigin } from "./origins.js";

export interface HostNativeCredentialsOptions {
  /**
   * Produces one fresh one-time pairing ticket from the shell's private
   * channel — the JSON the `armadra-host pair` command prints, or its bare
   * `ticket` value. It is called only when no session is held or the held one
   * was refused, and never concurrently.
   */
  ticket: () => Promise<string>;
}

/** Only the bearer secret this transport actually uses is ever compared. */
const secretPattern = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** Refresh this long before the access token would expire. */
const ACCESS_MARGIN_MS = 30_000;

/**
 * The page's one copy of a native session: access, refresh and CSRF, in
 * memory only. Several `HostIdentityClient`s share it, so a rotation done by
 * one is seen by all and never invalidates another's request: every client
 * that uses it also queues through {@link HostNativeCredentials.serial}.
 *
 * Nothing here is persisted, logged, or put in a URL. Disposing a client does
 * not clear it; only Logout, a self-revocation or an explicit `clear()` does.
 */
export class HostNativeCredentials {
  #access = "";
  #refresh = "";
  #csrf = "";
  #accessExpiresAtMs = 0;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #ticket: () => Promise<string>;
  constructor(options: HostNativeCredentialsOptions) {
    if (typeof options?.ticket !== "function")
      throw new HostIdentityError("INVALID_OPTIONS");
    this.#ticket = options.ticket;
  }
  /** Whether a session is held at all (it may still need a refresh). */
  get signedIn(): boolean {
    return this.#refresh !== "";
  }
  /** Transport use only: the bearer for ordinary requests. */
  get access(): string {
    return this.#access;
  }
  /** Transport use only: the bearer for Refresh / RenewCsrf / Logout. */
  get refresh(): string {
    return this.#refresh;
  }
  /** Transport use only: the session-bound header a mutation carries. */
  get csrf(): string {
    return this.#csrf;
  }
  /** True while the access token can still be presented without a refresh. */
  accessFresh(nowMs: number): boolean {
    return (
      this.#access !== "" && nowMs < this.#accessExpiresAtMs - ACCESS_MARGIN_MS
    );
  }
  /** Transport use only: the Host's answer to Pair or Refresh. */
  store(
    access: string,
    refresh: string,
    csrf: string,
    accessExpiresAtMs: number,
  ): void {
    if (!secretPattern.test(access) || !secretPattern.test(refresh))
      throw new HostIdentityError("MALFORMED_RESPONSE");
    this.#access = access;
    this.#refresh = refresh;
    this.#csrf = csrf;
    this.#accessExpiresAtMs = Number.isFinite(accessExpiresAtMs)
      ? accessExpiresAtMs
      : 0;
  }
  /** Transport use only: RenewCsrf rotates the CSRF alone. */
  setCsrf(csrf: string): void {
    this.#csrf = csrf;
  }
  clear(): void {
    this.#access = "";
    this.#refresh = "";
    this.#csrf = "";
    this.#accessExpiresAtMs = 0;
  }
  /**
   * One queue for every client sharing these credentials. Rotations are
   * atomic on the Host, so two clients refreshing at once would leave one of
   * them holding a spent token; serializing them here is what prevents that.
   */
  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }
  /** Asks the shell for a ticket. Whatever it throws reaches the caller. */
  async ticket(): Promise<string> {
    const material = await this.#ticket();
    if (typeof material !== "string" || !material.trim())
      throw new HostIdentityError("INVALID_OPTIONS");
    return material;
  }
}
