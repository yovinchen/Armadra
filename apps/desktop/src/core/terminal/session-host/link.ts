import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  type ClientMessage,
  FrameDecoder,
  type Frame,
  type Greeting,
  type HelloAuth,
  type HostMessage,
  HOST_BINARY,
  OutputTracker,
  PROTOCOL_MAJOR,
  REQUEST_TIMEOUT_MS,
  START_TIMEOUT_MS,
  acceptWelcome,
  jsonFrame,
  pipeEndpoint,
} from "./protocol";

/**
 * One connected pipe, with a reader draining it.
 *
 * The protocol is in `protocol.ts` and is pure; everything that touches a
 * handle is here, which is exactly the split the Rust side made for the same
 * reason — that code could be cross-compiled and inspected, this code can only
 * be *run*, and no machine in this project's CI is a Windows machine.
 *
 * ## What is verified, and what is not
 *
 * The pipe name is derived and therefore predictable, so being connected
 * proves nothing on its own. The Rust client answered that with
 * `verify_server`: `GetNamedPipeServerProcessId` on the handle, then the
 * server process' SID compared against this user's.
 *
 * **`node:net` cannot do that.** It hands back a `Socket`, not a `HANDLE`,
 * and there is no Node API that reaches the pipe's server identity. Since
 * R6d the check is mutual instead of native: the client proves it can read
 * the `0600` key file under the data directory (`auth.ts`), and the host
 * refuses a connection that cannot. That authenticates the *conversation*
 * rather than the peer process, which against the threat that matters — a
 * different account on a shared machine — is the same thing the DACL bought.
 * The residual risk is enumerated in `auth.ts` rather than left implicit.
 *
 * This direction — client verifying server — is still the weaker one: a
 * process that got there first could serve a pipe of this name without
 * holding the key, and this client would connect to it before the handshake
 * refused *it*. What that attacker gets is the client's own `hello`, which
 * carries a proof bound to this endpoint and expiring in a minute, and
 * nothing else: the core sends no session data until `welcome` is accepted.
 */

export type LinkEvent =
  | { type: "snapshot"; generation: number; payload: Buffer }
  | { type: "snapshotEnd"; generation: number }
  | { type: "output"; generation: number; payload: Buffer }
  | { type: "gap"; generation: number; missing: number }
  | {
      type: "exit";
      sessionKey: string;
      generation: number;
      exitCode: number | null;
    }
  | { type: "stale"; sessionKey: string; generation: number; current: number }
  | { type: "warning"; sessionKey: string; message: string }
  | { type: "bye"; reason: string; drain: boolean }
  | { type: "closed" };

export type EventSink = (event: LinkEvent) => void;

