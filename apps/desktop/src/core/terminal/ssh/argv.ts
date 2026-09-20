/**
 * The `ssh` command lines the core builds.
 *
 * Ported line for line from the pre-merge implementation. One rule
 * governs the whole file: **argv, never a shell string.** Each option is its
 * own array element, so a host called `a;rm -rf /` could at worst become one
 * meaningless `ssh` argument — and it never gets that far, because
 * `validateHost` (`core/settings/ssh-hosts.ts`) refuses it first.
 *
 * Every line here carries the two host-key options from
 * {@link knownHostsOptions}. That is not decoration: without them `ssh` falls
 * back to its own known_hosts handling, and an unknown key becomes either a
 * prompt on a TTY nobody is watching or an entry written to the user's file
 * without being asked.
 */

import type { SshHost, SshWorker } from "../../settings/ssh-hosts";
import { askpassOptions } from "./askpass";
import { options as knownHostsOptions } from "./known-hosts";

/**
 * The argv that starts the Worker on `host` over SSH:
 * `ssh -o BatchMode=no … destination <remote program> worker --stdio …`.
 *
 * No `-t`: stdin and stdout carry length-prefixed frames, and a TTY would
 * translate them. Prompting stays on, but only because it is routed to the
 * askpass helper — a prompt with nowhere to go would swallow the stream, and
 * an unreachable host has to fail rather than hang.
 *
 * `dataDir` is threaded through rather than read from a global because the
 * core is started with `--data-dir` and two of them can run at once; the Rust
 * side reads a process-global `paths::data_dir()` for the same value.
 */
export function workerArgv(
  dataDir: string,
  host: SshHost,
  worker: SshWorker,
): string[] {
  return argvFor(dataDir, host, worker, false);
}

/**
 * The same launch line with `--language-link`, for the second connection an
 * execution host gets while an editor has a language session on it.
 *
 * Everything about it — the options, the askpass helper, the host-key file,
 * the destination, the remote program, the state directory — is the first
 * connection's line. Only the one flag differs, so a host that can run a
 * Worker at all can run this without further setup.
 */
export function languageLinkArgv(
  dataDir: string,
  host: SshHost,
  worker: SshWorker,
): string[] {
  return argvFor(dataDir, host, worker, true);
}

function argvFor(
  dataDir: string,
  host: SshHost,
  worker: SshWorker,
  languageLink: boolean,
): string[] {
  const argv = [
    "ssh",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=30",
  ];
  // Prompting is on, but it goes to the askpass helper rather than to a TTY
  // this connection does not have. `BatchMode=yes` here would make any host
  // needing a password simply unusable.
  argv.push(...askpassOptions());
  argv.push(...knownHostsOptions(dataDir));
  argv.push(...addressing(host));
  argv.push(destination(host));
  argv.push(...remoteCommand(worker, languageLink));
  return argv;
}

/**
 * The remote words: the program, its mode, and the state directory.
 *
 * `ssh` joins these with spaces and the login shell on the far side splits
 * them again, which is why `validateHost` refuses a path holding whitespace or
 * a shell metacharacter. Split out from {@link argvFor} so the remote half is
 * one place when a second launch shape needs it.
 */
function remoteCommand(worker: SshWorker, languageLink: boolean): string[] {
  const words = [worker.path, "worker", "--stdio"];
  if (languageLink) words.push("--language-link");
  if (worker.stateDir !== undefined) {
    words.push("--state-dir", worker.stateDir);
  }
  return words;
}

/** Port, identity file and the host's own extra arguments, in that order. */
function addressing(host: SshHost): string[] {
  const argv: string[] = [];
  if (host.port !== undefined) argv.push("-p", String(host.port));
  if (host.identityFile !== undefined) argv.push("-i", host.identityFile);
  argv.push(...(host.extraArgs ?? []));
  return argv;
}

/**
 * `user@host`, with the brackets of an IPv6 literal removed — `ssh` takes a
 * bare address as its destination, brackets are URI syntax.
 */
export function destination(host: SshHost): string {
  const address = unbracket(host.host);
  return host.user === undefined ? address : `${host.user}@${address}`;
}

/** `[fe80::1]` → `fe80::1`; anything else unchanged. */
export function unbracket(address: string): string {
  return address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
}

/**
 * The argv of a terminal session's command, program included:
 * `ssh -t -o ServerAliveInterval=30 [-p PORT] [-i FILE] [extra…] user@host`.
 *
 * A terminal node has a real TTY, so `ssh` prompts there itself. Only the
 * host-key options are added, so that an unknown key behaves the same way it
 * does everywhere else in Armadra.
 */
export function sshArgv(dataDir: string, host: SshHost): string[] {
  const argv = ["ssh", "-t", "-o", "ServerAliveInterval=30"];
  argv.push(...knownHostsOptions(dataDir));
  argv.push(...addressing(host));
  argv.push(destination(host));
  return argv;
}

/**
 * The reachability probe: no TTY, no password prompt, five seconds, `true` as
 * the remote command.
 *
 * The probe stays batch. It answers "is this host reachable with the
 * credentials already available", and a dialog would turn a reachability check
 * into an authentication attempt nobody asked for.
 */
export function probeArgv(dataDir: string, host: SshHost): string[] {
  const argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  argv.push(...knownHostsOptions(dataDir));
  argv.push(...addressing(host));
  argv.push(destination(host));
  argv.push("true");
  return argv;
}

/**
 * The Node probe: the same batch line, asking the far side for its `node`
 * version instead of `true`.
 *
 * It is a separate builder rather than a parameter on {@link probeArgv}
 * because the two answer different questions and only one of them is allowed
 * to be interpreted as "this host works": a machine can be perfectly reachable
 * and have no Node at all, which is exactly the degradation this build has to
 * report rather than hide (design §9, "远端执行需要目标机有 Node").
 */
export function nodeProbeArgv(dataDir: string, host: SshHost): string[] {
  const argv = probeArgv(dataDir, host);
  // Replace the trailing `true` with the version query. The remote words are
  // one shell command line on the far side, so `command -v` first keeps a
  // login shell that has no `node` from writing its own diagnostic to stderr.
  argv[argv.length - 1] = "command -v node >/dev/null 2>&1 && node --version";
  return argv;
}
