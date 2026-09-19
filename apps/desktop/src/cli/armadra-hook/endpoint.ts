/**
 * Endpoint file parsing, candidate discovery and per-node token lookup.
 *
 * The runtime writes `<data>/hook-endpoint.env` with mode 0600. It is a
 * `KEY='value'` file using POSIX single-quote quoting, which means a literal
 * quote inside a value is written as the four byte sequence `'\''`.
 *
 * ## Candidate discovery (W0.3)
 *
 * A terminal's environment is set once, at spawn time, and can then outlive
 * the runtime that wrote it (a tmux session especially). So this client checks
 * a small, bounded list of places in order, where only a *transport* failure
 * (refused connection, timeout, missing socket) advances to the next one — any
 * HTTP answer at all, including a 4xx/5xx, is authoritative and ends the
 * search.
 *
 *   1. **`ARMADRA_ENDPOINT_FILE`** — the address this terminal's environment
 *      was told to use when it was created. Preferred because it is what the
 *      runtime that actually *spawned this terminal* published.
 *   2. **The default data-directory location** — `<data_dir>/hook-endpoint.env`,
 *      resolved the same way the runtime resolves its data directory. Catches
 *      the case where (1) is unset, unreadable, or simply names a location the
 *      live runtime is not the one writing to any more.
 *   3. **`<data_dir>/endpoints.json`** — a transport-only discovery file with
 *      no credentials in it at all. It is only useful once (1) or (2) has
 *      already produced a token and a node-token directory: both are derived
 *      from a secret that survives an ungraceful restart, so a token read from
 *      a *stale* endpoint file is still valid even when the port or socket it
 *      names is not. With no earlier candidate to borrow credentials from,
 *      this channel is skipped entirely — presenting no bearer at all would
 *      draw a `401`, which is an HTTP answer and would wrongly end the search
 *      right there.
 *
 * The list is capped at {@link MAX_CANDIDATES}: a hook call sits on the hot
 * path of every CLI event, so the number of connect attempts it can make has
 * to stay small and constant.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { asObject, asString, tryParseJson } from "./json.js";

/** Bound on how many endpoints one invocation will try before giving up. */
export const MAX_CANDIDATES = 3;

/** Keys the client understands. Unknown keys are kept but ignored. */
export const KEY_PORT = "ARMADRA_HOOK_PORT";
export const KEY_SOCK = "ARMADRA_HOOK_SOCK";
export const KEY_TOKEN = "ARMADRA_HOOK_TOKEN";
export const KEY_TOKEN_DIR = "ARMADRA_NODE_TOKEN_DIR";
export const KEY_VERSION = "ARMADRA_HOOK_VERSION";

/** Reads an environment variable, treating an empty value as unset. */
export function envVar(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** Path of the endpoint file for this invocation. */
export function endpointFilePath(): string | undefined {
  return envVar("ARMADRA_ENDPOINT_FILE");
}

/**
 * The per-user data directory a runtime with no explicit override would use.
 * `undefined` only when the platform gives us nothing to build a path from
 * (no `HOME`, no `XDG_DATA_HOME`, no `LOCALAPPDATA`).
 */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const override = envVar("ARMADRA_DATA_DIR");
  if (override !== undefined) return override;
  if (platform === "darwin") {
    const home = envVar("HOME");
    return home === undefined
      ? undefined
      : path.join(home, "Library/Application Support/Armadra");
  }
  if (platform === "win32") {
    const local = envVar("LOCALAPPDATA");
    return local === undefined ? undefined : path.join(local, "Armadra");
  }
  const base =
    envVar("XDG_DATA_HOME") ??
    (envVar("HOME") ? path.join(envVar("HOME")!, ".local/share") : undefined);
  return base === undefined ? undefined : path.join(base, "armadra");
}

/** A node id is only used to build filesystem paths after it passes this gate. */
export function isValidNodeId(nodeId: string): boolean {
  return (
    nodeId.length > 0 && nodeId.length <= 80 && /^[A-Za-z0-9_-]+$/.test(nodeId)
  );
}

/**
 * Parses the `KEY='value'` body of an endpoint file.
 *
 * Lines that are blank or start with `#` are skipped, as are lines without an
 * `=`. Values may be single quoted (with `'\''` escapes), double quoted, or
 * bare.
 */
export function parseEndpointFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Tolerate the `export KEY=...` form some shells like to emit.
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === "") continue;
    map.set(key, unquote(line.slice(separator + 1).trim()));
  }
  return map;
}

/** Removes one layer of shell quoting from an endpoint-file value. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    // POSIX single quoting: `'` inside the value was emitted as `'\''`.
    return value.slice(1, -1).split("'\\''").join("'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).split('\\"').join('"').split("\\\\").join("\\");
  }
  return value;
}

/** The runtime addresses and credentials for one invocation. */
export interface Endpoint {
  path: string;
  port?: number;
  sock?: string;
  hookToken?: string;
  tokenDir?: string;
  version?: string;
}

/**
 * Reads and parses the endpoint file. Any IO or parse problem is an error;
 * callers in hook mode turn that into a silent exit 0.
 */
