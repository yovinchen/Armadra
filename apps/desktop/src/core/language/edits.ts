/**
 * Applying a `WorkspaceEdit` (design §2.6, §2.3).
 *
 * A rename that touches nine files is nine saves, and the editor's existing
 * protection — every save carries the SHA-256 of what the caller read — is not
 * weakened just because a language server proposed them. So:
 *
 *  * Every path must resolve **inside** the workspace root. An external uri
 *    blocks the whole edit rather than being skipped, because an edit that
 *    silently does less than it showed is worse than one that does nothing.
 *  * Every file carries an expected version. A path absent from the map must
 *    not already exist.
 *  * An open document must be **clean**. Applying over an unsaved draft would
 *    destroy work the editor is still holding.
 *  * Writing stops at the first failure and both lists come back, so the
 *    dialog can say exactly which files changed.
 *
 * Each successful write publishes `file.changed`, which is what makes the open
 * (and clean) editors reload themselves — the same path an external change
 * already takes.
 */

import { DomainError, badRequest } from "../workspaces/support";
import {
  isClean,
  offsetOf,
  parsePosition,
  type Documents,
  type Position,
} from "./documents";
import { readTextFile, writeTextFile } from "./files";
import type { JsonObject, JsonValue } from "./jsonrpc";
import { Rewriter } from "./uri";

/**
 * Bounds from design §2.2 `edits`. A "refactor" past these is not something to
 * apply without the user having seen it file by file.
 */
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface AppliedFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface FailedFile {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ApplyResult {
  readonly applied: AppliedFile[];
  readonly failed: FailedFile[];
}

export interface TextEdit {
  readonly start: Position;
  readonly end: Position;
  readonly text: string;
}

/** One file's edits, already resolved to a workspace-relative path. */
export interface FileEdits {
  readonly path: string;
  readonly edits: readonly TextEdit[];
}

/** What a write announces, so the caller can publish `file.changed`. */
export type ChangeSink = (file: AppliedFile) => void;

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : undefined;
}

/**
 * Reads a `WorkspaceEdit` whose uris the browser already saw.
 *
 * `documentChanges` wins over `changes` when both are present, which is what
 * the spec says; a create, rename or delete operation is refused outright —
 * the first version applies text edits and nothing else, and pretending
 * otherwise would silently drop half a refactor.
 */
export function parseEdit(
  edit: JsonValue | undefined,
  rewriter: Rewriter,
): FileEdits[] {
  const object = asObject(edit) ?? {};
  const files: FileEdits[] = [];
  const documentChanges = object["documentChanges"];
  const changes = asObject(object["changes"]);
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      const entry = asObject(change) ?? {};
      if (entry["kind"] !== undefined) {
        throw badRequest(
          "This edit creates, renames or deletes files, which is not applied",
        );
      }
      const uri = asObject(entry["textDocument"])?.["uri"];
      files.push({
        path: relative(typeof uri === "string" ? uri : "", rewriter),
        edits: textEdits(entry["edits"]),
      });
    }
  } else if (changes !== undefined) {
    for (const [uri, edits] of Object.entries(changes)) {
      files.push({ path: relative(uri, rewriter), edits: textEdits(edits) });
    }
    // A map has no order of its own; sorting makes the applied list, and
    // therefore the failure point, reproducible.
    files.sort((left, right) => (left.path < right.path ? -1 : 1));
  }
  if (files.length === 0) throw badRequest("This edit changes nothing");
  if (files.length > MAX_FILES) {
    throw badRequest(`This edit touches more than ${MAX_FILES} files`);
  }
  return files;
}

function relative(uri: string, rewriter: Rewriter): string {
  if (Rewriter.isExternal(uri)) {
    throw badRequest("This edit reaches a file outside the workspace");
  }
  const path = rewriter.relativeOf(uri);
  if (path === undefined) {
    throw badRequest(
      "This edit names a location the workspace does not contain",
    );
  }
  return path;
}

function textEdits(value: JsonValue | undefined): TextEdit[] {
  if (!Array.isArray(value)) return [];
  const out: TextEdit[] = [];
  for (const entry of value) {
    const edit = asObject(entry);
    if (edit === undefined) continue;
    const range = asObject(edit["range"]);
    if (range === undefined) continue;
    const start = parsePosition(range["start"]);
    const end = parsePosition(range["end"]);
    const text = edit["newText"];
    if (start === undefined || end === undefined || typeof text !== "string") {
      continue;
    }
    out.push({ start, end, text });
  }
  return out;
}

