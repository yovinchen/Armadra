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
 * The origins a packaged Tauri page could be served from. W1.2 replaces these
 * with the shell's real loopback HTTP origin; until the static server exists
 * the Electron shell grants exactly what the Rust shell granted, so a Host
 * started by either shell answers both.
 */
export const NATIVE_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

export const STDOUT_LIMIT = 1_048_576;
export const STDERR_LIMIT = 65_536;
export const HTTP_TIMEOUT_MS = 3_000;
export const MAX_CLI_TIMEOUT_MS = 15_000;

export interface HostLaunchConfig {
  readonly binary: string;
  readonly dataDir?: string | undefined;
  readonly browserOrigin: string;
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
  if ((NATIVE_ORIGINS as readonly string[]).includes(origin)) return true;
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
    (config.expectedHttpEndpoint !== undefined &&
      !validEndpoint(config.expectedHttpEndpoint));
  return invalid ? hostError("invalidConfiguration") : undefined;
}

export function hostBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "armadra-host.exe" : "armadra-host";
}

/**
 * Where the Host binary is. A packaged shell takes the one beside itself and
 * ignores every development override — an installed application must not be
 * redirectable by an environment variable. A development shell honours
 * `ARMADRA_HOST_BINARY`, then `CARGO_TARGET_DIR`, then the repo's `target/`.
 *
 * The result is required to be absolute either way: a relative program name
 * would be resolved against `PATH`, which is not a location this shell chose.
 */
export function resolveBinary(
  development: boolean,
  executable: string,
  repo: string,
  overridePath: string | undefined,
  targetDir: string | undefined,
  platform: string = process.platform,
): { ok: true; binary: string } | { ok: false; error: HostLaunchError } {
  const name = hostBinaryName(platform);
  let binary: string;
  if (!development) {
    const parent = parentOf(executable);
    if (parent === undefined)
      return { ok: false, error: hostError("invalidConfiguration") };
    binary = join(parent, name);
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

function parentOf(path: string): string | undefined {
  const parent = join(path, "..");
  return parent === path ? undefined : parent;
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
    for (const origin of NATIVE_ORIGINS) args.push("--allow-origin", origin);
    if (!(NATIVE_ORIGINS as readonly string[]).includes(config.browserOrigin)) {
      args.push("--allow-origin", config.browserOrigin);
    }
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
