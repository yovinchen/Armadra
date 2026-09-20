import { malformed, validOid } from "../support";
import type { CommitRecord, WorktreeRecord } from "./types";

/**
 * Parsers for the machine-readable Git output the repository service reads.
 *
 * A port of the pre-merge implementation. The two record
 * splitters are separate on purpose: `for-each-ref` ends a record with a
 * newline, `git log -z` with a NUL, and reading one with the other's rule turns
 * a subject containing a newline — which a reflog message may — into a
 * malformed record.
 */

/** `for-each-ref` output: `width` NUL-terminated fields, then a newline. */
export function fieldsWithLf(bytes: Buffer, width: number): string[][] {
  const records: string[][] = [];
  let rest = bytes;
  while (rest.length > 0) {
    const fields: string[] = [];
    for (let index = 0; index < width; index += 1) {
      const end = rest.indexOf(0);
      if (end < 0) throw malformed();
      fields.push(rest.subarray(0, end).toString("utf8"));
      rest = rest.subarray(end + 1);
    }
    if (rest[0] !== 0x0a) throw malformed();
    rest = rest.subarray(1);
    records.push(fields);
  }
  return records;
}

/** `git log -z --format=…%x00…`: one flat NUL-separated list. */
export function fieldsWithNul(bytes: Buffer, width: number): string[][] {
  if (bytes.length === 0) return [];
  const fields = splitNul(bytes);
  if (width === 0 || fields.length % width !== 0) throw malformed();
  const records: string[][] = [];
  for (let index = 0; index < fields.length; index += width) {
    records.push(
      fields.slice(index, index + width).map((value) => value.toString("utf8")),
    );
  }
  return records;
}

/** NUL-split with the empty trailing field Git leaves behind dropped. */
export function splitNul(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      fields.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.length) fields.push(bytes.subarray(start));
  return fields;
}

/** `%(upstream:track,nobracket)` → `(ahead, behind, gone)`. */
export function parseTracking(
  track: string,
): [number | null, number | null, boolean] {
  if (track === "gone") return [null, null, true];
  let ahead = 0;
  let behind = 0;
  for (const part of track.split(", ").filter((value) => value !== "")) {
    const space = part.indexOf(" ");
    if (space < 0) throw malformed();
    const direction = part.slice(0, space);
    const count = Number.parseInt(part.slice(space + 1), 10);
    if (Number.isNaN(count)) throw malformed();
    if (direction === "ahead") ahead = count;
    else if (direction === "behind") behind = count;
    else throw malformed();
  }
  return [ahead, behind, false];
}

/** The seven-field `git log` record the history page and previews read. */
export function parseHistory(
  bytes: Buffer,
  refs: Map<string, string[]>,
): CommitRecord[] {
  if (bytes.length === 0) return [];
  const fields = splitNul(bytes);
  if (fields.length % 7 !== 0) throw malformed();
  const records: CommitRecord[] = [];
  for (let index = 0; index < fields.length; index += 7) {
    const row = fields
      .slice(index, index + 7)
      .map((value) => value.toString("utf8"));
    const oid = row[0] as string;
    const parents = (row[1] as string).split(/\s+/).filter((v) => v !== "");
    if (!validOid(oid) || parents.some((parent) => !validOid(parent))) {
      throw malformed();
    }
    records.push({
      oid,
      parents,
      subject: row[6] as string,
      authorName: row[2] as string,
      authorEmail: row[3] as string,
      authorTime: row[4] as string,
      committerTime: row[5] as string,
      refs: refs.get(oid) ?? [],
    });
  }
  return records;
}

/** `git worktree list --porcelain -z`. */
export function parseWorktrees(bytes: Buffer): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const field of splitNulKeepEmpty(bytes)) {
    const line = field.toString("utf8");
    if (line === "") {
      if (current !== undefined) {
        records.push(current);
        current = undefined;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current !== undefined) throw malformed();
      current = {
        path: line.slice("worktree ".length),
        headOid: null,
        branch: null,
        detached: false,
        bare: false,
        isMain: records.length === 0,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        accessible: false,
        dirty: null,
      };
      continue;
    }
    if (current === undefined) throw malformed();
    if (line.startsWith("HEAD ")) {
      const oid = line.slice("HEAD ".length);
      if (!validOid(oid)) throw malformed();
      current.headOid = /^0+$/.test(oid) ? null : oid;
    } else if (line.startsWith("branch ")) {
      const branch = line.slice("branch ".length);
      current.branch = branch.startsWith("refs/heads/")
        ? branch.slice("refs/heads/".length)
        : branch;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.startsWith("locked ")
        ? line.slice("locked ".length)
        : null;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
      current.pruneReason = line.startsWith("prunable ")
        ? line.slice("prunable ".length)
        : null;
    } else {
      throw malformed();
    }
  }
  if (current !== undefined) records.push(current);
  return records;
}

function splitNulKeepEmpty(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      fields.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  fields.push(bytes.subarray(start));
  return fields;
}

/**
 * `--numstat -z` → `additions \t deletions \t path \0`. Binary files report `-`
 * for both counts, which becomes `null` rather than a misleading zero.
 */
export function parseNumstat(
  output: string,
): Map<string, [number | null, number | null]> {
  const counts = new Map<string, [number | null, number | null]>();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] as string;
    // `diff-tree -z` leads with the commit's own object ID in a field of its
    // own; `diff` does not. Dropping a bare OID handles both.
    if (entry.trim() === "" || validOid(entry)) continue;
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = Number.parseInt(entry.slice(0, firstTab), 10);
    const deletions = Number.parseInt(entry.slice(firstTab + 1, secondTab), 10);
    let path = entry.slice(secondTab + 1);
    if (path === "") {
      // Rename: the two paths follow as separate NUL fields.
      index += 2;
      const destination = fields[index];
      if (destination === undefined) continue;
      path = destination;
    }
    counts.set(path, [
      Number.isNaN(additions) ? null : additions,
      Number.isNaN(deletions) ? null : deletions,
    ]);
  }
  return counts;
}

/**
 * `--name-status -z` → `<code> \0 <path> \0`, with renames emitting
 * `R100 \0 <old> \0 <new> \0`.
 */
export function parseNameStatus(
  output: string,
  normalize: (code: string) => string,
): [string, string][] {
  const entries: [string, string][] = [];
  const fields = output.split("\0").filter((field) => field !== "");
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index] as string;
    // A status code is never 40 hex characters, so skipping a bare OID is
    // unambiguous — and reading it as a code would desynchronize every pair.
    if (validOid(code)) continue;
    const renamed = code.startsWith("R") || code.startsWith("C");
    index += 1;
    let path = fields[index];
    if (path === undefined) throw malformed();
    if (renamed) {
      index += 1;
      path = fields[index];
      if (path === undefined) throw malformed();
    }
    entries.push([normalize(code), path.replace(/\\/g, "/")]);
  }
  return entries;
}
