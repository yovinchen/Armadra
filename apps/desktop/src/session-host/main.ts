import { ensureKey } from "../core/terminal/session-host/auth";
import { endpointFor } from "../core/terminal/session-host/link";
import { claimLock, releaseLock } from "./lock";
import { AlreadyServing, SessionHost } from "./server";

/**
 * `armadra-session-host` — the process that owns Windows terminal sessions.
 *
 * Started on demand by the core and left running afterwards. **It takes
 * exactly one argument**, the data directory, and everything else is derived
 * from it: the pipe name, the key file, the lock. That is not tidiness, it is
 * the rule — `ps` is world-readable on every platform, so a command line is
 * the one place a secret or a session key must never appear. A second
 * argument is refused rather than ignored, so a caller that thought it was
 * passing an option finds out immediately.
 *
 * On any other platform this refuses to run: Unix has tmux, whose server
 * already does this job better, and a stub that pretended to work would be
 * worse than one that says what it is.
 */

/** What the host calls itself in `welcome`. */
export const HOST_VERSION = "1.0.0";

export const USAGE = "usage: armadra-session-host <user-data-dir>";

export type Arguments =
  | { readonly ok: true; readonly dataDir: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Exactly one argument, and it must look like a path.
 *
 * An empty string is refused because it would resolve to the process' own
 * working directory, which is wherever the core happened to be — a host
 * silently serving a different data directory than the one asked for is the
 * failure this whole derivation exists to prevent.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  if (argv.length === 0) return { ok: false, reason: USAGE };
  if (argv.length > 1) {
    return {
      ok: false,
      reason: `${USAGE}（收到 ${argv.length} 个参数；这个守护进程不接受任何选项）`,
    };
  }
  const dataDir = argv[0] as string;
  if (dataDir.trim() === "") {
    return { ok: false, reason: `${USAGE}（数据目录不能为空）` };
  }
  if (dataDir.startsWith("-")) {
    return {
      ok: false,
      reason: `${USAGE}（${dataDir} 看起来是一个选项；这个守护进程不接受选项）`,
    };
  }
  return { ok: true, dataDir };
}

export interface RunOptions {
  readonly argv?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly log?: (line: string) => void;
  readonly idleExitMs?: number;
}

/**
 * Starts the host and resolves with the process' exit code.
 *
 * Losing the race for the pipe is **success**, not failure: two cores
 * starting at once is the normal way this process gets launched twice, and
 * the host that won serves both.
 */
export async function run(options: RunOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const platform = options.platform ?? process.platform;
  const log =
    options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (platform !== "win32") {
    log(
      "armadra-session-host 只在 Windows 上运行；其他平台的终端会话由 tmux 或直接后端保管。",
    );
    return 2;
  }
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    log(parsed.reason);
    return 2;
  }
  const dataDir = parsed.dataDir;

  let host: SessionHost;
  try {
    // Before anything listens: a key file this user alone can read is what
    // replaced the pipe's DACL, and a host that could not tighten it must not
    // serve. `ensureKey` throws rather than continuing.
    const key = ensureKey(dataDir);
    const endpoint = endpointFor(dataDir);
    const claim = await claimLock(dataDir, endpoint);
    if (claim.kind === "taken") {
      log(
        `another session host (pid ${claim.held.pid}) already owns ${claim.held.endpoint}; leaving`,
      );
      return 0;
    }
    if (claim.tookOverStaleLock) {
      log("took over a lock left behind by a host that is no longer serving");
    }
    host = new SessionHost({
      dataDir,
      endpoint,
      key,
      version: HOST_VERSION,
      log,
      ...(options.idleExitMs === undefined
        ? {}
        : { idleExitMs: options.idleExitMs }),
    });
    await host.listen();
  } catch (error) {
    if (error instanceof AlreadyServing) {
      log(`${error.message}; leaving`);
      return 0;
    }
    log(
      `session host stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  await served(host, dataDir, log);
  return 0;
}

/**
 * Keeps the process alive until the host decides to leave, and makes every
 * orderly exit release the consoles.
 *
 * This sweep is the stand-in for the Job Object's `KILL_ON_JOB_CLOSE` (see
 * `pty.ts`): the signals are handled rather than defaulted so that a `taskkill`
 * or a Ctrl+Break arrives here first and the consoles are closed with proof.
 * A `SIGKILL` still bypasses all of it, and nothing in Node can change that.
 */
async function served(
  host: SessionHost,
  dataDir: string,
  log: (line: string) => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false;
    const leave = (why: string): void => {
      if (finished) return;
      finished = true;
      log(`session host leaving: ${why}`);
      void host
        .close()
        .catch((error: unknown) => {
          log(
            `关闭会话时出错：${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          releaseLock(dataDir);
          resolve();
        });
    };
    host.onLeaving(() => leave("idle"));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      // A signal this platform does not have throws on `process.on`; that is a
      // reason to skip it, not to fail to start.
      try {
        process.on(signal, () => leave(signal));
      } catch {
        // Not available here.
      }
    }
  });
}

/**
 * The entry point of the bundle. Guarded so the module can be imported by the
 * tests without starting a server.
 */
export async function bootstrap(): Promise<void> {
  process.exitCode = await run();
}

if (require.main === module) void bootstrap();
