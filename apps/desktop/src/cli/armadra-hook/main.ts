/**
 * `armadra-hook` — the hook / context / canvas client Armadra injects into
 * agent terminals, in TypeScript.
 *
 * This is a port of the pre-merge implementation, not a reinterpretation of it: the
 * subcommands, the request bytes, the prose, the exit codes and the
 * fail-open rules are the Rust client's, and `wire.test.ts` byte-compares the
 * two where a CLI or the runtime can tell them apart.
 *
 * Design rules the rest of this directory follows, unchanged:
 *
 *   * **Fail open.** In hook mode any error at all (missing endpoint file,
 *     refused connection, non-204 answer) exits 0 without printing anything.
 *     A broken canvas must never break the user's agent CLI.
 *   * **Quiet stdout.** Claude injects hook stdout into the model context on
 *     several events, so hook mode only ever prints the permission decision.
 *   * **Re-read everything.** The endpoint file and the node token are read on
 *     every invocation because a terminal can outlive the runtime that spawned
 *     it.
 *
 * The process never calls `process.exit`: it sets `process.exitCode` and
 * returns, so a decision already handed to `stdout` is flushed before the
 * process goes away.
 */

import { runBrowser, runCanvas, runContext } from "./control.js";
import { run as runDoctor } from "./doctor.js";
import { run as runHook } from "./hook.js";
import { CLIENT_VERSION, USAGE } from "./usage.js";

export async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  switch (first) {
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "--version":
    case "-V":
      process.stdout.write(`armadra-hook ${CLIENT_VERSION}\n`);
      return 0;
    case "context":
      return runContext(argv.slice(1));
    case "context-usage":
      // Retired with the context readout, kept as a silent success: a
      // `settings.json` written by an older build still names it in its
      // `statusLine`, and until a repair pass takes that line out Claude runs
      // this on every status refresh. Anything printed — an error above all —
      // would land on the user's screen several times a second.
      return 0;
    case "canvas":
      return runCanvas(argv.slice(1));
    case "browser":
      return runBrowser(argv.slice(1));
    case "doctor":
      return runDoctor();
    default:
      break;
  }
  if (first.startsWith("-")) {
    process.stderr.write(USAGE);
    return 1;
  }
  // Anything else is an agent id: this is hook mode, which always succeeds so
  // a canvas problem never breaks the user's CLI.
  return runHook(first);
}

/** True when this module is the process entry point rather than an import. */
function isEntryPoint(): boolean {
  return typeof require !== "undefined" && require.main === module;
}

if (isEntryPoint()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // An unexpected throw must still not break the CLI that called us.
      process.exitCode = 1;
    },
  );
}
