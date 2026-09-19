/**
 * Shadow documents — one copy of every open file, on the execution host
 * (design §2.2 `documents`, §2.5).
 *
 * ## Why the host keeps the text at all
 *
 * Because the server has to be restartable without the editor noticing. When a
 * server is idle-stopped or crashes, the Manager replays `didOpen` for every
 * shadow document; if the text lived only in the browser, a restart would need
 * a round trip per open file and would lose anything typed in between.
 *
 * ## Versions are the host's, not the client's
 *
 * Two browser tabs on the same file both count from 1. The server must see one
 * monotonic sequence, so the host assigns the version it forwards and never
 * passes the client's through.
 *
 * ## One owner per uri
 *
 * The first session to open a uri owns it, and only the owner's edits become
 * `didChange` — two independent drafts of the same buffer cannot both be the
 * truth. When the owner closes, ownership moves to the earliest remaining
 * session and the text is re-sent in full.
 */

import { createHash } from "node:crypto";

import type { JsonValue } from "./jsonrpc";

/**
 * An LSP position: zero-based line, and a character offset in UTF-16 code
 * units, which is what the protocol means by "character" unless a client and
 * server agreed otherwise.
 */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export type ContentChange =
  | { readonly kind: "full"; readonly text: string }
  | {
      readonly kind: "range";
      readonly start: Position;
      readonly end: Position;
      readonly rangeLength: number | undefined;
      readonly text: string;
    };

/** One open file as the execution host sees it. */
export interface Document {
  readonly uri: string;
  languageId: string;
  text: string;
  /** The version last sent to the server. Starts at 1 and only grows. */
  version: number;
  /** Sessions that have this uri open, in the order they opened it. */
  readers: string[];
  /**
   * The digest of the text as it was last read from or written to disk.
   * `undefined` once the buffer has diverged from the file.
   */
  diskSha256: string | undefined;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function documentOwner(document: Document): string | undefined {
  return document.readers[0];
}

/**
 * Whether the buffer still matches what is on disk. A `WorkspaceEdit` only
 * applies to files that do.
 */
export function isClean(document: Document): boolean {
  return (
    document.diskSha256 !== undefined &&
    document.diskSha256 === sha256(document.text)
  );
}

/** What opening a document means for the server. */
export type OpenOutcome =
  /** First reader: the server must be told `didOpen`. */
  | { readonly kind: "opened"; readonly version: number }
  /** Another session already has it open; only the reference count moved. */
  | { readonly kind: "followed"; readonly owner: string };

export type CloseOutcome =
  /** Nothing was open under that uri. */
  | { readonly kind: "unknown" }
  /** Last reader: the server is told `didClose`. */
  | { readonly kind: "closed" }
  /** Somebody else still has it; the server is told nothing. */
  | { readonly kind: "stillOpen" }
  /**
   * The owner left and the earliest remaining session took over. The caller
   * re-sends the whole text so the new owner's next incremental change has a
   * base the server agrees with.
   */
  | {
      readonly kind: "ownerMoved";
      readonly owner: string;
      readonly version: number;
      readonly text: string;
    };

export class Documents {
  private readonly open = new Map<string, Document>();

  get(uri: string): Document | undefined {
    return this.open.get(uri);
  }

  get size(): number {
    return this.open.size;
  }

  isEmpty(): boolean {
    return this.open.size === 0;
  }

  all(): Document[] {
    return [...this.open.values()];
  }

  /** Registers one session's view of a uri. */
  openDocument(
    sessionId: string,
    uri: string,
    languageId: string,
    text: string,
  ): OpenOutcome {
    const existing = this.open.get(uri);
    if (existing !== undefined) {
      if (!existing.readers.includes(sessionId)) {
        existing.readers.push(sessionId);
      }
      const owner = documentOwner(existing) ?? "";
      if (owner !== sessionId) return { kind: "followed", owner };
      return { kind: "opened", version: existing.version };
    }
    this.open.set(uri, {
      uri,
      languageId,
      text,
      version: 1,
      readers: [sessionId],
      diskSha256: sha256(text),
    });
    return { kind: "opened", version: 1 };
  }

  /**
   * Applies a `didChange` from `sessionId`.
   *
   * Returns the new host version, or `undefined` when the session is not the
   * owner — a follower's edits are simply not the document, and saying so with
   * `undefined` keeps that decision in one place.
   */
  change(
    sessionId: string,
    uri: string,
    changes: readonly ContentChange[],
  ): number | undefined {
    const document = this.open.get(uri);
    if (document === undefined) return undefined;
    if (documentOwner(document) !== sessionId) return undefined;
    for (const change of changes) {
      if (change.kind === "full") {
        document.text = change.text;
        continue;
      }
      const span = offsets(document.text, change.start, change.end);
      if (span === undefined) {
        // An unusable range means the shadow text and the client's have
        // diverged; taking the change anyway would corrupt both.
        return undefined;
      }
      document.text =
        document.text.slice(0, span[0]) +
        change.text +
        document.text.slice(span[1]);
    }
    document.version += 1;
    return document.version;
  }

