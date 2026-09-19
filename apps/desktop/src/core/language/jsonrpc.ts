/**
 * `Content-Length` framing, message classification and id namespacing
 * (language service design §2.2 `jsonrpc`).
 *
 * ## Why this is hand-written rather than `vscode-jsonrpc`
 *
 * `vscode-jsonrpc` is a *client*: it owns the id space, matches responses to
 * the promises it created, and refuses a method it has no handler for. Every
 * one of those is the opposite of what a proxy needs.
 *
 *   * A response here belongs to a **browser session**, not to a local
 *     promise. The id has to be renamed on the way out and renamed back on the
 *     way in ({@link namespaced}), which a library that mints its own ids
 *     cannot be asked to do.
 *   * An answer past the ceiling must still be **attributed**: the frame is
 *     decoded far enough to recover its id and is then replaced by `-32803`.
 *     `vscode-jsonrpc` would surface a stream error, and the session that
 *     asked would wait forever.
 *   * A frame past {@link HARD_LIMIT} must be **skipped with the stream
 *     resynchronising** on the next one, not close the connection.
 *   * Nothing may be re-interpreted. Unknown methods, unknown result shapes
 *     and a server's own key order all pass through; the allowlist in
 *     `policy` is the only thing that reads a method name.
 *
 * So the framing is 60 lines and the dependency count stays zero. Two
 * decisions worth naming:
 *
 *  * **A message is bytes until it has to be a value.** The decoder hands out
 *    the exact frame it read.
 *  * **Ids are namespaced per session, not per server.** Two browser tabs both
 *    start at id 1; without a namespace the second one's response would be
 *    delivered to the first. The namespace also makes `$/cancelRequest`
 *    checkable: a session may only cancel an id that carries its own name.
 */

import { MAX_MESSAGE_BYTES } from "./limits";

/** What a JSON-RPC message is, structurally. */
export type Kind = "request" | "response" | "notification";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A parsed message. `method` is empty for a response — the caller fills it in
 * from the request it is answering, which is the only place that knows.
 */
export interface Message {
  readonly kind: Kind;
  readonly method: string;
  /** Absent when the message carries no id, or carries `null`. */
  readonly id: JsonValue | undefined;
  value: JsonObject;
}

export type ParseError = "malformed" | "badHeader" | "tooLarge";

/** Reads one JSON-RPC message, or `undefined` when it is not one. */
export function parseMessage(bytes: Buffer | string): Message | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof bytes === "string" ? bytes : bytes.toString("utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
  return fromValue(parsed);
}

export function fromValue(parsed: unknown): Message | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = parsed as JsonObject;
  const rawMethod = value["method"];
  const method = typeof rawMethod === "string" ? rawMethod : "";
  const rawId = value["id"];
  const id = rawId === undefined || rawId === null ? undefined : rawId;
  // A message with no method is an answer; with both it is a call.
  const kind: Kind =
    method === "" ? "response" : id === undefined ? "notification" : "request";
  return { kind, method, id, value };
}

/**
 * The id as the string the wire envelope carries. JSON-RPC allows numbers and
 * strings; both become the same string here, and the original value is put
 * back before the message reaches the client that sent it.
 */
export function idText(id: JsonValue | undefined): string {
  if (id === undefined) return "";
  return typeof id === "string" ? id : JSON.stringify(id);
}

export function messageIdText(message: Message): string {
  return idText(message.id);
}

/**
 * One frame off the stream.
 *
 * `oversize` is deliberately not an error. A response past
 * {@link MAX_MESSAGE_BYTES} still has to be *attributed* — the session that
 * asked for it is waiting — so the body is read far enough to recover its id
 * and then replaced with `-32803`. Dropping it blind would leave that session
 * waiting for a reply that is never coming.
 */
export interface Frame {
  readonly body: Buffer;
  readonly oversize: boolean;
}

