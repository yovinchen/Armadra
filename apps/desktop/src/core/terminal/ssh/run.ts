/**
 * Run one short-lived command and collect what it said.
 *
 * Every `ssh`, `ssh-keyscan` and `ssh-keygen` invocation in this domain is the
 * same shape — argv (never a shell string), stdin closed, a deadline, and the
 * two streams read to the end — so it is one function rather than five copies
 * of `spawn` plumbing. The Rust side gets the same thing from
 * `tokio::process::Command::output` under a `tokio::time::timeout`.
 *
 * `stdin` is `ignore` rather than inherited on purpose: a child that inherited
 * the core's stdin could consume the shell's input, and `ssh` reading a TTY it
 * was not meant to have is precisely what the askpass helper exists to avoid.
 */

import { spawn } from "node:child_process";

export interface RunOptions {
  readonly timeoutMs: number;
  /** Extra variables for the child. The parent environment is inherited. */
  readonly env?: readonly (readonly [string, string])[];
}

export interface RunResult {
  /** `undefined` when the process was killed before it could exit. */
  readonly code: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** The program could not be started at all. */
  readonly spawnError?: string;
}

export async function runCommand(
  program: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(program, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...Object.fromEntries(options.env ?? []),
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      finish({
        code: undefined,
        stdout,
        stderr,
        timedOut,
        spawnError: error.message,
      });
    });
    child.on("close", (code) => {
      finish({ code: code ?? undefined, stdout, stderr, timedOut });
    });
  });
}