export function loadEndpoint(
  file: string,
): { ok: Endpoint } | { error: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { error: `cannot read endpoint file ${file}: ${describe(error)}` };
  }
  const map = parseEndpointFile(text);
  let port: number | undefined;
  const rawPort = map.get(KEY_PORT);
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(parsed) || parsed > 65535) {
      return { error: `${KEY_PORT} is not a port number: ${rawPort}` };
    }
    port = parsed;
  }
  const sock = nonEmpty(map.get(KEY_SOCK));
  if (port === undefined && sock === undefined) {
    return {
      error: `endpoint file ${file} has neither ${KEY_PORT} nor ${KEY_SOCK}`,
    };
  }
  return {
    ok: {
      path: file,
      port,
      sock,
      hookToken: nonEmpty(map.get(KEY_TOKEN)),
      tokenDir: nonEmpty(map.get(KEY_TOKEN_DIR)),
      version: nonEmpty(map.get(KEY_VERSION)),
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "No such file or directory (os error 2)";
  if (code === "EACCES") return "Permission denied (os error 13)";
  return error instanceof Error ? error.message : String(error);
}

/**
 * Directory that holds the permission request / answer files.
 *
 * Deliberately derived from the endpoint file rather than configured
 * separately, so a stale terminal can never write into a directory that a
 * newer runtime is not watching.
 */
export function pendingDir(endpoint: Endpoint): string {
  const parent = path.dirname(endpoint.path);
  return path.join(parent === "" ? "." : parent, "pending");
}

/**
 * Looks the node token up by name — never scans the directory.
 *
 * Deliberately re-reads the file on every call rather than caching: after
 * failover adopts a different candidate, the caller must present *that*
 * candidate's token, not one carried over from another directory (W0.3).
 */
export function nodeToken(
  endpoint: Endpoint,
  nodeId: string,
): string | undefined {
  if (!isValidNodeId(nodeId)) return undefined;
  if (endpoint.tokenDir === undefined) return undefined;
  try {
    const token = fs
      .readFileSync(path.join(endpoint.tokenDir, nodeId), "utf8")
      .trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * Builds the bounded, ordered candidate list described at the top of this
 * module. Each entry is a fully-formed {@link Endpoint} — address, bearer and
 * token directory — ready to try in order.
 *
 * Nothing here talks to the network: this only decides *what* to try, never
 * *whether* it answers.
 */
export function discoverCandidates(): Endpoint[] {
  return discoverCandidatesFrom(endpointFilePath(), defaultDataDir());
}

/**
 * The testable half of {@link discoverCandidates}: same ordering, but with the
 * two environment reads passed in instead of read from the process.
 */
export function discoverCandidatesFrom(
  envEndpointFile: string | undefined,
  dataDir: string | undefined,
): Endpoint[] {
  const candidates: Endpoint[] = [];
  const tried: string[] = [];

  // 1. What this invocation's environment was told, e.g. by the runtime that
  // spawned the terminal this hook is running in.
  if (envEndpointFile !== undefined) {
    const loaded = loadEndpoint(envEndpointFile);
    if ("ok" in loaded) candidates.push(loaded.ok);
    tried.push(envEndpointFile);
  }

  if (dataDir === undefined) return candidates.slice(0, MAX_CANDIDATES);

  // 2. The well-known location for whatever runtime currently owns this data
  // directory, independent of what (1) happened to name. Skipped when it is
  // the exact same file already tried above.
  const defaultPath = path.join(dataDir, "hook-endpoint.env");
  if (!tried.includes(defaultPath)) {
    const loaded = loadEndpoint(defaultPath);
    if ("ok" in loaded) candidates.push(loaded.ok);
    tried.push(defaultPath);
  }

  // 3. `endpoints.json`'s transport addresses, reusing the token and token
  // directory of the most recently loaded full candidate.
  const credentials = candidates.at(-1);
  if (credentials !== undefined) {
    const endpointsJson = path.join(dataDir, "endpoints.json");
    const address = readEndpointsJsonRuntime(endpointsJson);
    if (
      address !== undefined &&
      (address.port !== credentials.port || address.sock !== credentials.sock)
    ) {
      candidates.push({
        path: endpointsJson,
        port: address.port,
        sock: address.sock,
        hookToken: credentials.hookToken,
        tokenDir: credentials.tokenDir,
        version: credentials.version,
      });
    }
  }

  return candidates.slice(0, MAX_CANDIDATES);
}

/**
 * Pulls the `runtime` service's transport address out of `endpoints.json`.
 * `undefined` when the file is missing, unparsable, or names neither a port
 * nor a socket.
 */
function readEndpointsJsonRuntime(
  file: string,
): { port?: number; sock?: string } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const runtime = asObject(asObject(tryParseJson(text))?.["runtime"]);
  if (runtime === undefined) return undefined;
  const http = asString(runtime["http"]);
  const tail = http?.split(":").at(-1);
  const port =
    tail !== undefined && /^\d+$/.test(tail) && Number(tail) <= 65535
      ? Number(tail)
      : undefined;
  const socket = nonEmpty(asString(runtime["socket"]));
  if (port === undefined && socket === undefined) return undefined;
  return { port, sock: socket };
}
