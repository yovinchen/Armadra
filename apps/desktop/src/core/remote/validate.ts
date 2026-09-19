/**
 * `POST /api/execution-hosts/{id}/validate` — reachability *and* the version
 * handshake, in one answer.
 *
 * Ported from `validate_execution_host` in
 * `apps/runtime/src/api/execution_hosts.rs`, and the reason the two questions
 * are deliberately not collapsed into one is unchanged: `ssh` can work
 * perfectly while the Worker is missing or is a different Armadra build, and a
 * person who is told only "failed" cannot tell which of the two they have to
 * fix.
 *
 * The TypeScript port adds a **third** separable answer for the same reason
 * the first two exist. The remote Worker here is a JavaScript bundle, so a
 * reachable host with no Node cannot run one — and reporting that as
 * `handshakeRefused` would send the person to look for an Armadra install that
 * was never the problem. It gets its own reason key, `nodeMissing`, and its
 * own message naming the version required.
 *
 * Not gated on settings ownership: it runs a command on a machine and stores
 * nothing.
 */

import type { SshHost } from "../settings/ssh-hosts";
import { probeArgv } from "../terminal/ssh/argv";
import { tail } from "../terminal/ssh/redact";
import { runCommand } from "../terminal/ssh/run";
import { probeNode, unsupportedMessage, type NodeProbe } from "./node-probe";
import type { RemoteWorker } from "./worker";

/** How long the reachability probe gets. The line itself says `ConnectTimeout=5`. */
const PROBE_TIMEOUT_MS = 20_000;

/** A stable key the UI translates, never a sentence. */
export type ValidationReason =
  | "unreachable"
  | "noWorkerConfigured"
  | "nodeMissing"
  | "handshakeRefused";

/** What one validation found. camelCase, contract §5.1. */
export interface ExecutionHostValidation {
  readonly executionHostId: string;
  /** Whether `ssh … true` exited zero. */
  readonly reachable: boolean;
  /**
   * Whether the Worker started and its handshake was accepted. `false` while
   * `reachable` is `true` is the case worth separating: the machine answers,
   * the Armadra Worker on it does not.
   */
  readonly workerOk: boolean;
  readonly platform?: string;
  readonly architecture?: string;
  readonly runtimeVersion?: string;
  readonly capabilities?: readonly string[];
  /** The Node the far side reported, when it has one. */
  readonly nodeVersion?: string;
  readonly reason?: ValidationReason;
  /**
   * The redacted tail of whatever diagnostics were produced. Absent when
   * everything worked.
   */
  readonly detail?: string;
}

export interface SshTestResult {
  readonly ok: boolean;
  /** The tail of ssh's own diagnostics, redacted. Never a full transcript. */
  readonly output: string;
}

/**
 * Run the reachability probe once.
 *
 * Separate from the route so the execution host validation asks the same
 * question the settings page's own button asks, rather than a second one that
 * could answer differently.
 */
export async function probeHost(
  dataDir: string,
  host: SshHost,
  launcher?: string,
): Promise<SshTestResult> {
  const argv = probeArgv(dataDir, host);
  const program = launcher ?? (argv[0] as string);
  argv.shift();
  const output = await runCommand(program, argv, {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (output.spawnError !== undefined) {
    return { ok: false, output: tail(`ssh 起不来：${output.spawnError}`) };
  }
  const text = output.stderr.trim() === "" ? output.stdout : output.stderr;
  return { ok: output.code === 0, output: tail(text) };
}

export interface ValidateDeps {
  readonly dataDir: string;
  /** `undefined` when the id names no configured host. */
  readonly host: SshHost | undefined;
  /** Built only when the host has a Worker and a usable Node. */
  readonly worker: (host: SshHost) => RemoteWorker;
  readonly launcher?: string | undefined;
  /** Injected so a test can answer without an `ssh` on the machine. */
  readonly probe?: (host: SshHost) => Promise<SshTestResult>;
  readonly node?: (host: SshHost) => Promise<NodeProbe>;
}

/** The whole validation, in the order each answer excludes the next. */
export async function validateExecutionHost(
  hostId: string,
  deps: ValidateDeps,
): Promise<ExecutionHostValidation> {
  const host = deps.host;
  if (host === undefined) {
    throw new ValidationRefused(404, "not_found", "No such execution host");
  }
  const probe = await (deps.probe ?? ((h) => probeHost(deps.dataDir, h, deps.launcher)))(host);
  if (!probe.ok) {
    return {
      executionHostId: hostId,
      reachable: false,
      workerOk: false,
      reason: "unreachable",
      ...(probe.output === "" ? {} : { detail: probe.output }),
    };
  }
  if (host.worker === undefined) {
    // Reachable and usable for terminals, but no workspace can execute on it.
    // Saying so is the whole point of a separate flag.
    return {
      executionHostId: hostId,
      reachable: true,
      workerOk: false,
      reason: "noWorkerConfigured",
      ...(probe.output === "" ? {} : { detail: probe.output }),
    };
  }
  const node = await (deps.node ?? ((h) => probeNode(deps.dataDir, h)))(host);
  if (!node.usable) {
    return {
      executionHostId: hostId,
      reachable: true,
      workerOk: false,
      ...(node.version === undefined ? {} : { nodeVersion: node.version }),
      reason: "nodeMissing",
      detail: unsupportedMessage(host, node),
    };
  }
  try {
    const hello = await deps.worker(host).probe();
    return {
      executionHostId: hostId,
      reachable: true,
      workerOk: true,
      platform: hello.platform,
      architecture: hello.architecture,
      runtimeVersion: hello.runtimeVersion,
      capabilities: [...hello.capabilities],
      ...(node.version === undefined ? {} : { nodeVersion: node.version }),
    };
  } catch (failure) {
    return {
      executionHostId: hostId,
      reachable: true,
      workerOk: false,
      ...(node.version === undefined ? {} : { nodeVersion: node.version }),
      reason: "handshakeRefused",
      detail: tail(
        failure instanceof Error ? failure.message : String(failure),
      ),
    };
  }
}

/** A validation that could not be processed at all, rather than one that failed. */
export class ValidationRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationRefused";
  }
}