interface Pending {
  readonly resolve: (message: HostMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class Link {
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new FrameDecoder();
  private tracker: OutputTracker | undefined;
  private welcome: ((message: HostMessage) => void) | undefined;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly events: EventSink,
  ) {
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("error", () => this.end());
    socket.on("close", () => this.end());
  }

  static connect(endpoint: string, events: EventSink): Promise<Link> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      const failed = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        resolve(new Link(socket, events));
      });
    });
  }

  get alive(): boolean {
    return !this.closed;
  }

  /**
   * Closes this connection. For an attached connection that is a **detach**:
   * the host keeps the session, and only `destroy` ends one.
   */
  close(): void {
    this.end();
    this.socket.destroy();
  }

  /**
   * `hello`, and the proof that goes with it.
   *
   * `auth` is optional because the Rust host does not ask for one and would
   * ignore it; the TypeScript host refuses a connection without it. The caller
   * passes whatever the host it is talking to needs, and both are the same
   * protocol major — see {@link HelloAuth}.
   */
  async handshake(client: string, auth?: HelloAuth): Promise<Greeting> {
    const greeted = new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the session host did not answer hello"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.welcome = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
    await this.notify({
      type: "hello",
      protocol: PROTOCOL_MAJOR,
      client,
      ...(auth === undefined ? {} : { auth }),
    });
    return acceptWelcome(await greeted, PROTOCOL_MAJOR);
  }

  /** Sends without waiting for an answer. */
  notify(message: ClientMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("the session host connection is closed"));
        return;
      }
      this.socket.write(jsonFrame(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  /** Sends and waits for the reply carrying `id`. */
  async request(id: number, message: ClientMessage): Promise<HostMessage> {
    const answer = new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the session host timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.notify(message);
    } catch (error) {
      const waiter = this.pending.get(id);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return answer;
  }

  /**
   * Starts checking output frames against `generation`. Called **before** the
   * `attach` request goes out, so no frame can arrive unchecked.
   */
  expectOutput(generation: number): void {
    this.tracker = new OutputTracker(generation);
  }

  private read(chunk: Buffer): void {
    this.decoder.push(chunk);
    for (;;) {
      let frame: Frame | undefined;
      try {
        frame = this.decoder.next();
      } catch {
        // The stream is not this protocol any more. There is no framing left
        // to resynchronise to, so the connection goes rather than the bytes
        // being guessed at.
        this.close();
        return;
      }
      if (frame === undefined) return;
      this.route(frame);
    }
  }

  private route(frame: Frame): void {
    if (frame.kind === "snapshot") {
      // A snapshot is the past being redrawn. It carries no sequence and must
      // not be checked against the live stream's numbering.
      this.events({
        type: "snapshot",
        generation: frame.generation,
        payload: frame.payload,
      });
      return;
    }
    if (frame.kind === "snapshotEnd") {
      this.events({ type: "snapshotEnd", generation: frame.generation });
      return;
    }
    if (frame.kind === "output") {
      const tracker = this.tracker;
      if (tracker === undefined) return;
      const delivery = tracker.observe(frame.generation, frame.sequence);
      if (delivery.kind === "write") {
        this.events({
          type: "output",
          generation: frame.generation,
          payload: frame.payload,
        });
        return;
      }
      if (delivery.kind === "gap") {
        this.tracker = undefined;
        this.events({
          type: "gap",
          generation: frame.generation,
          missing: delivery.missing,
        });
      }
      return;
    }
    let message: HostMessage;
    try {
      message = JSON.parse(frame.payload.toString("utf8")) as HostMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "welcome": {
        const waiter = this.welcome;
        this.welcome = undefined;
        waiter?.(message);
        return;
      }
      case "ok":
      case "error": {
        // A refusal of the handshake itself carries `id: 0` — no request had
        // been issued yet, so there is nothing to match it to by id, and the
        // one thing owed an answer is the outstanding `hello`. Without this,
        // "the host said no" arrives as "the host never answered", which is a
        // different problem with a different fix.
        if (
          message.type === "error" &&
          message.id === 0 &&
          this.welcome !== undefined
        ) {
          const greeter = this.welcome;
          this.welcome = undefined;
          greeter(message);
          return;
        }
        const waiter = this.pending.get(message.id);
        if (waiter === undefined) return;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        waiter.resolve(message);
        return;
      }
      case "exit":
        this.events({
          type: "exit",
          sessionKey: message.sessionKey,
          generation: message.generation,
          exitCode: message.exitCode,
        });
        return;
      case "stale":
        this.tracker = undefined;
        this.events({
          type: "stale",
          sessionKey: message.sessionKey,
          generation: message.generation,
          current: message.current,
        });
        return;
      case "warning":
        this.events({
          type: "warning",
          sessionKey: message.sessionKey,
          message: message.message,
        });
        return;
      case "bye":
        this.events({
          type: "bye",
          reason: message.reason,
          drain: message.drain,
        });
    }
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    // Waking every waiter is what keeps a dead host from turning into a set of
    // promises nobody ever settles.
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the session host closed before answering"));
    }
    this.pending.clear();
    this.events({ type: "closed" });
  }
}

/* -------------------------------- discovery -------------------------------- */

/**
 * This user's SID.
 *
 * `whoami /user` is the only way to it without a native module, and its output
 * is stable across every supported Windows version. A failure here is fatal
 * rather than defaulted: the SID is half the pipe name, and guessing it would
 * aim this core at somebody else's host.
 */
export function currentSid(): string {
  const output = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  // `"DOMAIN\user","S-1-5-21-…"`
  const sid = /"(S-1-[0-9-]+)"/.exec(output)?.[1];
  if (sid === undefined) {
    throw new Error(`could not read this user's SID from: ${output.trim()}`);
  }
  return sid;
}

/** The pipe this user's host of this data directory listens on. */
export function endpointFor(dataDir: string): string {
  return pipeEndpoint(currentSid(), dataDir);
}

