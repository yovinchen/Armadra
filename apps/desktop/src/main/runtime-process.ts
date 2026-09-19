import { type ChildProcess, execFile, fork, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import path, { join } from "node:path";
import {
  DesktopRuntimeControlSchema,
  DesktopShutdownRequestSchema,
  create,
  toBinary,
} from "@armadra/protocol";
import { dataDir, endpointsFile } from "../shell-core/paths";
import {
  type HealthResponse,
  PROBE_INTERVAL_MS,
  READY_TIMEOUT_MS,
  RELEASE_TIMEOUT_MS,
  type RuntimeAddress,
  type RuntimeRecord,
  foreignRuntimeError,
  isDesktopStartedRuntime,
  isOurRuntime,
  listenArgument,
  parseAnnouncement,
  parseHealth,
  runtimeBinaryName,
  staleRuntimeRecord,
} from "../shell-core/runtime/identity";
import {
  DRIVE_ADDRESS_ENV,
  DRIVE_TOKEN_ENV,
} from "../shell-core/browser/drive";
import { repoRoot } from "./repo-root";

/**
 * The two variables the browser drive channel travels on (§4.2).
 *
 * Set by the assembly before the Runtime is spawned, and empty when the channel
 * could not bind — in which case the Runtime simply never has a shell to drive
 * through and answers `browser_unavailable`, which is the honest answer.
 */
let driveEnvironment: Record<string, string> = {};

/* ------------------------- which core this shell runs --------------------- */

/**
 * `ARMADRA_CORE=rust|ts`, the only switch for the changeover.
 *
 * `rust` — the shell spawns the `armadra-runtime` binary and starts the Go
 * Host, exactly as it always has. `ts` — the shell forks
 * `out/core/main.js` and starts **no Host**: the TypeScript core is the merge
 * of both, so a Host beside it would be a second writer of one database, which
 * is precisely the arrangement the merge exists to remove.
 *
 * Everything downstream of the spawn is deliberately shared: the announcement
 * line is byte-identical, `/health` reports the same `instanceId`, and the
 * stale-process takeover reads the same `endpoints.json`. That is what makes
 * the switch a switch and not a fork of the shell.
 *
 * The default stays `rust` until R6.
 */
export type CoreImplementation = "rust" | "ts";

export function coreImplementation(
  env: NodeJS.ProcessEnv = process.env,
): CoreImplementation {
  return env.ARMADRA_CORE === "ts" ? "ts" : "rust";
}

/** Whether this shell also starts the Go Host. Never while the TS core runs. */
export function startsHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return coreImplementation(env) === "rust";
}

/**
 * The core bundle. `out/core/main.js` sits beside `out/main/index.js` in both
 * layouts — development and inside `app.asar` — so one relative path answers
 * for both. `ARMADRA_CORE_ENTRY` overrides it for a core built elsewhere.
 */
export function coreEntry(
  env: NodeJS.ProcessEnv = process.env,
  mainDir: string = __dirname,
): string {
  return env.ARMADRA_CORE_ENTRY ?? join(mainDir, "../core/main.js");
}

/**
 * The substring that proves a command line belongs to a core this shell
 * started, for the orphan sweep. The Rust half is the binary name plus
 * `--desktop-control-stdin`; the TypeScript half is the bundle path plus the
 * same flag, which the core accepts for exactly this reason.
 */
export function coreProcessMarker(
  implementation: CoreImplementation = coreImplementation(),
): string {
  return implementation === "ts" ? "core/main.js" : runtimeBinaryName();
}

export function setDriveEnvironment(address: string, token: string): void {
  driveEnvironment = { [DRIVE_ADDRESS_ENV]: address, [DRIVE_TOKEN_ENV]: token };
}

