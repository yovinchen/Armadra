import { type ChildProcess, spawn } from "node:child_process";
import { restrictedEnvironment } from "./access";
import { conflict, internalError, sanitize } from "./support";

/**
 * The one place a Git child process is started.
 *
 * A port of the pre-merge implementation, which spawns Git the same way
 * for different owners. What both establish, and what this keeps:
 *
 *   * **The environment is a lockdown, not a suggestion.** Every variable that
 *     could redirect Git at another repository, another config or an external
 *     helper is removed, and the prompt / askpass / pager settings are fixed.
 *     A caller may add variables (the interactive rebase's sequence editor is
 *     the only one that does) and they are applied *last*, so nothing a caller
 *     passes can weaken the list above it.
 *   * **Output is bounded.** stdout and stderr each have a ceiling; passing it
 *     is an error rather than a truncated answer that reads as success.
 *   * **A cancelled or timed-out child is killed and then waited for.** The
 *     outcome of such a command is unknown, never "did not happen", and the
 *     caller is told exactly that.
 */

const STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
/** The repository service's own, smaller ceilings. */
export const REPOSITORY_STDOUT_LIMIT = 4 * 1024 * 1024;
export const REPOSITORY_STDERR_LIMIT = 64 * 1024;

/** How many Git children this process will own at once. */
const MAX_CONCURRENT = 64;

/** Variables removed outright before Git runs. */
const OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_CURL_VERBOSE",
];

const PREFIXES = ["GIT_TRACE", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

export interface GitEnvironmentOptions {
  /** Applied after the lockdown; the rebase sequence editor only. */
  readonly extra?: Readonly<Record<string, string>>;
  /** Without the execution grant, helpers and lazy fetches are refused too. */
  readonly restrict?: boolean;
  /**
   * The askpass helper `core/remote` publishes, so an `ssh://` remote can ask
   * a person for a passphrase instead of failing on a missing TTY. Absent means
   * no helper is configured and both askpass variables stay empty — which is
   * what refuses the prompt rather than hanging on it.
   */
  readonly askpass?: string;
}

/**
 * The environment one Git child runs with.
 *
 * Built from `ambient` rather than from scratch: Git needs `PATH`, `HOME` and
 * the platform's own variables to find its exec path and the user's config.
 * What it must not inherit is anything in {@link OVERRIDES} or matching
 * {@link PREFIXES}.
 */
export function gitEnvironment(
  options: GitEnvironmentOptions = {},
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...ambient };
  for (const key of Object.keys(environment)) {
    if (
      OVERRIDES.includes(key) ||
      PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete environment[key];
    }
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_ASKPASS = options.askpass ?? "";
  environment.SSH_ASKPASS = options.askpass ?? "";
  if (options.askpass !== undefined) environment.SSH_ASKPASS_REQUIRE = "force";
  environment.GCM_INTERACTIVE = "never";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.LC_ALL = "C";
  if (options.restrict === true) {
    for (const [key, value] of Object.entries(restrictedEnvironment())) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    environment[key] = value;
  }
  return environment;
}

/** The fixed prefix every legacy-surface Git command carries. */
export const LEGACY_PREFIX = [
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
];

/** The repository service adds one more: a fixed log output encoding. */
export const REPOSITORY_PREFIX = [
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "i18n.logOutputEncoding=UTF-8",
];

export interface CommandOutput {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** `null` when the child was killed by a signal rather than exiting. */
  readonly status: number | null;
}

export interface RunOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly prefix?: readonly string[];
  readonly timeoutMs: number;
  readonly environment?: GitEnvironmentOptions;
  readonly stdoutLimit?: number;
  readonly stderrLimit?: number;
  /** Bytes written to the child's stdin; absent closes it immediately. */
  readonly input?: Buffer;
  /** Called with each completed stderr line, for `--progress` counters. */
  readonly onStderrLine?: (line: string) => void;
  /** Set as soon as the child exists: from here the outcome is unknown. */
  readonly onStarted?: () => void;
  readonly signal?: AbortSignal;
}

let active = 0;
let stopping = false;
let cleanupFailed = false;
const running = new Set<ChildProcess>();

/** How many Git children this process currently owns. */
export function activeCommands(): number {
  return active;
}

/**
 * Refuse new commands, kill the ones in flight and wait for them to be reaped.
 *
 * `shutdown_legacy_operations` in Rust; the same contract, including that an
 * unconfirmed cleanup is reported rather than swallowed.
 */
export async function shutdown(timeoutMs: number): Promise<void> {
  stopping = true;
  for (const child of running) child.kill("SIGKILL");
  const deadline = Date.now() + timeoutMs;
  while (running.size > 0) {
    if (Date.now() > deadline) {
      throw internalError(
        "Some Git processes did not stop before the deadline",
      );
    }
    await sleep(20);
  }
  if (cleanupFailed) {
    throw internalError("Git child cleanup requires inspection");
  }
}

