import type { HostStatus } from "@armadra/protocol";
import {
  HOST_ENDPOINT,
  type HostLaunchConfig,
  MAX_CLI_TIMEOUT_MS,
  STDOUT_LIMIT,
  hostEndpoint,
  resolveBinary,
  stopArguments,
  validate,
} from "../../shell-core/host/config";
import { failHost, hostErrorOf } from "../../shell-core/host/errors";
import {
  decodeRunning,
  decodeStopped,
  portlessRunning,
} from "../../shell-core/host/verify";
import { repoRoot } from "../repo-root";
import { runCli, runStart } from "./launch";
import { verifyOrigin } from "./verify";

/**
 * Desktop discovery/startup adapter. It owns only the short-lived Go CLI
 * child, never the detached Host. No commands, flags, or process handles reach
 * the page.
 *
 * The launch line and the CLI child live in `./launch`; the checks that decide
 * whether an answer may be trusted live in `../../shell-core/host/` (pure) and
 * `./verify` (the HTTP round trips). Ported from `src-tauri/src/host/mod.rs`.
 */

export { HOST_ENDPOINT };

/**
 * A `stop` result is a two-byte protobuf. Anything approaching this is not
 * one, and reading it would only give a misbehaving CLI somewhere to put
 * output the shell has no use for (`lifecycle.rs:155-163`).
 */
export const STOP_OUTPUT_LIMIT = 4096;
export type { HostLaunchConfig };

/** The configuration this shell would use, or why there is none. */
export function configFromEnvironment(
  development: boolean,
  browserOrigin: string,
  endpointsDir: string,
  env: NodeJS.ProcessEnv = process.env,
  // `extraResources` stages the four binaries here, which is the same place
  // `runtimeExecutable` looks — one packaged layout, not two.
  resourcesPath: string = process.resourcesPath,
  repo: string = repoRoot(),
): HostLaunchConfig {
  const binary = resolveBinary(
    development,
    resourcesPath,
    repo,
    env.ARMADRA_HOST_BINARY,
    env.CARGO_TARGET_DIR,
  );
  if (!binary.ok) failHost(binary.error);
  const config: HostLaunchConfig = {
    binary: binary.binary,
    dataDir: env.ARMADRA_HOST_DATA_DIR,
    browserOrigin,
    cliTimeoutMs: MAX_CLI_TIMEOUT_MS,
    endpointsDir,
    // The loopback endpoint is what the page's session rides on. A packaged
    // shell always takes the documented port; a development one may be asked
    // for another, because an installed Armadra may already hold that port.
    expectedHttpEndpoint: hostEndpoint(development, env.ARMADRA_HOST_LISTEN),
  };
  const invalid = validate(config);
  if (invalid) failHost(invalid);
  return config;
}

/**
 * `start`, replacing at most once a Host this shell left behind without a port.
 *
 * `armadra-host start` answers with whatever instance already owns the data
 * directory, however it was configured. A packaged build before the native
 * session started its Host with `--listen none`; after an update the new shell
 * meets that instance, and the page could never reach it. That Host is ours to
 * replace — same launcher, same data directory — so it is stopped and `start`
 * runs again. Every other mismatch (a port that is not the one asked for)
 * still fails: that Host was configured by somebody else, and stopping it is
 * not this shell's call.
 */
export async function startRunning(
  config: HostLaunchConfig,
): Promise<Uint8Array> {
  const wire = await runStart(config);
  const decoded = decodeRunning(wire, config.expectedHttpEndpoint);
  if (decoded.ok) return wire;
  if (
    decoded.error.kind === "endpointMismatch" &&
    config.expectedHttpEndpoint !== undefined &&
    portlessRunning(wire)
  ) {
    await runCli(config, stopArguments(config), STDOUT_LIMIT);
    return runStart(config);
  }
  failHost(decoded.error);
}

export async function ensureHost(
  config: HostLaunchConfig,
): Promise<HostStatus> {
  const wire = await startRunning(config);
  const decoded = decodeRunning(wire, config.expectedHttpEndpoint);
  if (!decoded.ok) failHost(decoded.error);
  // There is no browser surface to probe when the Host holds no port; its
  // identity came back over the control IPC, which is already same-user only.
  if (config.expectedHttpEndpoint !== undefined) {
    await verifyOrigin(decoded.value, config.browserOrigin);
  }
  return decoded.value;
}

/**
 * Stops the Host and requires it to confirm. A non-zero exit, a result that is
 * not `stopped`, or a timeout are all failures — and a failure here is what
 * keeps the application from exiting (`lifecycle.ts`).
 */
export async function stopHost(config: HostLaunchConfig): Promise<void> {
  let wire: Uint8Array;
  try {
    wire = await runCli(config, stopArguments(config), STOP_OUTPUT_LIMIT);
  } catch (thrown) {
    const detail = hostErrorOf(thrown);
    if (detail?.kind === "cliTimeout" || detail?.kind === "cliCleanupTimeout") {
      throw new Error("Host shutdown timed out");
    }
    // The CLI's stderr is never echoed: it is the stream that could carry a
    // credential the Host printed while refusing.
    throw new Error("Host did not confirm complete shutdown");
  }
  if (!decodeStopped(wire)) throw new Error("Host is still running");
}
