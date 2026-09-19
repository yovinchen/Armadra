import { isAbsolute, join } from "node:path";
import { type HostLaunchError, hostError } from "./errors";

/**
 * How the Host is launched: the binary, the flags, and the rules a
 * configuration has to satisfy before any of it reaches a process.
 *
 * Ported from `src-tauri/src/host/mod.rs:71-194` and
 * `src-tauri/src/host/launch.rs:18-58`. Nothing here runs anything; the
 * argument vector is built as data so the exact line can be asserted without
 * a Host on the machine.
 */

export const HOST_ENDPOINT = "http://127.0.0.1:43121";
export const HELLO_PATH = "/rpc/armadra.v1.HostService/Hello";

/**
 * Whether an origin is one a desktop shell can present: the loopback HTTP
 * origin its static server binds.
 *
 * This is the shell's copy of the rule the Host enforces in
 * `apps/host/internal/server/native.go:loopbackHTTPOrigin`, and the one the
 * page applies in `packages/host-client/src/native.ts`. All three have to
 * agree on the same string or a ticket is minted for an origin that cannot
 * spend it; the tests on each side pin the same table.
 *
 * It is a spelling check, not an authorization. The shell's port is
 * kernel-assigned, so there is no constant to compare against; what makes a
 * loopback HTTP origin a shell origin is that nothing off this machine can be
 * behind it, and the ticket still only ever comes from the same-user control
 * channel.
 */
export function nativeOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // `parsed.origin === origin` rejects a path, a query, or credentials: an
  // origin is a scheme, a host and a port and nothing else.
  if (parsed.protocol !== "http:" || parsed.origin !== origin) return false;
  return loopbackHostname(parsed.hostname);
}

/** Loopback as the Host reads it: `localhost`, `::1`, or any `127.0.0.0/8`. */
export function loopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export const STDOUT_LIMIT = 1_048_576;
export const STDERR_LIMIT = 65_536;
export const HTTP_TIMEOUT_MS = 3_000;
export const MAX_CLI_TIMEOUT_MS = 15_000;

export interface HostLaunchConfig {
  readonly binary: string;
  readonly dataDir?: string | undefined;
  /**
   * The page's own origin — the one the window will actually load from, and
   * the only one a ticket is ever minted for.
   */
  readonly browserOrigin: string;
  /**
   * Further origins the Host may answer, beyond the page's own.
   * Development adds apps/web's dev server here so the same Host
   * serves the shell's window and a browser tab opened on the same front end;
   * neither can mint a ticket, which is what makes the extra grant cheap.
   */
  readonly additionalOrigins?: readonly string[] | undefined;
  readonly cliTimeoutMs: number;
  /**
   * The shared `endpoints.json` directory — the Runtime's data directory, so
   * both services describe themselves in one document (roadmap §4.4).
   */
  readonly endpointsDir?: string | undefined;
  /**
   * `undefined` asks the Host for no TCP surface at all: it then answers only
   * on the same-user control IPC, and reports an empty `httpEndpoint`. Both
   * the packaged and the development shell keep the loopback endpoint.
   */
  readonly expectedHttpEndpoint?: string | undefined;
}

export function validOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    // An origin is a scheme, host and port and nothing else; a path or query
    // means the caller handed us a URL and called it an origin.
    parsed.origin === origin
  );
}

export function validEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port !== "" &&
    Number(parsed.port) > 0 &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.origin === endpoint
  );
}

/** `undefined` when the configuration is usable, the reason when it is not. */
export function validate(
  config: HostLaunchConfig,
): HostLaunchError | undefined {
  const invalid =
    !isAbsolute(config.binary) ||
    (config.dataDir !== undefined && !isAbsolute(config.dataDir)) ||
    (config.endpointsDir !== undefined && !isAbsolute(config.endpointsDir)) ||
    config.cliTimeoutMs <= 0 ||
    config.cliTimeoutMs > MAX_CLI_TIMEOUT_MS ||
    !validOrigin(config.browserOrigin) ||
    (config.additionalOrigins ?? []).some((origin) => !validOrigin(origin)) ||
    (config.expectedHttpEndpoint !== undefined &&
      !validEndpoint(config.expectedHttpEndpoint));
  return invalid ? hostError("invalidConfiguration") : undefined;
}