/**
 * The Runtime process this shell owns, and how it is asked to stop.
 *
 * A packaged shell starts the Runtime itself; a development Runtime is
 * somebody else's process on a loopback port, and this module never signals
 * one it did not start. Ported from the Rust shell this one replaced.
 *
 * The owned Runtime listens twice: on a Unix socket in the data directory,
 * which is what `/health` and the stale-Runtime takeover use because they need
 * an address known before the spawn, and on a kernel-assigned loopback TCP
 * port, which is what the page uses. Only `endpoints.json` knows the second
 * one, and `transport:endpoints` is how the page is told.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export interface RuntimeStopFailure {
  readonly message: string;
}

export class RuntimeProcess {
  private child: ChildProcess | null = null;
  /** A shutdown that did not confirm; never allowed to read as success later. */
  private shutdownFailed = false;
  /** The instance id our child announced, filled in by the stdout reader. */
  private announced: string | undefined;
  /** Remembered so a replacement can be started on the same address. */
  private address: RuntimeAddress | null = null;
  private exited = false;
  /** Which implementation the running child is; decided at spawn time. */
  private implementation: CoreImplementation = "rust";

  runningImplementation(): CoreImplementation {
    return this.implementation;
  }

  /** True when this shell started the Runtime, and so may stop it. */
  owns(): boolean {
    return this.child !== null;
  }

  announcedInstance(): string | undefined {
    return this.announced;
  }

  exitedEarly(): boolean {
    return this.exited;
  }

  start(address: RuntimeAddress): void {
    this.address = address;
    this.spawn(address);
  }

  /**
   * Starts a replacement after the address was taken back from a stale
   * Runtime. The previous child lost that race and has nothing left to say.
   */
  async restart(): Promise<void> {
    const address = this.address;
    if (address === null)
      throw new Error("This shell does not own a Runtime to restart");
    const previous = this.child;
    if (previous) {
      previous.kill("SIGKILL");
      await waitForExit(previous, 2_000);
    }
    this.child = null;
    this.announced = undefined;
    this.exited = false;
    this.spawn(address);
  }

  private spawn(address: RuntimeAddress): void {
    const implementation = coreImplementation();
    const executable =
      implementation === "ts" ? coreEntry() : runtimeExecutable();
    const args = [
      "--desktop-control-stdin",
      "--listen",
      listenArgument(address),
    ];
    // A loopback port on top of the socket, because the page is now an
    // ordinary HTTP client of the Runtime (§2.1): `fetch` and `WebSocket` go
    // straight there, with no protocol forwarding left to reach a socket
    // through. The kernel picks the number and `endpoints.json` publishes it.
    //
    // The socket stays, and is still what `/health` and the stale-Runtime
    // takeover use: those need an address this shell knows BEFORE the spawn,
    // which a kernel-assigned port is not. `ARMADRA_RUNTIME_LISTEN` overrides
    // it for `armadra.sh run desktop`, which pins a port for its own page.
    args.push(
      "--listen",
      process.env.ARMADRA_RUNTIME_LISTEN || "tcp:127.0.0.1:0",
    );
    // The browser drive channel (§4.2). The address is a kernel-assigned
    // loopback port and the token is one random value per shell run, so both
    // exist only here and in the environment of this one child. Nothing is
    // written to disk, and a Runtime this shell did not start has no channel.
    const env = { ...process.env, ...driveEnvironment };
    const child =
      implementation === "ts"
        ? // `child_process.fork`, not `utilityProcess.fork`: everything below
          // this line — the announcement reader, the exit bookkeeping, the
          // SIGKILL fallback — is written against a `ChildProcess`, and
          // `utilityProcess` has neither `exitCode` nor a signal-taking
          // `kill`. `silent` is what gives us the stdout pipe the announcement
          // arrives on. `ELECTRON_RUN_AS_NODE` makes `process.execPath` — the
          // Electron binary, the only interpreter a packaged install is sure
          // to have — behave as plain Node.
          fork(executable, args, {
            silent: true,
            env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          })
        : spawn(executable, args, {
            // stdout is piped, not discarded: the first line identifies this
            // run and the rest is the Runtime's own log, which the Rust shell
            // used to throw away entirely in a packaged build.
            stdio: ["pipe", "pipe", "ignore"],
            env,
          });
    this.implementation = implementation;
    child.on("error", (error) => {
      this.exited = true;
      process.stderr.write(
        `Could not start Runtime at ${executable}: ${error.message}\n`,
      );
    });
    child.on("exit", () => {
      this.exited = true;
    });
    if (child.stdout) this.watchOutput(child.stdout);
    this.child = child;
    this.exited = false;
  }

  /**
   * Drains the child's stdout, keeping the first announcement.
   *
   * Draining matters on its own: an undrained pipe eventually blocks the
   * Runtime's own logging. Every line is echoed to the shell's stderr, which
   * is where a terminal session or Console.app can see it.
   */
  private watchOutput(stdout: NodeJS.ReadableStream): void {
    const lines = createInterface({ input: stdout });
    lines.on("line", (line) => {
      const id = parseAnnouncement(line);
      if (id !== undefined && this.announced === undefined) this.announced = id;
      process.stderr.write(`runtime: ${line}\n`);
    });
  }

  /**
   * Asks the Runtime to stop every managed session and confirm it did.
   *
   * An ordinary exit — even exit 0 — may intentionally leave tmux alive. Only
   * the explicit control request confirms cleanup, so a child that is already
   * gone is a failure, not a success.
   */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) {
      // A development Runtime is external and not ours to kill. But a failure
      // recorded earlier must not read as success on a second quit.
      if (this.shutdownFailed) {
        throw new Error(
          "A previous Runtime shutdown failed; managed sessions require inspection",
        );
      }
      return;
    }
    // The TypeScript core speaks no stdin control frame: it has no tmux
    // sessions to confirm the shutdown of until R2, and SIGTERM already runs
    // its handler — withdraw the endpoint record, close the listeners, close
    // the database. When R2 lands, this branch grows the same confirmation the
    // Rust one has rather than losing it.
    if (this.implementation === "ts") {
      child.kill("SIGTERM");
      const status = await waitForExit(child, 12_000);
      if (status === undefined) {
        this.shutdownFailed = true;
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
        throw new Error("Core shutdown timed out");
      }
      return;
    }
    const control = toBinary(
      DesktopRuntimeControlSchema,
      create(DesktopRuntimeControlSchema, {
        action: {
          case: "shutdown",
          value: create(DesktopShutdownRequestSchema, {}),
        },
      }),
    );
    let failure: string | undefined;
    try {
      if (this.exited || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          "Runtime already exited; managed-session shutdown was not confirmed",
        );
      }
      const stdin = child.stdin;
      if (!stdin) throw new Error("Runtime control pipe unavailable");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(control.length, 0);
      stdin.write(length);
      stdin.write(Buffer.from(control));
      stdin.end();
      const status = await waitForExit(child, 12_000);
      if (status === undefined) {
        throw new Error(
          "Runtime shutdown timed out; managed sessions may still be running",
        );
      }
      if (status.code !== 0) {
        throw new Error("Runtime failed to stop all managed sessions");
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      this.shutdownFailed = true;
      // SIGKILL terminates only this owned child; it is not proof that
      // persistent sessions stopped, so the failure is retained for the user.
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
      throw new Error(failure);
    }
  }
}

