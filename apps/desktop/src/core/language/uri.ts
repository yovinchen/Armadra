/**
 * Uri rewriting between the browser and the execution host (design §2.2
 * `uri`).
 *
 * The browser knows a workspace-relative path and nothing else. The server
 * knows `file://` and nothing else. Every message that crosses between them
 * passes through here.
 *
 * **Why this is field-driven and not a blind string replace.** A blind replace
 * over the whole payload would also rewrite uris inside hover Markdown, inside
 * a diagnostic's message text and inside code snippets — turning documentation
 * into broken links, and worse, rewriting *towards* the server would happily
 * convert prose a user typed. So the rewrite walks the known fields:
 * `textDocument.uri`, `uri`, `targetUri`, `location.uri`, `WorkspaceEdit.changes`
 * keys and `documentChanges[].textDocument.uri`.
 *
 * **What happens outside the root.** A `file:` uri the workspace does not
 * contain becomes `armadra-external:///<opaque>`; it carries no path, so the
 * browser cannot learn where the file lives, and the first version does not
 * open it. Any other scheme (`http:`, `untitled:`, `jdt:`) passes through.
 */

import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "./jsonrpc";

/** What the browser sees. A workspace-relative path with no host part. */
export const WORKSPACE_SCHEME = "armadra";
/** Something real, outside this workspace. Deliberately opaque. */
export const EXTERNAL_SCHEME = "armadra-external";

/** The keys whose *values* are uris. */
const URI_KEYS = ["uri", "targetUri", "rootUri", "newUri", "oldUri"];

export type Direction = "toHost" | "toWeb";

/**
 * Rewrites uris for one workspace root, in both directions.
 *
 * `root` is the canonical absolute path of the workspace. Externals are
 * remembered so a `definition` result the user clicks can be recognised again;
 * nothing is ever handed back out as a path.
 */
export class Rewriter {
  private readonly rootPath: string;
  private readonly external = new Map<string, string>();

  constructor(root: string) {
    // A trailing separator makes "inside the root" a prefix test that
    // `/project` cannot pass for `/project-2`.
    let normalized = root.replace(/\\/g, "/");
    while (normalized.endsWith("/") && normalized.length > 1) {
      normalized = normalized.slice(0, -1);
    }
    this.rootPath = normalized;
  }

  root(): string {
    return this.rootPath;
  }

  /** `armadra:///<rel>` for a workspace-relative path. */
  workspaceUri(relative: string): string {
    return `${WORKSPACE_SCHEME}:///${encodePath(stripLeadingSlashes(relative))}`;
  }

  /** `file://<root>/<rel>` for the same path. */
  fileUri(relative: string): string {
    return `file://${encodePath(this.rootPath)}/${encodePath(stripLeadingSlashes(relative))}`;
  }

  /**
   * The workspace-relative path a browser uri names, or `undefined` when it is
   * not one of ours.
   */
  relativeOf(uri: string): string | undefined {
    const prefix = `${WORKSPACE_SCHEME}:///`;
    if (!uri.startsWith(prefix)) return undefined;
    const decoded = decodePath(uri.slice(prefix.length));
    if (decoded.length === 0 || decoded.includes("..")) return undefined;
    return decoded;
  }

  /**
   * Browser → execution host. Anything that is not a workspace uri is left
   * exactly as it is; an external id cannot be turned back into a path, so a
   * client that echoes one back gets it rejected rather than resolved.
   */
  private toHost(uri: string): string {
    const relative = this.relativeOf(uri);
    return relative === undefined ? uri : this.fileUri(relative);
  }

  /** Execution host → browser. */
  private toWeb(uri: string): string {
    if (!uri.startsWith("file://")) return uri;
    const rest = uri.slice("file://".length);
    // `file:///path` and `file://localhost/path` both name a local file.
    const path = decodePath(
      rest.startsWith("localhost") ? rest.slice("localhost".length) : rest,
    );
    if (path.startsWith(`${this.rootPath}/`)) {
      const relative = path.slice(this.rootPath.length + 1);
      if (relative.length > 0) return this.workspaceUri(relative);
    }
    if (path === this.rootPath) return `${WORKSPACE_SCHEME}:///`;
    return this.externalId(path);
  }

  /**
   * A stable opaque id for a path outside the root. The same file gets the
   * same id for the life of the process, so a list the user is looking at does
   * not reshuffle; the id carries no path and is never resolved back.
   */
  private externalId(path: string): string {
    const digest = createHash("sha256").update(path, "utf8").digest("hex");
    const id = digest.slice(0, 16);
    if (!this.external.has(id)) this.external.set(id, path);
    return `${EXTERNAL_SCHEME}:///${id}`;
  }

  static isExternal(uri: string): boolean {
    return uri.startsWith(EXTERNAL_SCHEME);
  }

  /** Rewrites every known uri field in a whole JSON-RPC message, in place. */
  rewrite(value: JsonValue, direction: Direction): void {
    this.walk(value, direction);
  }

  private map(uri: string, direction: Direction): string {
    return direction === "toHost" ? this.toHost(uri) : this.toWeb(uri);
  }

  private walk(value: JsonValue, direction: Direction): void {
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, direction);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const object = value as JsonObject;
    this.rewriteChanges(object, direction);
    for (const key of Object.keys(object)) {
      const child = object[key];
      if (URI_KEYS.includes(key) && typeof child === "string") {
        object[key] = this.map(child, direction);
        continue;
      }
      if (child !== undefined) this.walk(child, direction);
    }
  }

  /**
   * `WorkspaceEdit.changes` is the one place a uri is a *key*, so it needs its
   * own pass — a generic value walk would never see it.
   */
  private rewriteChanges(object: JsonObject, direction: Direction): void {
    const changes = object["changes"];
    if (
      changes === null ||
      changes === undefined ||
      typeof changes !== "object" ||
      Array.isArray(changes)
    ) {
      return;
    }
    const rewritten: JsonObject = {};
    for (const [uri, edits] of Object.entries(changes)) {
      if (edits !== undefined) rewritten[this.map(uri, direction)] = edits;
    }
    object["changes"] = rewritten;
  }
}

function stripLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Percent-encodes the characters a uri path may not carry literally.
 *
 * `/` stays a separator, and the unreserved set of RFC 3986 stays literal.
 * Everything else — spaces, `#`, `?`, and every non-ASCII byte, which is how a
 * Chinese file name survives — is encoded.
 */
function encodePath(path: string): string {
  let encoded = "";
  for (const byte of Buffer.from(path, "utf8")) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~/:]/.test(character)) {
      encoded += character;
      continue;
    }
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function decodePath(path: string): string {
  const out: number[] = [];
  let index = 0;
  while (index < path.length) {
    if (path[index] === "%" && index + 2 < path.length) {
      const hex = path.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }
    // Any character past U+00FF cannot have arrived percent-encoded, so it is
    // taken as its own utf-8 bytes rather than truncated to one.
    for (const byte of Buffer.from(path[index] ?? "", "utf8")) out.push(byte);
    index += 1;
  }
  return Buffer.from(out).toString("utf8");
}
