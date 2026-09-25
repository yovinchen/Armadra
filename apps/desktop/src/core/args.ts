import { type ListenSpec, parseListenSpec } from "./listen";

/**
 * The core's command line.
 *
 * Deliberately the Rust Runtime's, minus the modes that are going away:
 * `--listen` repeats, `--data-dir` names the directory, `--help` prints and
 * exits 0. The shell writes these arguments and either implementation reads
 * them, so a flag that differs is a flag that breaks the switch.
 */
export const USAGE = `Usage: armadra-core [--listen SPEC]... [--data-dir DIRECTORY]

--listen may be repeated; each spec is one of
  tcp:ADDR:PORT   loopback TCP; port 0 asks the kernel for a free one
  unix:PATH       Unix domain socket, 0600 (macOS / Linux)
  pipe:NAME       named pipe \\\\.\\pipe\\NAME (Windows)

With no --listen the core falls back to ARMADRA_RUNTIME_HOST /
ARMADRA_RUNTIME_PORT, and then to 127.0.0.1:43120.

       armadra-core worker --stdio [--state-dir DIRECTORY] [--language-link]

runs the remote Worker an execution host's controller reaches over ssh.`;

/** The core's default loopback port; the hook endpoint file advertises it. */
export const DEFAULT_PORT = 43120;

export interface CoreArguments {
  readonly listen: readonly ListenSpec[];
  readonly dataDir: string | undefined;
  /** `--desktop-control-stdin`: the shell owns this process and drives stdin. */
  readonly desktopControlStdin: boolean;
}

export type ArgumentsResult =
  | { readonly kind: "run"; readonly args: CoreArguments }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly reason: string };

export function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ArgumentsResult {
  const listen: ListenSpec[] = [];
  let dataDir: string | undefined;
  let desktopControlStdin = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--desktop-control-stdin") {
      desktopControlStdin = true;
      continue;
    }
    const valued = splitValued(argument, argv, index);
    if (valued === undefined) {
      return {
        kind: "error",
        reason: `unsupported core argument ${JSON.stringify(argument)}`,
      };
    }
    if (valued.consumedNext) index += 1;
    if (valued.value === undefined) {
      return { kind: "error", reason: `${valued.flag} needs a value` };
    }
    if (valued.flag === "--data-dir") {
      if (dataDir !== undefined) {
        return { kind: "error", reason: "--data-dir may only be given once" };
      }
      dataDir = valued.value;
      continue;
    }
    const spec = parseListenSpec(valued.value);
    if (!spec.ok) return { kind: "error", reason: spec.reason };
    listen.push(spec.spec);
  }
  if (listen.length === 0) {
    const fallback = defaultListen(env);
    if (!fallback.ok) return { kind: "error", reason: fallback.reason };
    listen.push(fallback.spec);
  }
  return { kind: "run", args: { listen, dataDir, desktopControlStdin } };
}

interface Valued {
  readonly flag: string;
  readonly value: string | undefined;
  readonly consumedNext: boolean;
}

/** `--flag value` and `--flag=value` are the same flag, spelled two ways. */
function splitValued(
  argument: string,
  argv: readonly string[],
  index: number,
): Valued | undefined {
  for (const flag of ["--listen", "--data-dir"]) {
    if (argument === flag) {
      return { flag, value: argv[index + 1], consumedNext: true };
    }
    if (argument.startsWith(`${flag}=`)) {
      const value = argument.slice(flag.length + 1);
      return {
        flag,
        value: value === "" ? undefined : value,
        consumedNext: false,
      };
    }
  }
  return undefined;
}

/**
 * What the core listens on when nobody said. `ARMADRA_RUNTIME_HOST` /
 * `ARMADRA_RUNTIME_PORT` stay the explicit override they always were, and the
 * fallback stays `127.0.0.1:43120`.
 */
function defaultListen(
  env: NodeJS.ProcessEnv,
): { ok: true; spec: ListenSpec } | { ok: false; reason: string } {
  const host = env.ARMADRA_RUNTIME_HOST || "127.0.0.1";
  const raw = env.ARMADRA_RUNTIME_PORT || String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, reason: "ARMADRA_RUNTIME_PORT must be a valid port" };
  }
  const parsed = parseListenSpec(`tcp:${host}:${port}`);
  return parsed.ok
    ? { ok: true, spec: parsed.spec }
    : {
        ok: false,
        reason: `ARMADRA_RUNTIME_HOST/PORT is not an address: ${host}:${port}`,
      };
}

/**
 * `worker --stdio [--state-dir DIR] [--language-link]` — the remote Worker.
 *
 * The words are the ones the controller's `workerArgv` writes, and nothing
 * else is accepted: the far side is started by a line this build composed,
 * so an unknown word means the two ends disagree about the protocol and the
 * right answer is to refuse before a single frame is exchanged.
 */
export type WorkerArgumentsResult =
  | {
      readonly kind: "worker";
      readonly args: {
        readonly stdio: boolean;
        readonly stateDir: string | undefined;
        readonly languageLink: boolean;
      };
    }
  | { readonly kind: "error"; readonly reason: string };

export function parseWorkerArguments(
  argv: readonly string[],
): WorkerArgumentsResult {
  let stdio = false;
  let languageLink = false;
  let stateDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--stdio") {
      stdio = true;
    } else if (argument === "--language-link") {
      languageLink = true;
    } else if (argument === "--state-dir") {
      const value = argv[index + 1];
      if (value === undefined || value === "") {
        return { kind: "error", reason: "--state-dir needs a value" };
      }
      stateDir = value;
      index += 1;
    } else {
      return {
        kind: "error",
        reason: `unsupported worker argument ${JSON.stringify(argument)}`,
      };
    }
  }
  if (!stdio) return { kind: "error", reason: "worker needs --stdio" };
  return { kind: "worker", args: { stdio, stateDir, languageLink } };
}
