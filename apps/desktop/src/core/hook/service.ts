import { rmSync } from "node:fs";
import { join } from "node:path";
import type { HookHealth } from "../http/health";
import { hookEndpointFile, nodeTokenDir } from "../paths";
import { HookAuth, type Verdict } from "./auth";
import * as endpointFile from "./endpoint";
import { type Memory, newMemory } from "./reduce";

/**
 * The hook service — contract §5.2 / §5.4.
 *
 * Three surfaces, one router:
 *
 *   * the core's own TCP listener, so a client that cannot reach the socket
 *     (Windows, a stale socket path) still has somewhere to go;
 *   * a Unix socket at `<dataDir>/hook.sock`, which is the preferred path
 *     because it is not reachable from another machine at all;
 *   * `<dataDir>/hook-endpoint.env`, which tells a client where those two are.
 *
 * `HookService` owns the credentials and the reducer's per-node memory.
 */
export class HookService {
  private readonly auth: HookAuth;
  private readonly memory = new Map<string, Memory>();
  private currentPort: number | undefined;

  /**
   * A data directory we cannot write is not fatal: the service falls back to
   * in-memory credentials so the rest of the core still starts, and the
   * endpoint file simply never appears — which the client reads as "no core".
   */
  constructor(
    readonly dataDir: string,
    port?: number | undefined,
    private readonly onWarning: (
      message: string,
      detail: unknown,
    ) => void = () => {},
  ) {
    this.currentPort = port;
    const existing = endpointFile.read(hookEndpointFile(dataDir));
    const bearer = existing.get("ARMADRA_HOOK_TOKEN");
    let auth: HookAuth;
    try {
      auth = HookAuth.load(dataDir, bearer);
    } catch (error) {
      this.onWarning(
        "could not persist the hook secret; using an ephemeral one",
        error,
      );
      auth = HookAuth.ephemeral();
    }
    this.auth = auth;
  }

  endpointFile(): string {
    return hookEndpointFile(this.dataDir);
  }

  nodeTokenDir(): string {
    return nodeTokenDir(this.dataDir);
  }

  /** `undefined` on Windows, where the client uses the TCP fallback. */
  socketPath(): string | undefined {
    return process.platform === "win32"
      ? undefined
      : join(this.dataDir, "hook.sock");
  }

  port(): number | undefined {
    return this.currentPort;
  }

  bearer(): string {
    return this.auth.bearer;
  }

  bearerMatches(presented: string | undefined): boolean {
    return this.auth.bearerMatches(presented);
  }

  verdict(nodeId: string, presented: string | undefined): Verdict {
    return this.auth.verdict(nodeId, presented);
  }

  /**
   * Mints (or refreshes) `<dataDir>/node-tokens/<nodeId>`. Called when an
   * agent terminal is created and by the refresh route.
   */
  issueNodeToken(nodeId: string): string {
    return this.auth.writeNodeToken(this.nodeTokenDir(), nodeId);
  }

  /**
   * Runs `action` against this node's reducer memory. JavaScript has one
   * thread of execution per turn, so the lock the Rust version holds here is
   * the synchronous call itself: `action` must not await.
   */
  withMemory<T>(nodeId: string, action: (memory: Memory) => T): T {
    let memory = this.memory.get(nodeId);
    if (memory === undefined) {
      memory = newMemory();
      this.memory.set(nodeId, memory);
    }
    return action(memory);
  }

  /** Writes the endpoint file. Called at start-up and whenever the port moves. */
  publishEndpoint(port: number | undefined): void {
    this.currentPort = port;
    endpointFile.write(this.endpointFile(), {
      port,
      socket: this.socketPath(),
      token: this.auth.bearer,
      nodeTokenDir: this.nodeTokenDir(),
    });
  }

  /**
   * Republishes the endpoint file without a socket entry — called when the
   * Unix socket listener fails to bind after {@link publishEndpoint} already
   * advertised it optimistically (W0.3). Without this, a client would keep
   * trying a socket that will never accept a connection instead of falling
   * back to the TCP port this run still has, if any.
   *
   * A hook client only ever moves to its next candidate on a *transport*
   * failure, so leaving a dead socket in the file would not just be slower —
   * every attempt against this core would burn its socket-connect budget
   * first.
   */
  withdrawSocket(): void {
    const port = this.port();
    try {
      endpointFile.write(this.endpointFile(), {
        port,
        socket: undefined,
        token: this.auth.bearer,
        nodeTokenDir: this.nodeTokenDir(),
      });
    } catch (error) {
      this.onWarning(
        "could not update the hook endpoint file after a failed socket bind",
        error,
      );
    }
    // No port either: this run has no hook surface left to advertise at all,
    // so the file itself has to go rather than name a dead address.
    if (port === undefined) this.withdraw();
  }

  /**
   * Removes the endpoint file, so a stale terminal's next hook invocation
   * reads "no endpoint here" instead of an address this process no longer
   * answers on. Called on a clean shutdown and when start-up itself could not
   * publish (W0.3).
   */
  withdraw(): void {
    try {
      rmSync(this.endpointFile(), { force: true });
    } catch (error) {
      this.onWarning("could not remove the hook endpoint file", error);
    }
  }

  /**
   * What `GET /health` reports about the hook surface.
   *
   * The file names this core when the transport it advertises is the one we
   * are actually on: the port when we have one, the socket otherwise. A
   * socket-only core whose file still carries a port is a leftover from a
   * previous run and is reported as not ok.
   */
  health(): HookHealth {
    const published = endpointFile.read(this.endpointFile());
    const port = this.port();
    const sock = this.socketPath();
    const ok =
      port !== undefined
        ? published.get("ARMADRA_HOOK_PORT") === String(port)
        : !published.has("ARMADRA_HOOK_PORT") &&
          published.get("ARMADRA_HOOK_SOCK") === sock;
    return {
      ...(sock === undefined ? {} : { sock }),
      ...(port === undefined ? {} : { port }),
      ok,
    };
  }
}

/**
 * The service of the running core, for the two places that cannot be handed
 * one: the terminal domain, which mints a node token at creation, and the
 * health document.
 *
 * The same shape `core/events` uses for its stream — a module-level slot
 * rather than a field on `CoreContext`, so a domain that only needs it in one
 * statement does not change the assembly signature for everybody.
 */
let assembled: HookService | undefined;

export function hookService(): HookService | undefined {
  return assembled;
}

export function setHookService(service: HookService | undefined): void {
  assembled = service;
}