  /**
   * Replaces the whole text — used after an external change is reloaded and
   * after ownership moves.
   */
  replace(
    uri: string,
    text: string,
    diskSha256?: string,
  ): number | undefined {
    const document = this.open.get(uri);
    if (document === undefined) return undefined;
    document.text = text;
    document.version += 1;
    if (diskSha256 !== undefined) document.diskSha256 = diskSha256;
    return document.version;
  }

  /**
   * Drops one session's view. The four outcomes are different instructions for
   * the caller, which is why they are not collapsed into a boolean.
   */
  close(sessionId: string, uri: string): CloseOutcome {
    const document = this.open.get(uri);
    if (document === undefined) return { kind: "unknown" };
    const wasOwner = documentOwner(document) === sessionId;
    document.readers = document.readers.filter(
      (reader) => reader !== sessionId,
    );
    if (document.readers.length === 0) {
      this.open.delete(uri);
      return { kind: "closed" };
    }
    if (wasOwner) {
      document.version += 1;
      return {
        kind: "ownerMoved",
        owner: document.readers[0] as string,
        version: document.version,
        text: document.text,
      };
    }
    return { kind: "stillOpen" };
  }

  /** Everything one session had open, for a disconnect. */
  urisFor(sessionId: string): string[] {
    return this.all()
      .filter((document) => document.readers.includes(sessionId))
      .map((document) => document.uri);
  }

  /** Records that the file on disk now matches the buffer (a save landed). */
  noteSaved(uri: string, digest: string): void {
    const document = this.open.get(uri);
    if (document !== undefined) document.diskSha256 = digest;
  }
}

/** Reads the `contentChanges` array of a `didChange` notification. */
export function parseContentChanges(
  params: JsonValue | undefined,
): ContentChange[] {
  if (
    params === null ||
    params === undefined ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    return [];
  }
  const changes = params["contentChanges"];
  if (!Array.isArray(changes)) return [];
  const out: ContentChange[] = [];
  for (const change of changes) {
    const one = parseOneChange(change);
    if (one !== undefined) out.push(one);
  }
  return out;
}

function parseOneChange(change: JsonValue): ContentChange | undefined {
  if (change === null || typeof change !== "object" || Array.isArray(change)) {
    return undefined;
  }
  const text = change["text"];
  if (typeof text !== "string") return undefined;
  const range = change["range"];
  if (range === undefined || range === null) return { kind: "full", text };
  if (typeof range !== "object" || Array.isArray(range)) return undefined;
  const start = parsePosition(range["start"]);
  const end = parsePosition(range["end"]);
  if (start === undefined || end === undefined) return undefined;
  const rangeLength = change["rangeLength"];
  return {
    kind: "range",
    start,
    end,
    rangeLength: typeof rangeLength === "number" ? rangeLength : undefined,
    text,
  };
}

export function parsePosition(value: JsonValue | undefined): Position | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const line = value["line"];
  const character = value["character"];
  if (typeof line !== "number" || typeof character !== "number") {
    return undefined;
  }
  if (line < 0 || character < 0) return undefined;
  return { line, character };
}

/**
 * Offsets for an LSP range, or `undefined` when the range names something the
 * text does not have.
 *
 * The offsets are JavaScript string indices — UTF-16 code units — which is the
 * same unit the protocol counts `character` in, so no conversion is needed
 * where the Rust port has to walk `char_indices`.
 */
function offsets(
  text: string,
  start: Position,
  end: Position,
): [number, number] | undefined {
  const from = offsetOf(text, start);
  const to = offsetOf(text, end);
  if (from === undefined || to === undefined) return undefined;
  if (from > to || to > text.length) return undefined;
  return [from, to];
}

/**
 * Offset of an LSP position in `text`.
 *
 * Lines are split on `\n`, and a `\r` is part of the line it ends, which is
 * how the protocol counts. A character past the end of a line clamps to the
 * line end rather than failing: clients legitimately name "end of line" that
 * way. A line the text does not have is `undefined`.
 */
export function offsetOf(text: string, position: Position): number | undefined {
  let offset = 0;
  let line = 0;
  while (line < position.line) {
    const index = text.indexOf("\n", offset);
    if (index < 0) return undefined;
    offset = index + 1;
    line += 1;
  }
  const lineEnd = text.indexOf("\n", offset);
  const stop = lineEnd < 0 ? text.length : lineEnd;
  return Math.min(offset + position.character, stop);
}
