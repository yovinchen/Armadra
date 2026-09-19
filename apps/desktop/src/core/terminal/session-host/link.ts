import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  type ClientMessage,
  FrameDecoder,
  type Frame,
  type Greeting,
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
 * proves nothing on its own. The Rust client answers that with
 * `verify_server`: `GetNamedPipeServerProcessId` on the handle, then the
 * server process' SID compared against this user's.
 *
 * **`node:net` cannot do that.** It hands back a `Socket`, not a
 * `HANDLE`, and there is no Node API that reaches the pipe's server identity.
 * So this build checks what it can — the pipe name carries this user's SID and
 * a digest of the data directory, and the host's own DACL admits only this
 * user and LocalSystem — and records the gap rather than pretending it is
 * closed: **TODO(R6)** — the TypeScript session host of R6 owns both ends of
 * this pipe, and the identity check moves into the native layer it will have.
 * Until then Windows is expected to run `ARMADRA_CORE=rust`.
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

  async handshake(client: string): Promise<Greeting> {
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
    await this.notify({ type: "hello", protocol: PROTOCOL_MAJOR, client });
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
 * The host binary, beside this executable — or wherever
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
 * Starts the host detached.
 *
 * Detached matters: a host started as an ordinary child would share this
 * process' console and process group, and the design is explicit that the
 * process owning the consoles must not be tied to one that exits.
 */
export function startHost(executable: string, dataDir: string): void {
  // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW
  const child = spawn(executable, [dataDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
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