/** A child's exit, or `undefined` when it outlasted the timeout. */
export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      done(undefined);
    }, timeoutMs);
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimeout(timer);
      done({ code, signal });
    }
    child.once("exit", onExit);
  });
}

/**
 * Whether this shell is a packaged application, which is what decides where
 * every managed binary is looked for.
 *
 * The answer is Electron's `app.isPackaged`, handed in by `main/index.ts` —
 * NOT an environment variable. An installed application nobody set a variable
 * for was resolving its Runtime against a development path
 * (`Contents/target/debug/armadra-runtime`) and simply did not start; a
 * double-clicked `.app` inherits nothing from anybody's shell.
 *
 * `ARMADRA_DESKTOP_PACKAGED=1` remains as an override for exercising the
 * packaged layout without packaging.
 */
let packagedShell = false;

export function setPackagedShell(packaged: boolean): void {
  packagedShell = packaged;
}

export function isPackagedShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return packagedShell || env.ARMADRA_DESKTOP_PACKAGED === "1";
}

/**
 * The Runtime binary. A packaged shell takes the one `extraResources` staged
 * beside the bundle's resources; in development it comes out of
 * `CARGO_TARGET_DIR` (or the repo's `target/`), which is where
 * `cargo build -p armadra-runtime` leaves it.
 */
export function runtimeExecutable(
  packaged = isPackagedShell(),
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string = process.resourcesPath,
  repoDir: string = repoRoot(),
  platform: string = process.platform,
  pathModule: typeof path = path,
): string {
  const name = runtimeBinaryName(platform);
  if (env.ARMADRA_RUNTIME_BINARY) return env.ARMADRA_RUNTIME_BINARY;
  if (packaged) return pathModule.join(resourcesPath, name);
  const target = env.CARGO_TARGET_DIR
    ? pathModule.resolve(repoDir, env.CARGO_TARGET_DIR)
    : pathModule.join(repoDir, "target");
  return pathModule.join(target, "debug", name);
}