/**
 * Applies text edits to one file's text.
 *
 * Edits are applied last-first so an earlier edit's offsets stay valid: the
 * LSP spec says edits in one file must not overlap and are computed against
 * the same original document, which is exactly what reverse order preserves.
 */
export function applyToText(
  original: string,
  edits: readonly TextEdit[],
): string | undefined {
  const ordered = [...edits].sort((left, right) =>
    right.start.line === left.start.line
      ? right.start.character - left.start.character
      : right.start.line - left.start.line,
  );
  let text = original;
  for (const edit of ordered) {
    const from = offsetOf(text, edit.start);
    const to = offsetOf(text, edit.end);
    if (from === undefined || to === undefined) return undefined;
    if (from > to || to > text.length) return undefined;
    text = text.slice(0, from) + edit.text + text.slice(to);
  }
  return text;
}

/**
 * The versions a **server-initiated** edit is written against.
 *
 * A client-driven apply carries the digests the user previewed; a server's
 * `workspace/applyEdit` carries none, because nobody previewed anything. So
 * they are read here, immediately before the write, and every file has to
 * produce one: a file the core cannot version is a file it would have to write
 * blind, and the whole edit is refused rather than half of it applied.
 */
export function currentVersions(
  root: string,
  files: readonly FileEdits[],
): Record<string, string> | FailedFile {
  const versions: Record<string, string> = {};
  for (const file of files) {
    let current;
    try {
      current = readTextFile(root, file.path);
    } catch (error) {
      return {
        path: file.path,
        code: "not_readable",
        message: describe(error),
      };
    }
    if (current.sha256 === undefined) {
      return {
        path: file.path,
        code: "no_version",
        message:
          "This file has no content version, so it cannot be written safely",
      };
    }
    versions[file.path] = current.sha256;
  }
  return versions;
}

/**
 * The files an edit touches that have unsaved changes in an open editor.
 *
 * Returned rather than silently skipped: the dialog lists them and asks the
 * user to save first, which is a decision only the user can make.
 */
export function dirtyFiles(
  files: readonly FileEdits[],
  documents: Documents,
  rewriter: Rewriter,
): string[] {
  return files
    .filter((file) => {
      const document = documents.get(rewriter.workspaceUri(file.path));
      return document !== undefined && !isClean(document);
    })
    .map((file) => file.path);
}

/**
 * Writes every file, in order, stopping at the first failure.
 *
 * The read-modify-write is deliberately not atomic across files: no filesystem
 * offers that, and pretending otherwise by rolling back would mean writing
 * every file twice. Instead the caller is told exactly how far it got.
 */
export function applyEdits(
  root: string,
  files: readonly FileEdits[],
  expected: Readonly<Record<string, string>>,
  changed: ChangeSink,
): ApplyResult {
  const result: ApplyResult = { applied: [], failed: [] };
  for (const file of files) {
    const version = expected[file.path];
    let current;
    try {
      current = readTextFile(root, file.path);
    } catch (error) {
      result.failed.push({
        path: file.path,
        code: "not_readable",
        message: describe(error),
      });
      break;
    }
    // The version the caller previewed against, checked before the edit is
    // computed rather than only at the write: an edit applied to text that has
    // since changed produces garbage, not a conflict.
    if (version !== undefined && version !== current.sha256) {
      result.failed.push({
        path: file.path,
        code: "conflict",
        message: "The file changed since the preview was computed",
      });
      break;
    }
    const text = applyToText(current.content, file.edits);
    if (text === undefined) {
      result.failed.push({
        path: file.path,
        code: "invalid_range",
        message: "The edit names a range the file does not have",
      });
      break;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      result.failed.push({
        path: file.path,
        code: "too_large",
        message: "The edited file is larger than the write limit",
      });
      break;
    }
    try {
      const written = writeTextFile(
        root,
        file.path,
        text,
        version,
        current.bom,
      );
      const applied: AppliedFile = {
        path: written.path,
        sha256: written.sha256,
        size: written.size,
      };
      changed(applied);
      result.applied.push(applied);
    } catch (error) {
      result.failed.push({
        path: file.path,
        code: failureCode(error),
        message: describe(error),
      });
      break;
    }
  }
  return result;
}

function failureCode(error: unknown): string {
  if (error instanceof DomainError) {
    if (error.status === 409) return "conflict";
    if (error.status === 403) return "forbidden";
  }
  return "write_failed";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
