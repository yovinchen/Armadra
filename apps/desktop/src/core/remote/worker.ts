/**
 * One live `ssh … worker --stdio` child, and the registry of them.
 *
 * Ported from `apps/runtime/src/remote/client/{mod,connection}.rs`, with the
 * payload encoding changed to JSON for the reasons {@link ./frames} sets out.
 *
 * The read half runs in its own callback rather than being "write one frame,
 * read one frame":
 *
 *  * a response with a `requestId` is matched to the caller waiting for it;
 *  * a response **without** one is an unsolicited frame and is published to
 *    whoever subscribed;
 *  * end of input drops every waiting caller at once, so a killed session is
 *    observed when it happens rather than one request later.
 *
 * What deliberately does *not* change is the request discipline. Requests stay
 * strictly serial per host, so one host's mutations still have a real queue,
 * and a request that was written and then lost its answer is reported as
 * unknown rather than re-sent.
 */

import { randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import type { SshHost, SshWorker } from "../settings/ssh-hosts";
import { workerArgv } from "../terminal/ssh/argv";
import type { AskpassService } from "../terminal/ssh/askpass";
import {
  FrameDecoder,
  MAX_FRAME,
  type TransportFailure,
  type WorkerResponse,
  encodeFrame,
} from "./frames";
import {
  type Accepted,
  HandshakeRefused,
  parseHello,
  accept,
} from "./handshake";
import { probeNode, unsupportedMessage } from "./node-probe";
import { Supervisor } from "./supervisor";

/** How long a single proxied request may take end to end. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** How long the handshake frame may take before the child is abandoned. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** The request id a Worker's unprompted greeting carries. */
export const HELLO_ID = "hello";

/** Raised for everything a caller has to distinguish. */
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

export const unsupported = (message: string): RemoteError =>
  new RemoteError(501, "unsupported", message);

/**
 * A request that was written and then lost its answer.
 *
 * Its own code because the repair differs: the mutation may have happened on
 * the far side, so the answer is "go look", never "try again".
 */
export const unknownOutcome = (message: string): RemoteError =>
  new RemoteError(500, "unknown_outcome", message);

type Waiting = Map<string, (response: WorkerResponse) => void>;

/** One `ssh` child, from spawn to close. */
export class Connection {
  private readonly waiting: Waiting = new Map();
  private readonly decoder = new FrameDecoder();
  private closed = false;
  instanceId = "";
  capabilities: ReadonlySet<string> = new Set();

  constructor(
    private readonly child: ChildProcess,
    private readonly onEvent: (event: unknown) => void,
  ) {
    child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
    // End of input. Every caller still waiting learns now rather than at its
    // own deadline, which is what turns a killed session into an immediate
    // reconnect instead of a sixty-second stall.
    child.stdout?.on("end", () => this.drop());
    child.on("close", () => this.drop());
    child.on("error", () => this.drop());
  }

  private read(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      const response = frame as WorkerResponse;
      if (typeof response?.requestId !== "string") continue;
      // An empty request id is the whole signal that a frame was not asked
      // for. Nothing else may arrive without one.
      if (response.requestId === "") {
        this.onEvent(response.result);
        continue;
      }
      const resolve = this.waiting.get(response.requestId);
      this.waiting.delete(response.requestId);
      resolve?.(response);
    }
    if (this.decoder.broken) this.close();
  }

  private drop(): void {
    this.closed = true;
    for (const resolve of [...this.waiting.values()]) {
      resolve({ requestId: "", instanceId: "" });
    }
    this.waiting.clear();
  }

  hasCapability(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  /** Send one action and wait for its answer. */
  async call(
    hostId: string,
    action: string,
    payload: unknown,
  ): Promise<WorkerResponse | TransportFailure> {
    if (this.closed) return "write";
    const requestId = randomUUID().replace(/-/gu, "");
    const frame = encodeFrame({
      requestId,
      hostId,
      expectedInstanceId: this.instanceId,
      deadlineUnixMs: Date.now() + REQUEST_TIMEOUT_MS,
      action,
      payload,
    });
    // Detected before anything is written, so nothing ran.
    if (frame.byteLength - 4 > MAX_FRAME) return "tooLarge";

    let settle: ((response: WorkerResponse) => void) | undefined;
    const answered = new Promise<WorkerResponse>((resolve) => {
      settle = resolve;
      this.waiting.set(requestId, resolve);
    });
    const stdin = this.child.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed) {
      this.waiting.delete(requestId);
      return "write";
    }
    const written = await new Promise<boolean>((resolve) => {
      stdin.write(frame, (error) =>
        resolve(error === null || error === undefined),
      );
    });
    if (!written) {
      this.waiting.delete(requestId);
      return "write";
    }

    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"lost">((resolve) => {
      timer = setTimeout(() => resolve("lost"), REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([answered, expired]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "lost") {
      this.waiting.delete(requestId);
      return "lost";
    }
    void settle;
    // The handshake is what learns the instance; from then on every answer has
    // to come from that same Worker session, so a reconnected child cannot be
    // mistaken for the one the request was aimed at.
    if (outcome.requestId === "") return "lost";
    if (this.instanceId !== "" && outcome.instanceId !== this.instanceId) {
      return "lost";
    }
    return outcome;
  }

  /**
   * Reads the greeting a Worker sends unprompted when its stdio comes up.
   *
   * It carries the reserved request id {@link HELLO_ID} rather than an empty
   * one, so it is matched through the same table as every other answer and a
   * watch event that arrives first cannot be mistaken for it.
   */
  async hello(): Promise<unknown> {
    return await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(HELLO_ID);
        resolve(undefined);
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      this.waiting.set(HELLO_ID, (response) => {
        clearTimeout(timer);
        resolve(response.result);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.drop();
    // Closing stdin is the Worker's own shutdown signal; the kill is the
    // backstop for an `ssh` that ignored it.
    this.child.stdin?.end();
    this.child.kill();
  }
}

export interface RemoteWorkerOptions {
  readonly dataDir: string;
  readonly host: SshHost;
  readonly worker: SshWorker;
  readonly askpass: AskpassService;
  readonly version: string;
  readonly onEvent?: (event: unknown) => void;
  /**
   * Substitutes argv[0] of every launch. The Rust side reads
   * `ARMADRA_REMOTE_WORKER_LAUNCHER` for the same reason: a person who reaches
   * their host through a wrapper would otherwise be told it is unreachable by
   * the very button meant to tell them whether it is.
   */
  readonly launcher?: string | undefined;
}

/** What a successful probe reports back to the settings page. */
export interface WorkerProbe extends Accepted {
  readonly platform: string;
  readonly architecture: string;
  readonly runtimeVersion: string;
}

/** One execution host's connection, with its reconnect policy. */
export class RemoteWorker {
  private readonly supervisor = new Supervisor<Connection>();

  constructor(private readonly options: RemoteWorkerOptions) {}

  /**
   * Start a Worker and read its hello.
   *
   * The Node probe runs **first**, and a host without one is `unsupported`
   * before any `ssh` child is started: launching `node main.js` on a machine
   * with no `node` produces a shell's own diagnostic on stderr and an exit
   * code that says nothing, and reporting that as a handshake failure would
   * point the person at the wrong thing to fix.
   */
  async probe(): Promise<WorkerProbe> {
    if (this.supervisor.parked()) {
      throw new RemoteError(
        503,
        "unavailable",
        `执行主机 ${this.options.host.name} 连续连接失败，正在冷却`,
      );
    }
    const node = await probeNode(this.options.dataDir, this.options.host);
    if (!node.usable) {
      throw unsupported(unsupportedMessage(this.options.host, node));
    }
    const connection = await this.open();
    try {
      const hello = parseHello(await connection.hello());
      if (hello === undefined) {
        throw new HandshakeRefused(
          `执行主机 ${this.options.host.name} 上的 Worker 没有回握手帧`,
        );
      }
      const accepted = accept(
        this.options.host.name,
        this.options.version,
        hello,
      );
      connection.instanceId = accepted.instanceId;
      connection.capabilities = accepted.capabilities;
      this.supervisor.succeeded(connection, accepted.versionBadge);
      return {
        ...accepted,
        platform: hello.platform,
        architecture: hello.architecture,
        runtimeVersion: hello.runtimeVersion,
      };
    } catch (failure) {
      connection.close();
      this.supervisor.failed();
      throw failure;
    }
  }

  private async open(): Promise<Connection> {
    const argv = workerArgv(
      this.options.dataDir,
      this.options.host,
      this.options.worker,
    );
    // argv[0] is always `ssh`; the launcher substitutes the program only, so
    // the options a real launch uses are the ones exercised.
    const program = this.options.launcher ?? (argv[0] as string);
    argv.shift();
    const askpass =
      this.options.askpass.childEnvironment(this.options.host.id) ?? [];
    const child = spawn(program, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...Object.fromEntries(askpass) },
    });
    return new Connection(child, this.options.onEvent ?? (() => {}));
  }

  /** A user asked directly: forget the park and drop any live child. */
  resume(): void {
    this.supervisor.resume();
  }

  close(): void {
    this.supervisor.resume();
  }
}

/**
 * The live workers, one per execution host id.
 *
 * A host whose settings entry changed is dropped rather than reused: the
 * connection it holds was opened against the old address.
 */
export class RemoteWorkers {
  private readonly workers = new Map<string, RemoteWorker>();

  constructor(
    private readonly make: (host: SshHost, worker: SshWorker) => RemoteWorker,
  ) {}

  /**
   * The worker for `hostId`, or the refusal that explains why there is none.
   *
   * A workspace pinned to a host that is no longer configured, or to one with
   * no Worker, fails with `unsupported`. It never quietly becomes local: the
   * files it names are somewhere else.
   */
  get(host: SshHost | undefined, hostId: string): RemoteWorker {
    if (host === undefined) {
      throw unsupported(
        `这个工作空间绑在执行主机 '${hostId}' 上，而它已经不在配置里了`,
      );
    }
    if (host.worker === undefined) {
      throw unsupported(
        `执行主机 ${host.name} 没有配置 Worker，只能开终端，不能在上面执行工作空间`,
      );
    }
    const existing = this.workers.get(hostId);
    if (existing !== undefined) return existing;
    const created = this.make(host, host.worker);
    this.workers.set(hostId, created);
    return created;
  }

  /** Drop the connection a host is holding — its settings entry changed. */
  forget(hostId: string): void {
    this.workers.get(hostId)?.close();
    this.workers.delete(hostId);
  }

  closeAll(): void {
    for (const worker of this.workers.values()) worker.close();
    this.workers.clear();
  }
}
