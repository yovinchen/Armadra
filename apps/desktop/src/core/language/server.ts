/**
 * One language server process (design §2.2 `server`, §3.2).
 *
 * ## What starting one means
 *
 * It means running the project's code. A language server loads the project's
 * plugins, its the pre-merge implementation, its `tsconfig` resolution and, for `rust-analyzer`,
 * a `cargo check`. That is why the gate is the workspace's **execute** grant
 * and not its read grant, and why nothing here is started implicitly by a
 * probe.
 *
 * ## How it is started
 *
 * * No shell, and no argv assembled from user text: the executable is the
 *   absolute path the probe froze, and the arguments are an array.
 * * The environment is the login environment the server needs (`PATH`,
 *   `GOPATH`, `CARGO_HOME`) **minus** every `ARMADRA_*` variable and the hook
 *   endpoint. A language server that reads its environment must not find the
 *   core's credentials there.
 * * Its own session (`detached`, which is `setsid` on unix) so the whole tree
 *   can be ended with one `kill(-pgid)`; on Windows the tree is ended with
 *   `taskkill /T`, because Node offers no Job Object of its own.
 *
 * ## What is not read
 *
 * stderr is kept as a 64 KiB tail in memory, redacted, and shown only when a
 * server crashes. It is never written to a log, a board log or the database.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { basename } from "node:path";

import { redactSecrets } from "../terminal/ssh/redact";
import { Decoder, encode, type JsonObject, type JsonValue } from "./jsonrpc";
import { STDERR_TAIL_BYTES } from "./limits";

/** Everything needed to start one server. */
export interface Launch {
  readonly serverId: string;
  /** The absolute path the probe resolved. Never a bare name. */
  readonly executable: string;
  readonly args: readonly string[];
  /** Working directory and the single workspace folder. */
  readonly root: string;
  readonly initializationOptions?: JsonValue | undefined;
}

/** What the reader hands the multiplexer. */
export type ServerEvent =
  /**
   * One complete JSON-RPC message, exactly as the server wrote it. `oversize`
   * means it is past the message ceiling and must be replaced by an error —
   * after its id has been read, so the session that asked stops waiting.
   */
  | {
      readonly kind: "message";
      readonly body: Buffer;
      readonly oversize: boolean;
    }
  /** The process is gone. */
  | { readonly kind: "exited"; readonly code: number | null };

export type StartError = "containmentUnavailable" | "spawnFailed";

/**
 * This platform can contain what it would start.
 *
 * On unix `detached: true` gives the child its own process group, and
 * `kill(-pgid)` ends the whole tree — the same containment `setsid` plus
 * `killpg` gives the Rust Runtime. On Windows there is no Job Object available
 * from Node, so the tree is ended with `taskkill /T /F` instead; that is a
 * weaker guarantee (a process that has already re-parented survives), which is
 * why it is named here rather than assumed.
 */
export function containmentReady(): boolean {
  return true;
}

export function isRuntimeVariable(name: string): boolean {
  return (
    name.startsWith("ARMADRA_") ||
    name.startsWith("CLAUDE_HOOK_") ||
    name === "ARMADRA_HOOK_TOKEN" ||
    name === "ARMADRA_HOOK_PORT"
  );
}

/**
 * The environment a language server is given.
 *
 * It inherits the login environment, because that is where `PATH`, `GOPATH`
 * and `CARGO_HOME` live and a server without them cannot find its own
 * toolchain. What it does not inherit is anything that identifies or
 * authorises Armadra: every `ARMADRA_*` variable, and the hook endpoint the
 * agents use. A language server is the project's code; it gets no credential.
 */
export function serverEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (isRuntimeVariable(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/**
 * A fixed-size tail of stderr. Only the end matters: a server that failed to
 * start says why in its last few lines, and keeping the whole stream would be
 * an unbounded buffer holding text nobody asked for.
 */
class Tail {
  private bytes = Buffer.alloc(0);

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.bytes, chunk]);
    this.bytes =
      joined.byteLength > STDERR_TAIL_BYTES
        ? Buffer.from(joined.subarray(joined.byteLength - STDERR_TAIL_BYTES))
        : joined;
  }

  text(): string {
    return redactSecrets(this.bytes.toString("utf8"));
  }
}

/** A running (or once-running) server process. */
export class ServerProcess {
  readonly pid: number | null;
  readonly startTimeUnixMs: number | null;
  private readonly child: ChildProcess;
  private readonly stderr = new Tail();
  private closed = false;
  /** Resolves when the OS has actually reaped the child. */
  private readonly reaped: Promise<void>;
  private reap: () => void = () => {};