/**
 * The point past which a frame is not read at all. Well above the message
 * ceiling, and far below anything that could exhaust memory.
 */
export const HARD_LIMIT = 8 * 1024 * 1024;

/** A header this long is not a header. */
const MAX_HEADER_BYTES = 8 * 1024;

/** `Content-Length: <n>\r\n\r\n<body>`. */
export function encode(body: Buffer | string): Buffer {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "utf8"),
    payload,
  ]);
}

export type DecodeResult =
  | { readonly kind: "frame"; readonly frame: Frame }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly error: ParseError };

/**
 * Incremental reader for a server's stdout.
 *
 * Servers write whenever they like, so a read can hand back half a header,
 * three whole messages, or a message split across ten reads. The decoder keeps
 * whatever it could not use and never assumes a read boundary is a message
 * boundary.
 */
export class Decoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(bytes: Buffer): void {
    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(bytes)
        : Buffer.concat([this.buffer, bytes]);
  }

  /** The next complete frame, `pending` when more bytes are needed. */
  next(): DecodeResult {
    const split = this.buffer.indexOf("\r\n\r\n", 0, "utf8");
    if (split < 0) {
      // Refusing here stops an endless "need more bytes" from becoming
      // unbounded memory.
      if (this.buffer.byteLength > MAX_HEADER_BYTES) {
        return { kind: "error", error: "badHeader" };
      }
      return { kind: "pending" };
    }
    const header = this.buffer.subarray(0, split).toString("utf8");
    const length = contentLength(header);
    if (length === undefined) return { kind: "error", error: "badHeader" };
    const end = split + 4 + length;
    if (this.buffer.byteLength < end) return { kind: "pending" };
    if (length > HARD_LIMIT) {
      // Skip the body entirely; there is nothing worth recovering from a frame
      // this size, and the stream resynchronises on the next one.
      this.buffer = this.buffer.subarray(end);
      return { kind: "error", error: "tooLarge" };
    }
    const body = Buffer.from(this.buffer.subarray(split + 4, end));
    this.buffer = this.buffer.subarray(end);
    return {
      kind: "frame",
      frame: { body, oversize: length > MAX_MESSAGE_BYTES },
    };
  }
}

function contentLength(header: string): number | undefined {
  for (const line of header.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") {
      continue;
    }
    const value = line.slice(colon + 1).trim();
    if (!/^\d+$/.test(value)) return undefined;
    return Number.parseInt(value, 10);
  }
  return undefined;
}

/* ------------------------------ id namespacing ---------------------------- */

/** The id this session's request travels under. Sessions never see it. */
export function namespaced(sequence: number, sessionId: string): string {
  return `${sequence}:${sessionId}`;
}

/** The session a namespaced id belongs to, or `undefined` if it is not ours. */
export function sessionOf(id: string): string | undefined {
  const colon = id.indexOf(":");
  if (colon < 0) return undefined;
  const sequence = id.slice(0, colon);
  const session = id.slice(colon + 1);
  if (session.length === 0 || !/^\d+$/.test(sequence)) return undefined;
  return session;
}

/* -------------------------------- responses ------------------------------- */

/** JSON-RPC error codes this proxy produces itself. */
export const METHOD_NOT_FOUND = -32601;
export const INVALID_REQUEST = -32600;
/**
 * LSP's own "the request failed for a reason that is not a protocol error":
 * used for the in-flight ceiling, the message ceiling and request timeouts.
 */
export const REQUEST_FAILED = -32803;
export const REQUEST_CANCELLED = -32800;

export function errorResponse(
  id: JsonValue | undefined,
  code: number,
  message: string,
): JsonObject {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

export function resultResponse(
  id: JsonValue | undefined,
  result: JsonValue,
): JsonObject {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function notification(method: string, params: JsonValue): JsonObject {
  return { jsonrpc: "2.0", method, params };
}

export function request(
  id: JsonValue,
  method: string,
  params: JsonValue,
): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}
