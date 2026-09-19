/**
 * Why the Host could not be launched or trusted — the variants of
 * `src-tauri/src/host/mod.rs:38-58`, carried across as a TypeScript union.
 *
 * Every value is a stable token. None of them carries subprocess stderr, an
 * environment, a raw HTTP error or a path: the shell reports *that* startup
 * failed and which rule failed, never the material it was reading when it did.
 * `cliExit` carries the exit code alone, which is the one detail that is
 * actionable and cannot leak anything.
 */
export type HostLaunchError =
  | { readonly kind: "invalidConfiguration" }
  | { readonly kind: "binaryUnavailable" }
  | { readonly kind: "cliSpawn" }
  | { readonly kind: "cliExit"; readonly code: number | null }
  | { readonly kind: "cliIo" }
  | { readonly kind: "cliTimeout" }
  | { readonly kind: "cliCleanupTimeout" }
  | { readonly kind: "cliOutputLimit" }
  | { readonly kind: "malformedResult" }
  | { readonly kind: "notRunning" }
  | { readonly kind: "endpointMismatch" }
  | { readonly kind: "httpUnavailable" }
  | { readonly kind: "httpTimeout" }
  | { readonly kind: "httpOutputLimit" }
  | { readonly kind: "originDenied" }
  | { readonly kind: "invalidHello" }
  | { readonly kind: "protocolMismatch" }
  | { readonly kind: "identityMismatch" };

export type HostLaunchErrorKind = HostLaunchError["kind"];

export function hostError(
  kind: Exclude<HostLaunchErrorKind, "cliExit">,
): HostLaunchError {
  return { kind } as HostLaunchError;
}

export function cliExit(code: number | null): HostLaunchError {
  return { kind: "cliExit", code };
}

/** The sentence the shell is allowed to show. Mirrors the Rust `Display`. */
export function describeHostError(error: HostLaunchError): string {
  if (error.kind === "cliExit") {
    return `Host CLI exited unsuccessfully (${error.code === null ? "None" : `Some(${error.code})`})`;
  }
  return `Host startup unavailable (${error.kind})`;
}

/** An error carrying a `HostLaunchError`, so it can travel through `throw`. */
export class HostLaunchFailure extends Error {
  readonly detail: HostLaunchError;

  constructor(detail: HostLaunchError) {
    super(describeHostError(detail));
    this.name = "HostLaunchFailure";
    this.detail = detail;
  }
}

export function failHost(detail: HostLaunchError): never {
  throw new HostLaunchFailure(detail);
}

/** Reads the variant back out of anything thrown by the Host adapter. */
export function hostErrorOf(thrown: unknown): HostLaunchError | undefined {
  return thrown instanceof HostLaunchFailure ? thrown.detail : undefined;
}