/**
 * Which host this core starts.
 *
 * `ts` is the default from R6d: the TypeScript daemon under
 * `apps/desktop/src/session-host/`, bundled to `out/session-host/host.cjs`.
 * `rust` is the `armadra-session-host.exe` of `crates/session-host`, kept
 * reachable until R7 deletes the crate so that a Windows machine which hits a
 * problem with the new one has somewhere to stand.
 *
 * Both speak the same wire (`protocol.ts`); the only difference at this level
 * is what gets executed and whether a handshake proof is required.
 */
export type HostFlavour = "ts" | "rust";

export function hostFlavour(
  ambient: NodeJS.ProcessEnv = process.env,
): HostFlavour {
  return ambient.ARMADRA_SESSION_HOST === "rust" ? "rust" : "ts";
}

/** The file name of the TypeScript host's bundle. */
export const HOST_BUNDLE = "host.cjs";

/**
 * The Rust host binary, beside this executable — or wherever
 * `ARMADRA_SESSION_HOST_BIN` points, which is how a development run and the
 * probe reach one that is not next to Electron.
 */
export function resolveHostBinary(
  ambient: NodeJS.ProcessEnv = process.env,
): string {
  const named = ambient.ARMADRA_SESSION_HOST_BIN;
  if (named !== undefined && named !== "") {
    if (existsSync(named)) return named;
    throw new Error(
      `ARMADRA_SESSION_HOST_BIN does not point at a file: ${named}`,
    );
  }
  const sibling = join(dirname(process.execPath), HOST_BINARY);
  if (existsSync(sibling)) return sibling;
  throw new Error(`could not find ${HOST_BINARY} next to ${process.execPath}`);
}

/**
 * The places a built `host.cjs` can be, in the order they are tried.
 *
 * The same three the hook client's bundle uses, for the same reasons: the
 * packaged app's `resources/`, a sibling of the executable, and the built
 * tree (`out/core/main.js` → `out/session-host/host.cjs`) that a development
 * run works out of.
 */
export function hostBundleCandidates(
  ambient: NodeJS.ProcessEnv = process.env,
): string[] {
  const named = ambient.ARMADRA_SESSION_HOST_BUNDLE;
  if (named !== undefined && named !== "") return [named];
  const candidates: string[] = [];
  if (process.resourcesPath !== undefined) {
    candidates.push(join(process.resourcesPath, "session-host", HOST_BUNDLE));
  }
  candidates.push(join(dirname(process.execPath), "session-host", HOST_BUNDLE));
  candidates.push(join(__dirname, "..", "session-host", HOST_BUNDLE));
  return candidates;
}

export function resolveHostBundle(
  ambient: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = hostBundleCandidates(ambient);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) return found;
  throw new Error(
    `could not find ${HOST_BUNDLE}; looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

export interface HostLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * What to execute to bring a host up, for the flavour in effect.
 *
 * The TypeScript host is JavaScript, and a packaged machine is not guaranteed
 * to have a system `node` — so it is run by **this process' own executable**
 * with `ELECTRON_RUN_AS_NODE=1`, exactly as `armadra-hook`'s launcher does.
 * `ARMADRA_SESSION_HOST_RUNNER` overrides the interpreter, which is how a
 * plain-Node server shell and the integration tests reach it.
 *
 * Only the data directory is on the command line. Everything else the host
 * needs — the pipe name, the key, the lock — it derives from that one path,
 * because a command line is world-readable.
 */
export function hostLaunch(
  dataDir: string,
  ambient: NodeJS.ProcessEnv = process.env,
): HostLaunch {
  if (hostFlavour(ambient) === "rust") {
    return {
      command: resolveHostBinary(ambient),
      args: [dataDir],
      env: { ...ambient },
    };
  }
  const runner = ambient.ARMADRA_SESSION_HOST_RUNNER;
  return {
    command: runner !== undefined && runner !== "" ? runner : process.execPath,
    args: [resolveHostBundle(ambient), dataDir],
    env: { ...ambient, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Starts the host detached.
 *
 * Detached matters: a host started as an ordinary child would share this
 * process' console and process group, and the design is explicit that the
 * process owning the consoles must not be tied to one that exits.
 */
export function startHost(launch: HostLaunch): void {
  // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW
  const child = spawn(launch.command, [...launch.args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: launch.env,
  });
  child.unref();
}

/** Connects, retrying with backoff until `within` elapses. */
export async function waitForHost(
  endpoint: string,
  events: EventSink,
  within: number = START_TIMEOUT_MS,
): Promise<Link> {
  const deadline = Date.now() + within;
  let wait = 50;
  for (;;) {
    try {
      return await Link.connect(endpoint, events);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 500);
    }
  }
}