/* --------------------------- reaching /health ---------------------------- */

/** One `GET /health` over the Runtime's Unix socket. */
export async function socketHealth(
  address: RuntimeAddress,
  timeoutMs = 500,
): Promise<HealthResponse | undefined> {
  if (address.kind !== "socket") {
    return httpHealth(
      `http://${address.kind === "tcp" ? address.authority : ""}`,
      timeoutMs,
    );
  }
  const body = await requestOverSocket(address.path, "/health", timeoutMs);
  return body === undefined ? undefined : parseHealth(body);
}

export async function httpHealth(
  base: string,
  timeoutMs = 500,
): Promise<HealthResponse | undefined> {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${base}/health`, { signal: abort });
    if (!response.ok) return undefined;
    return parseHealth(await response.text());
  } catch {
    return undefined;
  }
}

/** Minimal HTTP/1.1 GET over a Unix socket; returns the body, or nothing. */
function requestOverSocket(
  path: string,
  route: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((done) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    const socket = connect(path);
    socket.setTimeout(timeoutMs, () => finish(undefined));
    socket.on("error", () => finish(undefined));
    socket.on("connect", () => {
      socket.write(
        `GET ${route} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return finish(undefined);
      const statusLine = raw.slice(0, raw.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) return finish(undefined);
      finish(raw.slice(split + 4));
    });
  });
}

/* ------------------------- taking back the address ------------------------ */

export type OwnedProbe =
  /** The Runtime this shell started is up. */
  | { kind: "ours" }
  /** Something else holds the address. */
  | { kind: "foreign"; health: HealthResponse }
  /** Our child is gone and nothing answered. */
  | { kind: "childExited" }
  /** Nothing answered within the timeout. */
  | { kind: "timedOut" };

export async function probeOwnedRuntime(
  runtime: RuntimeProcess,
  address: RuntimeAddress,
  now: () => number = Date.now,
): Promise<OwnedProbe> {
  const deadline = now() + READY_TIMEOUT_MS;
  for (;;) {
    const health = await socketHealth(address);
    const expected = runtime.announcedInstance();
    if (health !== undefined) {
      if (isOurRuntime(expected, health)) return { kind: "ours" };
      // Our child has announced an id and something else answers on the
      // address: that is the stale-Runtime case, and waiting longer only
      // delays the report.
      if (expected !== undefined) return { kind: "foreign", health };
    } else if (runtime.exitedEarly()) {
      // The child is gone. Whatever holds the address now — including
      // nothing — is not ours.
      const late = await socketHealth(address);
      return late === undefined
        ? { kind: "childExited" }
        : { kind: "foreign", health: late };
    }
    if (now() >= deadline) {
      const late = await socketHealth(address);
      return late !== undefined && !isOurRuntime(expected, late)
        ? { kind: "foreign", health: late }
        : { kind: "timedOut" };
    }
    await sleep(PROBE_INTERVAL_MS);
  }
}

/**
 * Waits for the Runtime this shell owns, taking the address back from a stale
 * Runtime exactly once.
 *
 * One takeover, not a loop: if a second foreign Runtime claims the address
 * after we cleared the first, something on this machine is starting them and
 * the shell must say so rather than fight it.
 */