/**
 * Where the Host should listen. The documented port, unless a DEVELOPMENT
 * shell asks for another one.
 *
 * The override exists because one machine can have several Armadras: an
 * installed application's Host already holds 43121, and a shell started from
 * a checkout has to be able to stand beside it rather than fail to start. A
 * packaged shell ignores it outright — an installed application must not be
 * redirectable by an environment variable, the same rule `resolveBinary`
 * applies to the binary itself.
 *
 * A malformed override is passed through rather than swallowed, so `validate`
 * refuses the configuration. Falling back to the default would start a Host
 * somewhere the developer did not ask for, and returning `undefined` would
 * mean something else entirely: no listener at all.
 */
export function hostEndpoint(
  development: boolean,
  override: string | undefined,
): string {
  if (!development || override === undefined || override === "")
    return HOST_ENDPOINT;
  return override.startsWith("http://") ? override : `http://${override}`;
}

export function hostBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "armadra-host.exe" : "armadra-host";
}

/**
 * Where the Host binary is.
 *
 * A packaged shell takes the one electron-builder's `extraResources` staged,
 * which is `process.resourcesPath` — the SAME place the Runtime is looked for
 * (`runtime-process.ts`). It used to be resolved beside `process.execPath`
 * (`Contents/MacOS/`), which is where the Tauri shell's sidecars lived and
 * where nothing is staged now: a double-clicked `.app` found no Host at all.
 *
 * It ignores every development override — an installed application must not be
 * redirectable by an environment variable. A development shell honours
 * `ARMADRA_HOST_BINARY`, then `CARGO_TARGET_DIR`, then the repo's `target/`.
 *
 * The result is required to be absolute either way: a relative program name
 * would be resolved against `PATH`, which is not a location this shell chose.
 */
export function resolveBinary(
  development: boolean,
  resourcesPath: string,
  repo: string,
  overridePath: string | undefined,
  targetDir: string | undefined,
  platform: string = process.platform,
): { ok: true; binary: string } | { ok: false; error: HostLaunchError } {
  const name = hostBinaryName(platform);
  let binary: string;
  if (!development) {
    if (!isAbsolute(resourcesPath))
      return { ok: false, error: hostError("invalidConfiguration") };
    binary = join(resourcesPath, name);
  } else if (overridePath !== undefined) {
    binary = overridePath;
  } else {
    const chosen = targetDir && targetDir.length > 0 ? targetDir : undefined;
    const target =
      chosen === undefined
        ? join(repo, "target")
        : isAbsolute(chosen)
          ? chosen
          : join(repo, chosen);
    binary = join(target, "debug", name);
  }
  if (!isAbsolute(binary))
    return { ok: false, error: hostError("invalidConfiguration") };
  return { ok: true, binary };
}

/**
 * The exact `start` line. `--launcher desktop` is how the Host records that
 * this shell started it: two Hosts can share a machine, and only their own
 * launcher may stop or replace them (design §3.4). Without the record a
 * desktop update would either stop somebody's installed service or refuse to
 * stop the Host it started itself.
 */
export function startArguments(config: HostLaunchConfig): string[] {
  // A Host with no listener has nothing to grant an origin *to*, and rejects
  // --allow-origin outright; it also reports an empty endpoint, which is why
  // "none" and `undefined` have to agree.
  const listen =
    config.expectedHttpEndpoint === undefined
      ? "none"
      : stripHttpPrefix(config.expectedHttpEndpoint);
  const args = [
    "start",
    "--output",
    "protobuf",
    "--launcher",
    "desktop",
    "--listen",
    listen,
  ];
  if (config.expectedHttpEndpoint !== undefined) {
    // Order is the declaration order, and each origin is granted exactly
    // once: the Host refuses a repeated --allow-origin, and a line that
    // differs between two starts of the same shell is one nobody can diff.
    const granted = new Set<string>([
      config.browserOrigin,
      ...(config.additionalOrigins ?? []),
    ]);
    for (const origin of granted) args.push("--allow-origin", origin);
  }
  if (config.endpointsDir !== undefined)
    args.push("--endpoints-dir", config.endpointsDir);
  if (config.dataDir !== undefined) args.push("--data-dir", config.dataDir);
  return args;
}

export function stopArguments(config: HostLaunchConfig): string[] {
  const args = ["stop", "--output", "protobuf"];
  if (config.dataDir !== undefined) args.push("--data-dir", config.dataDir);
  return args;
}

function stripHttpPrefix(endpoint: string): string {
  const prefix = "http://";
  if (!endpoint.startsWith(prefix)) {
    // validate() has already refused anything else; this is the assertion.
    throw new Error("host endpoint was not validated before use");
  }
  return endpoint.slice(prefix.length);
}