/** Lets a test start from a clean slate after exercising {@link shutdown}. */
export function resume(): void {
  stopping = false;
  cleanupFailed = false;
}

export async function runGit(options: RunOptions): Promise<CommandOutput> {
  if (stopping) throw conflict("Git service is shutting down");
  if (active >= MAX_CONCURRENT) {
    throw conflict("Too many active Git processes");
  }
  if (options.signal?.aborted === true) {
    throw conflict("Git process cancelled before launch");
  }
  active += 1;
  try {
    return await capture(options);
  } finally {
    active -= 1;
  }
}

function capture(options: RunOptions): Promise<CommandOutput> {
  const stdoutLimit = options.stdoutLimit ?? STDOUT_LIMIT;
  const stderrLimit = options.stderrLimit ?? STDERR_LIMIT;
  const child = spawn(
    "git",
    [...(options.prefix ?? LEGACY_PREFIX), ...options.args],
    {
      cwd: options.cwd,
      env: gitEnvironment(options.environment),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  running.add(child);
  options.onStarted?.();

  return new Promise<CommandOutput>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = "";
    let settled = false;
    let exit: { code: number | null } | undefined;
    let closedStreams = 0;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        running.delete(child);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          status: exit?.code ?? null,
        });
        return;
      }
      // The outcome of a killed command is unknown, so the kill is confirmed
      // before the caller is told anything at all.
      child.kill("SIGKILL");
      const reap = setTimeout(() => {
        cleanupFailed = true;
        running.delete(child);
        reject(internalError("Git process cleanup was not confirmed"));
      }, 2_000);
      child.once("close", () => {
        clearTimeout(reap);
        running.delete(child);
        reject(error);
      });
    };

    const timer = setTimeout(() => {
      finish(
        internalError(
          "Git process timed out; its outcome requires verification before retrying",
        ),
      );
    }, options.timeoutMs);
    const onAbort = (): void => {
      finish(
        conflict(
          "Git process cancelled; its outcome requires verification before retrying",
        ),
      );
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutLimit) {
        finish(
          internalError(
            "Git output exceeded its bounded budget; verify repository state before retrying",
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (options.onStderrLine !== undefined) {
        // Git writes progress with carriage returns rather than newlines, so
        // both count as a line end. The buffer is bounded the same way the
        // read is: a remote that never writes a separator cannot grow it.
        pending += chunk.toString("utf8");
        let index = pending.search(/[\r\n]/);
        while (index >= 0) {
          options.onStderrLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.search(/[\r\n]/);
        }
        if (pending.length > 4096) pending = pending.slice(-4096);
      }
      stderrBytes += chunk.byteLength;
      if (stderrBytes > stderrLimit) {
        // stderr is progress as often as it is an error; the progress reader
        // keeps only a bounded tail rather than failing the command.
        if (options.onStderrLine !== undefined) {
          stderr.push(chunk);
          let total = stderr.reduce((sum, part) => sum + part.byteLength, 0);
          while (total > stderrLimit && stderr.length > 1) {
            total -= (stderr.shift() as Buffer).byteLength;
          }
          return;
        }
        finish(
          internalError(
            "Git output exceeded its bounded budget; verify repository state before retrying",
          ),
        );
        return;
      }
      stderr.push(chunk);
    });

    const streamClosed = (): void => {
      closedStreams += 1;
      if (closedStreams === 2 && exit !== undefined) {
        if (pending !== "") options.onStderrLine?.(pending);
        finish();
      }
    };
    child.stdout?.once("end", streamClosed);
    child.stderr?.once("end", streamClosed);

    child.once("error", () => {
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      reject(internalError("Could not start Git"));
    });
    child.once("exit", (code) => {
      exit = { code };
      if (closedStreams === 2) {
        if (pending !== "") options.onStderrLine?.(pending);
        finish();
      }
    });

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

/** `Receiving objects:  47% (470/1000)` → 47, or `undefined`. */
export function progressPercent(line: string): number | undefined {
  const marker = line.indexOf("%");
  if (marker < 0) return undefined;
  let start = marker;
  while (start > 0 && /[0-9]/.test(line[start - 1] as string)) start -= 1;
  if (start === marker) return undefined;
  const percent = Number.parseInt(line.slice(start, marker), 10);
  return Number.isNaN(percent) || percent > 100 ? undefined : percent;
}

/** The refusal a non-zero exit becomes on the legacy surface. */
export function commandFailure(output: CommandOutput): Error {
  return internalError(sanitize(output.stderr.toString("utf8")));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
