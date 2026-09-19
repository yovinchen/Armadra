import { connect } from "node:net";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { hardenDirectory, hardenFile } from "./paths";

/**
 * Where the core accepts HTTP and WebSocket requests.
 *
 * Three transports, one router. A desktop install wants no TCP port at all:
 * the shell reaches the core over a Unix socket (macOS / Linux) or a named
 * pipe (Windows), both of which the OS scopes to the current user and which
 * nothing on the network can reach. A browser install still needs TCP, so the
 * same router is served on a loopback listener whose port is normally handed
 * out by the kernel and published in `endpoints.json`.
 *
 * ```text
 * --listen tcp:127.0.0.1:0        kernel-assigned loopback port
 * --listen tcp:127.0.0.1:43120    a fixed port; already in use is an error
 * --listen unix:/abs/path.sock    Unix domain socket, 0600 in a 0700 directory
 * --listen pipe:armadra-xyz       \\.\pipe\armadra-xyz
 * ```
 *
 * A spec for another platform's transport parses (so the same argument can be
 * tested everywhere) and fails at bind time with a message that says so,
 * rather than silently falling back to a port. The parser is a byte-for-byte
 * port of `apps/runtime/src/listen.rs`, because `--listen` is an argument the
 * shell writes and either implementation reads.
 */

/** The Windows pipe namespace. A name is always rooted here. */
export const PIPE_PREFIX = "\\\\.\\pipe\\";

export type ListenSpec =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "pipe"; readonly name: string };

export type ParseResult =
  | { readonly ok: true; readonly spec: ListenSpec }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses `tcp:ADDR:PORT`, `unix:PATH` or `pipe:NAME`. A bare `ADDR:PORT` is
 * accepted as `tcp:` so `--listen 127.0.0.1:0` reads naturally.
 */
export function parseListenSpec(raw: string): ParseResult {
  const spec = raw.trim();
  if (spec.startsWith("tcp:")) return parseTcp(spec.slice(4));
  if (spec.startsWith("unix:")) {
    const path = spec.slice(5);
    // A leading `/`, not the host platform's idea of "absolute": the spec
    // describes a Unix socket path, and asking Windows what absolute means
    // would make the same argument parse on Linux and be rejected here, where
    // *binding* is what has to fail, with a message naming the transport.
    if (!path.startsWith("/")) {
      return {
        ok: false,
        reason: `--listen unix:PATH needs an absolute path: ${path}`,
      };
    }
    return { ok: true, spec: { kind: "unix", path } };
  }
  if (spec.startsWith("pipe:")) return parsePipe(spec.slice(5));
  const bare = parseTcp(spec);
  return bare.ok
    ? bare
    : {
        ok: false,
        reason: `--listen expects tcp:ADDR:PORT, unix:PATH or pipe:NAME, not ${JSON.stringify(spec)}`,
      };
}

function parseTcp(rest: string): ParseResult {
  const failure: ParseResult = {
    ok: false,
    reason: `--listen tcp: needs an IP address and port, not ${JSON.stringify(rest)}`,
  };
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return failure;
  const host = rest.slice(0, separator);
  const port = Number(rest.slice(separator + 1));
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    rest.slice(separator + 1) === ""
  ) {
    return failure;
  }
  const literal = ipLiteral(host);
  if (literal === undefined) return failure;
  return { ok: true, spec: { kind: "tcp", host: literal, port } };
}

/**
 * The host half of a TCP spec, or `undefined` when it is not an IP literal.
 *
 * A hostname is refused the way Rust's `SocketAddr` refuses it: a spec that
 * resolved through DNS could name a machine on the network, and "loopback
 * only" would then depend on somebody's `/etc/hosts`.
 */
function ipLiteral(host: string): string | undefined {
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    return isIpv6(inner) ? host : undefined;
  }
  if (isIpv4(host)) return host;
  // A bare IPv6 address has its own colons, which the port split already ate.
  return undefined;
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  );
}

function isIpv6(host: string): boolean {
  // Enough to tell an address from a hostname: hex groups and at most one `::`.
  if (!/^[0-9A-Fa-f:.]+$/.test(host)) return false;
  return host.includes(":") && host.split("::").length <= 2;
}

