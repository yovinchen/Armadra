import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import {
  type HostLaunchConfig,
  STDERR_LIMIT,
  STDOUT_LIMIT,
  startArguments,
  validate,
} from "../../shell-core/host/config";
import {
  type HostLaunchError,
  cliExit,
  failHost,
  hostError,
} from "../../shell-core/host/errors";

/**
 * Running the short-lived Go CLI child that reports the Host, with bounded
 * reads of everything it writes.
 *
 * This module owns ONLY the CLI child. The Host itself detaches and is never
 * held, signalled, or identified by the PID its result reports — the launcher
 * record (`--launcher desktop`) is what decides whose Host may be stopped.
 *
 * Ported from `src-tauri/src/host/launch.rs`.
 */

/** Reads a stream to its end, refusing more than `limit` bytes. */
export async function readLimited(
  stream: AsyncIterable<Buffer | string>,
  limit: number,
  retain: boolean,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length > limit - total) failHost(hostError("cliOutputLimit"));
    total += buffer.length;
    // stderr is drained but never retained: it is the one stream that could
    // carry a credential the CLI printed while failing.
    if (retain) chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface CliOutcome {
  readonly stdout: Uint8Array;
}

/**
 * Runs one short-lived management command of the Host CLI and returns its
 * stdout, bounded by `stdoutLimit`. Every command the shell issues goes
 * through here, so they share the same timeout, the same bounded readers and
 * the same rule that stderr is drained but never retained.
 */
export async function runCli(
  config: HostLaunchConfig,
  args: string[],
  stdoutLimit: number,
  onSpawn: (pid: number) => void = () => {},
): Promise<Uint8Array> {
  const invalid = validate(config);
  if (invalid) failHost(invalid);
  if (!isFile(config.binary)) failHost(hostError("binaryUnavailable"));

  let child: ChildProcess;
  try {
    child = spawn(config.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // CREATE_NO_WINDOW affects the CLI only.
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
  } catch {
    failHost(hostError("cliSpawn"));
  }
  if (child.pid === undefined) failHost(hostError("cliIo"));
  onSpawn(child.pid);
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) failHost(hostError("cliIo"));

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutMarker()), config.cliTimeoutMs);
  });

  let failure: HostLaunchError | undefined;
  let output: Uint8Array | undefined;
  try {
    const [collected, , status] = await Promise.race([
      Promise.all([
        readLimited(stdout, stdoutLimit, true),
        readLimited(stderr, STDERR_LIMIT, false),
        exitOf(child),
      ]),
      timeout,
    ]);
    if (status.code !== 0) failure = cliExit(status.code);
    else output = collected;
  } catch (error) {
    failure =
      error instanceof TimeoutMarker
        ? hostError("cliTimeout")
        : ((error as { detail?: HostLaunchError }).detail ??
          hostError("cliIo"));
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (failure !== undefined) {
    // Kill and reap this precise CLI parent, never a process group or the Host
    // PID reported in its result. The independently detached Host may survive.
    child.kill("SIGKILL");
    const reaped = await Promise.race([
      exitOf(child).then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 2_000)),
    ]);
    // Keep the cleanup bounded even if the OS cannot reap promptly.
    if (!reaped) failHost(hostError("cliCleanupTimeout"));
    failHost(failure);
  }
  return output as Uint8Array;
}

class TimeoutMarker extends Error {}

function exitOf(child: ChildProcess): Promise<{ code: number | null }> {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode });
  return new Promise((done, fail) => {
    child.once("error", () => fail(new Error("cliIo")));
    // A signalled child has no exit code; treat that as an unsuccessful exit
    // rather than as success with a null code.
    child.once("exit", (code, signal) =>
      done({ code: signal === null ? code : null }),
    );
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function runStart(
  config: HostLaunchConfig,
  onSpawn?: (pid: number) => void,
): Promise<Uint8Array> {
  return runCli(config, startArguments(config), STDOUT_LIMIT, onSpawn);
}