export async function waitForRuntime(
  runtime: RuntimeProcess,
  address: RuntimeAddress,
): Promise<void> {
  const first = await probeOwnedRuntime(runtime, address);
  if (first.kind === "ours") return;
  if (first.kind === "childExited")
    throw new Error("Runtime process exited before becoming ready");
  if (first.kind === "timedOut") {
    throw new Error("Runtime did not become healthy within 10 seconds");
  }
  process.stderr.write(
    `Another Armadra Runtime holds this data directory's address; stopping it and starting ours\n`,
  );
  try {
    await takeOverAddress(address);
  } catch (error) {
    throw new Error(
      foreignRuntimeError(
        first.health,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  await runtime.restart();

  const second = await probeOwnedRuntime(runtime, address);
  if (second.kind === "ours") return;
  if (second.kind === "foreign") {
    throw new Error(
      foreignRuntimeError(second.health, "it came back after being stopped"),
    );
  }
  if (second.kind === "childExited") {
    throw new Error(
      "Runtime process exited before becoming ready after a restart",
    );
  }
  throw new Error(
    "Runtime did not become healthy within 10 seconds after a restart",
  );
}

export async function takeOverAddress(address: RuntimeAddress): Promise<void> {
  const endpoints = endpointsFile();
  let contents: string;
  try {
    contents = await readFile(endpoints, "utf8");
  } catch (error) {
    throw new Error(
      `could not read ${endpoints}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const found = staleRuntimeRecord(contents, address);
  if (!found.ok) throw new Error(found.reason);
  await stopStaleRuntime(found.record);
  await waitUntilAddressIsFree(address);
}

/**
 * Asks a Runtime a previous shell left behind to stop — after proving from the
 * process table that it really is one.
 *
 * SIGTERM, not SIGKILL: the Runtime's own handler drains HTTP, detaches tmux
 * sessions instead of ending them, and withdraws its endpoint record. Sessions
 * the user left running are still there for the Runtime we start next, which
 * adopts them when it reconciles.
 */
export async function stopStaleRuntime(record: RuntimeRecord): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      `stopping another Armadra Runtime (pid ${record.processId}) is only automatic on macOS and Linux`,
    );
  }
  const commandLine = await processCommandLine(record.processId);
  if (commandLine === undefined) {
    throw new Error(
      `process ${record.processId} from endpoints.json is no longer running`,
    );
  }
  // The marker depends on which implementation this shell would start: a TS
  // core's command line names the bundle, not the Rust binary. The
  // `--desktop-control-stdin` half of the check is unchanged and is what keeps
  // a development core somebody is running from a terminal out of reach.
  if (!isDesktopStartedRuntime(commandLine, coreProcessMarker())) {
    throw new Error(
      `process ${record.processId} is not an Armadra Runtime started by a desktop shell (${commandLine})`,
    );
  }
  try {
    process.kill(record.processId, "SIGTERM");
  } catch (error) {
    throw new Error(
      `could not signal process ${record.processId}: ${error instanceof Error ? error.message : error}`,
    );
  }
  process.stderr.write(
    `Asked the previous Runtime (pid ${record.processId}, instance ${record.instanceId}) to stop\n`,
  );
}

/** `ps -ww -o command= -p <pid>`, or nothing when no such process exists. */
export function processCommandLine(pid: number): Promise<string | undefined> {
  // `-ww` keeps the full argument list; the default width would cut the flag
  // the desktop-started check depends on.
  return new Promise((done) => {
    execFile(
      "/bin/ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      (error, stdout) => {
        const line = stdout.trim();
        done(error || line === "" ? undefined : line);
      },
    );
  });
}

/** Waits until nothing accepts on the address any more. */
export async function waitUntilAddressIsFree(
  address: RuntimeAddress,
  now: () => number = Date.now,
): Promise<void> {
  const deadline = now() + RELEASE_TIMEOUT_MS;
  for (;;) {
    if (!(await addressIsHeld(address))) return;
    if (now() >= deadline) {
      throw new Error(
        `it is still listening on ${listenArgument(address)} ${RELEASE_TIMEOUT_MS / 1000} seconds later`,
      );
    }
    await sleep(PROBE_INTERVAL_MS);
  }
}

/**
 * Whether anything still accepts on the address. A Runtime that exits leaves
 * the socket inode behind, so the file existing proves nothing — a refused
 * connection is what tells the shell the address is its to take.
 */
export function addressIsHeld(address: RuntimeAddress): Promise<boolean> {
  if (address.kind !== "socket") return Promise.resolve(false);
  if (!existsSync(address.path)) return Promise.resolve(false);
  return new Promise((done) => {
    const socket = connect(address.path);
    const finish = (held: boolean): void => {
      socket.destroy();
      done(held);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

/** Where the shell asks its own Runtime to listen. */
export function ownedRuntimeAddress(): RuntimeAddress {
  return { kind: "socket", path: join(dataDir(), "runtime.sock") };
}

/**
 * Where a *development* Runtime is: an external process the shell did not
 * start, still on its loopback port.
 */
export function externalRuntimeBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const port = Number.parseInt(env.ARMADRA_RUNTIME_PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 43120}`;
}