function parsePipe(rest: string): ParseResult {
  // The name is concatenated into a path. Anything that could climb out of the
  // pipe namespace, or that Windows would reject, is refused here so the
  // failure reads the same on every platform.
  const valid =
    rest.length > 0 && rest.length <= 200 && /^[A-Za-z0-9._-]+$/.test(rest);
  if (!valid) {
    return {
      ok: false,
      reason: `--listen pipe:NAME accepts up to 200 characters of [A-Za-z0-9._-], not ${JSON.stringify(rest)}`,
    };
  }
  return { ok: true, spec: { kind: "pipe", name: rest } };
}

/** The `--listen` spelling of a spec; the inverse of `parseListenSpec`. */
export function formatListenSpec(spec: ListenSpec): string {
  switch (spec.kind) {
    case "tcp":
      return `tcp:${spec.host}:${spec.port}`;
    case "unix":
      return `unix:${spec.path}`;
    case "pipe":
      return `pipe:${spec.name}`;
  }
}

/** The authority a TCP spec's URLs are built from. */
export function tcpAuthority(spec: ListenSpec): string | undefined {
  return spec.kind === "tcp" ? `${spec.host}:${spec.port}` : undefined;
}

/**
 * Binds one spec on an already-created server.
 *
 * A TCP address that is already taken is an error and stays one: quietly
 * moving to the next port would leave a client that was told to use this
 * address talking to nothing.
 */
export async function bind(
  server: Server,
  spec: ListenSpec,
): Promise<ListenSpec> {
  switch (spec.kind) {
    case "tcp":
      return bindTcp(server, spec.host, spec.port);
    case "unix":
      return bindUnix(server, spec.path);
    case "pipe":
      return bindPipe(server, spec.name);
  }
}

function listening(server: Server, start: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    start();
  });
}

async function bindTcp(
  server: Server,
  host: string,
  port: number,
): Promise<ListenSpec> {
  const address = `${host}:${port}`;
  try {
    await listening(server, () =>
      server.listen({ host: host.replace(/^\[|\]$/g, ""), port }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `${address} is already in use; stop the process holding it or pass ` +
          `--listen tcp:127.0.0.1:0 to let the kernel choose a port`,
      );
    }
    throw new Error(`could not listen on ${address}: ${describe(error)}`);
  }
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error(`could not read the bound address of ${address}`);
  }
  return { kind: "tcp", host, port: bound.port };
}

async function bindUnix(server: Server, path: string): Promise<ListenSpec> {
  if (process.platform === "win32") {
    throw new Error(
      `--listen unix:${path} needs a Unix-like platform; use --listen pipe:NAME here`,
    );
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  hardenDirectory(directory);
  await clearStaleSocket(path);
  await listening(server, () => server.listen(path));
  // The socket is a full grant of the core's API; it is nobody else's.
  hardenFile(path);
  return { kind: "unix", path };
}

/**
 * A socket file left by a core that was killed would refuse the bind. Anything
 * actually listening is proven dead first: a connection that is refused means
 * no accepting process is behind this path.
 */
async function clearStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) {
    throw new Error(
      `${path} exists and is not a socket; refusing to replace it`,
    );
  }
  const held = await socketIsHeld(path);
  if (held === "held") {
    throw new Error(`another core is already listening on ${path}`);
  }
  if (held === "unknown") {
    throw new Error(`cannot tell whether ${path} is stale; leaving it alone`);
  }
  unlinkSync(path);
}

function socketIsHeld(path: string): Promise<"held" | "stale" | "unknown"> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const finish = (answer: "held" | "stale" | "unknown"): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000, () => finish("unknown"));
    socket.on("connect", () => finish("held"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "stale" : "unknown"),
    );
  });
}

async function bindPipe(server: Server, name: string): Promise<ListenSpec> {
  if (process.platform !== "win32") {
    throw new Error(
      `--listen pipe:${name} needs Windows; use --listen unix:PATH here`,
    );
  }
  // TODO(R6): `node:net` creates an ordinary pipe instance. The first-instance
  // flag, `reject_remote_clients` and the per-connection client SID check the
  // Rust listener applies have no Node equivalent and need the session-host's
  // native layer; until then a Windows core is development-only.
  await listening(server, () => server.listen(`${PIPE_PREFIX}${name}`));
  return { kind: "pipe", name };
}

/**
 * Removes a Unix socket this process created. A path that is no longer ours —
 * replaced by a newer core — is left alone.
 */
export function release(spec: ListenSpec): void {
  if (spec.kind !== "unix") return;
  try {
    if (lstatSync(spec.path).isSocket()) unlinkSync(spec.path);
  } catch {
    // Already gone, or never ours.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