  private constructor(
    child: ChildProcess,
    onEvent: (event: ServerEvent) => void,
  ) {
    this.child = child;
    this.pid = child.pid ?? null;
    this.startTimeUnixMs = Date.now();
    this.reaped = new Promise((resolve) => {
      this.reap = resolve;
    });

    const decoder = new Decoder();
    child.stdout?.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (;;) {
        const next = decoder.next();
        if (next.kind === "pending") break;
        if (next.kind === "frame") {
          onEvent({
            kind: "message",
            body: next.frame.body,
            oversize: next.frame.oversize,
          });
          continue;
        }
        // Past the hard limit: skipped, and the stream carries on with the
        // next frame. A stream we can no longer find message boundaries in is
        // not recoverable by guessing, so the reader stops.
        if (next.error === "tooLarge") continue;
        return;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    // A pipe that breaks because the peer exited is not an error worth
    // raising: the exit event is the one that matters.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", () => {
      this.reap();
      if (this.closed) return;
      this.closed = true;
      onEvent({ kind: "exited", code: null });
    });
    child.on("exit", (code) => {
      this.reap();
      if (this.closed) return;
      this.closed = true;
      onEvent({ kind: "exited", code: code ?? null });
    });
  }

  /**
   * Starts the process and the reader behind it.
   *
   * Returns the start error rather than throwing: "this platform cannot
   * contain it" and "the program would not start" are two different answers
   * the hub reports differently, and neither is exceptional.
   */
  static start(
    launch: Launch,
    onEvent: (event: ServerEvent) => void,
  ): ServerProcess | StartError {
    if (!containmentReady()) return "containmentUnavailable";
    let child: ChildProcess;
    try {
      child = spawn(launch.executable, [...launch.args], {
        cwd: launch.root,
        env: serverEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group on unix, so the whole tree can be ended at
        // once: servers fork helpers (`rust-analyzer` runs `cargo`), and
        // killing only the leader would orphan them.
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch {
      return "spawnFailed";
    }
    if (child.pid === undefined) {
      // A spawn that failed asynchronously (ENOENT is the usual one) emits
      // `error` on a child nothing is listening to, and an unhandled `error`
      // event is a process-level throw. The handler goes on before the early
      // return, not only inside the constructor.
      child.on("error", () => {});
      return "spawnFailed";
    }
    return new ServerProcess(child, onEvent);
  }

  /**
   * Queues one JSON-RPC message. A closed pipe means the process is gone; the
   * caller learns that from the exit event and does not need a second error
   * path here.
   */
  send(body: Buffer | string): boolean {
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed) return false;
    try {
      stdin.write(encode(body));
      return true;
    } catch {
      return false;
    }
  }

  stderrTail(): string {
    return this.stderr.text();
  }

  /**
   * Ends the process group. Called after `shutdown`/`exit` were given their
   * five seconds, and directly when a workspace or the core goes away.
   */
  async terminate(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      // No Job Object from Node; `taskkill /T` walks the tree instead.
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      // The whole group, not just the leader.
      killGroup(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      killGroup(pid, "SIGKILL");
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    // Signalling a process is not the same as it being gone, and `taskkill`
    // returns before the target does. A caller that awaits this has to be able
    // to act on the server's absence — remove its workspace directory, most
    // of all, which Windows refuses while the process still has it as its
    // working directory. Bounded, because an unkillable process must not hang
    // a shutdown that has already done everything it can.
    await Promise.race([
      this.reaped,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, REAP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  }
}

/** How long `terminate` waits for the exit it just asked for. */
const REAP_TIMEOUT_MS = 5_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone, or the child may not have become a group
    // leader; the direct kill below covers the second case.
    try {
      process.kill(pid, signal);
    } catch {
      // Gone.
    }
  }
}

/**
 * The `initialize` params for one workspace root.
 *
 * One folder, always: multi-root workspaces are explicitly out of scope
 * (design §6.2), and handing a server a second root would let it read and
 * index a directory the workspace does not cover.
 */
export function initializeParams(
  root: string,
  clientCapabilities: JsonValue,
  initializationOptions: JsonValue | undefined,
  version: string,
): JsonObject {
  const path = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const uri = `file://${path}`;
  return {
    processId: process.pid,
    clientInfo: { name: "Armadra", version },
    rootUri: uri,
    workspaceFolders: [{ uri, name: basename(path) || "workspace" }],
    capabilities: clientCapabilities,
    initializationOptions: initializationOptions ?? null,
  };
}

/**
 * The capabilities the host claims towards the server.
 *
 * This is the host's own set, not the browser's: the host is the LSP client. A
 * browser's capabilities are intersected with the server's answer before the
 * session sees `initialize`, which is what lets one server serve two clients
 * that asked for different things.
 */
export function hostCapabilities(): JsonObject {
  return {
    workspace: {
      workspaceFolders: true,
      configuration: true,
      applyEdit: true,
      didChangeConfiguration: { dynamicRegistration: false },
    },
    textDocument: {
      synchronization: {
        didSave: true,
        willSave: false,
        dynamicRegistration: false,
      },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      completion: { completionItem: { snippetSupport: false } },
      hover: { contentFormat: ["markdown", "plaintext"] },
      signatureHelp: {},
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      implementation: { linkSupport: true },
      references: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      documentHighlight: {},
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
        },
        resolveSupport: { properties: ["edit"] },
      },
      formatting: {},
      rangeFormatting: {},
      rename: { prepareSupport: true },
    },
    window: { workDoneProgress: true },
    general: { positionEncodings: ["utf-16"] },
  };
}
