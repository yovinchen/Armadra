import { readFileSync } from "node:fs";
import { writeSecret } from "../paths";

/**
 * `<dataDir>/hook-endpoint.env` — contract §5.2 and §5 item 4.
 *
 * The hook client re-reads this file on *every* invocation, because a terminal
 * (especially a tmux one) routinely outlives the core that started it and the
 * next core may come back on a different port. The file therefore holds
 * addresses and the app bearer, and nothing that identifies a node.
 *
 * The format is deliberately `KEY='VALUE'`: a POSIX shell can `.` it, and a
 * three-line parser in any language can read it. Single quotes never need an
 * escape table — the one character that cannot appear inside them is written
 * as `'\''`, the standard shell idiom.
 */

/**
 * Bumped when the request shape changes in a way an older client cannot
 * produce. Mirrors `ARMADRA_HOOK_VERSION` in the endpoint file.
 */
export const HOOK_PROTOCOL_VERSION = 1;

export interface Endpoint {
  /**
   * The core's own TCP port. The client falls back to it when the socket is
   * unavailable (Windows, or a socket left over from a dead core). `undefined`
   * on a desktop install, which listens on no port at all: the key is then
   * omitted, so a client that cannot reach the socket has nowhere to fall back
   * to rather than a wrong port to talk to.
   */
  readonly port?: number | undefined;
  /** Unix socket path; `undefined` on Windows. */
  readonly socket?: string | undefined;
  readonly token: string;
  readonly nodeTokenDir: string;
}

function pushLine(lines: string[], key: string, value: string): void {
  lines.push(`${key}='${value.split("'").join("'\\''")}'`);
}

export function render(endpoint: Endpoint): string {
  const lines = [
    "# Armadra hook endpoint — rewritten by the core.",
    "# Values are single-quoted POSIX strings; re-read this file on every",
    "# hook invocation, the port changes when the core restarts.",
  ];
  pushLine(lines, "ARMADRA_HOOK_VERSION", String(HOOK_PROTOCOL_VERSION));
  if (endpoint.port !== undefined) {
    pushLine(lines, "ARMADRA_HOOK_PORT", String(endpoint.port));
  }
  if (endpoint.socket !== undefined) {
    pushLine(lines, "ARMADRA_HOOK_SOCK", endpoint.socket);
  }
  pushLine(lines, "ARMADRA_HOOK_TOKEN", endpoint.token);
  pushLine(lines, "ARMADRA_NODE_TOKEN_DIR", endpoint.nodeTokenDir);
  return `${lines.join("\n")}\n`;
}

/**
 * 0600 file in a 0700 directory, written tmp + rename so a client reading
 * concurrently sees either the old endpoint or the new one, never a truncated
 * bearer.
 */
export function write(path: string, endpoint: Endpoint): void {
  writeSecret(path, render(endpoint));
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).split("'\\''").join("'");
  }
  return raw;
}

export function parse(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === "") continue;
    values.set(key, unquote(line.slice(separator + 1).trim()));
  }
  return values;
}

/**
 * Parses an endpoint file back into its keys. Only used to recover the bearer
 * from a previous run and to answer `/health` — an unreadable or corrupt file
 * simply yields nothing, and the caller mints a new bearer.
 */
export function read(path: string): Map<string, string> {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}
