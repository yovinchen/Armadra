import { type ChildProcess, execFile, fork } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
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
  staleRuntimeRecord,
} from "../shell-core/runtime/identity";
import {
  DRIVE_ADDRESS_ENV,
  DRIVE_TOKEN_ENV,
} from "../shell-core/browser/drive";

/**
 * The two variables the browser drive channel travels on (§4.2).
 *
 * Set by the assembly before the core is spawned, and empty when the channel
 * could not bind — in which case the core simply never has a shell to drive
 * through and answers `browser_unavailable`, which is the honest answer.
 */
let driveEnvironment: Record<string, string> = {};

/* ------------------------------ 壳启动的 core ----------------------------- */

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
 * 命令行里证明「这是壳起的 core」的那一小段，给孤儿进程清扫用。
 *
 * 另一半是 `--desktop-control-stdin`，它是把一个人从终端里手跑的 core 挡在接管
 * 逻辑之外的那一条。
 */
export const CORE_PROCESS_MARKER = "core/main.js";

export function setDriveEnvironment(address: string, token: string): void {
  driveEnvironment = { [DRIVE_ADDRESS_ENV]: address, [DRIVE_TOKEN_ENV]: token };
}

/**
 * 这个壳自己起的那个 core 进程，以及怎么请它停下。
 *
 * 打好包的壳自己起 core；开发时的 core 是别人的进程，这个模块从不给一个不是自己
 * 起的进程发信号。
 *
 * 自己起的 core 监听两处：数据目录里的一个 Unix socket——`/health` 与「接管上一个
 * 还活着的 core」用它，因为那两件事要在 spawn **之前**就知道地址；以及一个由内核
 * 分配的回环 TCP 端口——页面用它。第二个只有 `endpoints.json` 知道，
 * `transport:endpoints` 是告诉页面的那条路。
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
    const executable = coreEntry();
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
    // `child_process.fork`, not `utilityProcess.fork`: everything below this
    // line — the announcement reader, the exit bookkeeping, the SIGKILL
    // fallback — is written against a `ChildProcess`, and `utilityProcess` has
    // neither `exitCode` nor a signal-taking `kill`. `silent` is what gives us
    // the stdout pipe the announcement arrives on. `ELECTRON_RUN_AS_NODE`
    // makes `process.execPath` — the Electron binary, the only interpreter a
    // packaged install is sure to have — behave as plain Node.
    const child = fork(executable, args, {
      silent: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.on("error", (error) => {
      this.exited = true;
      process.stderr.write(
        `Could not start the core at ${executable}: ${error.message}\n`,
      );
    });
    child.on("exit", () => {
      this.exited = true;
    });
    if (child.stdout) this.watchOutput(child.stdout);
    // stderr is where the core's own log goes. Left unread it would fill the
    // pipe and then the core's logging would stall; left unforwarded it would
    // leave "what did the core say before it died?" with no answer.
    if (child.stderr) this.watchOutput(child.stderr);
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
      process.stderr.write(`core: ${line}\n`);
    });
  }

  /**
   * 请 core 停下来，并确认它真的停了。
   *
   * SIGTERM 走的是 core 自己的处理：撤回端点记录、关掉监听、关库。超时之后的
   * SIGKILL 只结束这一个子进程，它**不是**「被管理的会话都收好了」的证据，所以
   * 那次失败要留下来给用户看见，而不能在第二次退出时读成成功。
   */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) {
      // 开发时的 core 是别人的进程，不归这里杀。
      if (this.shutdownFailed) {
        // 上一次超时已经作为一次失败的退出报给用户看过了（对话框）。这一次是
        // 用户看过之后再次要求退出：core 早已被 SIGKILL，没有什么可再停的，再
        // 拒绝就是把人锁在一个只能强杀的应用里。放行，但只放行这一次之后的。
        this.shutdownFailed = false;
        process.stderr.write(
          "A previous core shutdown failed; quitting anyway after the user was told\n",
        );
      }
      return;
    }
    child.kill("SIGTERM");
    const status = await waitForExit(child, 12_000);
    if (status === undefined) {
      this.shutdownFailed = true;
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
      throw new Error("Core shutdown timed out");
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
 * 这个壳是不是一份打好包的应用。它决定被管理的文件去哪里找。
 *
 * 答案来自 Electron 的 `app.isPackaged`，由 `main/index.ts` 交进来——**不是**
 * 环境变量：一个双击打开的 `.app` 什么都继承不到。
 *
 * `ARMADRA_DESKTOP_PACKAGED=1` 留着，用来在不打包的情况下走打包后的布局。
 */
let packagedShell = false;

export function setPackagedShell(packaged: boolean): void {
  packagedShell = packaged;
}

export function isPackagedShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return packagedShell || env.ARMADRA_DESKTOP_PACKAGED === "1";
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
  // `--desktop-control-stdin` 那一半是把一个人从终端里手跑的 core 挡在外面的那
  // 一条：只有壳起的 core 才带着它。
  if (!isDesktopStartedRuntime(commandLine, CORE_PROCESS_MARKER)) {
    throw new Error(
      `process ${record.processId} is not an Armadra core started by a desktop shell (${commandLine})`,
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
