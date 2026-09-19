import { validPathspecs } from "../context";
import {
  badRequest,
  cursorRefused,
  decodeCursor,
  encodeCursor,
  oneLine,
  validOid,
} from "../support";
import { fieldsWithNul, parseHistory } from "./parse";
import { MAX_HISTORY_PAGE, RepositoryService, repositoryId } from "./service";
import type {
  HistoryPage,
  HistoryRequest,
  ReflogPage,
  ReflogRequest,
} from "./types";

/**
 * Paged commit history for the graph view, and the reference log beside it.
 *
 * Ports `history.rs` and `reflog.rs`. The two page the same way and refuse a
 * cursor the same way, but they are paging over different things and the
 * difference is the interesting part:
 *
 *   * A **history** page is anchored: the cursor carries the object id the
 *     first page resolved, so later pages walk the same immutable commit even
 *     after the ref moves. The pathspec filter is part of the cursor's
 *     identity, because `--skip` counts commits that passed the filter.
 *   * A **reflog** page has no such anchor — the log is prepended to — so the
 *     cursor is a plain offset and every entry carries its own `loggedAt`,
 *     which is what lets a reader see that the window slid.
 */

const MAX_REFLOG_PAGE = 200;

interface HistoryCursor {
  version: number;
  repositoryId: string;
  reference: string;
  anchorOid: string;
  offset: number;
  paths: string[];
}

export async function history(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  request: HistoryRequest,
): Promise<HistoryPage> {
  if (request.limit === 0 || request.limit > MAX_HISTORY_PAGE) {
    throw badRequest("History page size must be 1–200");
  }
  const context = await service.context(workspaceRoot, requested);
  await service.validateReference(context.repository, request.reference);
  const paths = validPathspecs(request.paths);

  let anchor: string | null;
  let offset: number;
  if (request.cursor !== null && request.cursor !== undefined) {
    if (request.cursor.length > 4096) throw cursorRefused();
    const cursor = decodeCursor<HistoryCursor>(request.cursor, cursorRefused);
    if (
      cursor.version !== 1 ||
      cursor.repositoryId !== repositoryId(context) ||
      cursor.reference !== request.reference ||
      !sameList(cursor.paths ?? [], paths) ||
      !validOid(cursor.anchorOid) ||
      cursor.offset > 1_000_000
    ) {
      throw cursorRefused();
    }
    // Resolve the immutable anchor, not the ref's new value.
    anchor = await service.resolve(context.repository, cursor.anchorOid);
    offset = cursor.offset;
  } else if (request.reference === "HEAD") {
    anchor = (await service.head(context.repository)).headOid;
    offset = 0;
  } else {
    anchor = await service.resolve(context.repository, request.reference);
    offset = 0;
  }

  const shallow =
    oneLine(
      await service.read(context.repository, [
        "rev-parse",
        "--is-shallow-repository",
      ]),
    ) === "true";
  if (anchor === null) {
    return {
      reference: request.reference,
      anchorOid: null,
      commits: [],
      nextCursor: null,
      shallow,
    };
  }
  const output = await service.read(context.repository, [
    "log",
    "--topo-order",
    "--no-show-signature",
    "--no-decorate",
    "-z",
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s",
    `--skip=${offset}`,
    `--max-count=${request.limit + 1}`,
    anchor,
    // Everything after `--` is a pathspec, so a filter can only ever narrow
    // the log; it can never become an option.
    "--",
    ...paths,
  ]);
  const refs = await service.commitRefs(context.repository);
  const all = parseHistory(output, refs);
  const more = all.length > request.limit;
  const commits = all.slice(0, request.limit);
  return {
    reference: request.reference,
    anchorOid: anchor,
    commits,
    nextCursor: more
      ? encodeCursor({
          version: 1,
          repositoryId: repositoryId(context),
          reference: request.reference,
          anchorOid: anchor,
          offset: offset + commits.length,
          paths,
        } satisfies HistoryCursor)
      : null,
    shallow,
  };
}

interface ReflogCursor {
  version: number;
  repositoryId: string;
  reference: string;
  offset: number;
}

/**
 * Splits `checkout: moving from a to b` into its verb and the rest. A subject
 * without a colon is all message and no verb, which is what Git writes for a
 * few of its own entries; inventing one would make the panel group by a word
 * that is not there.
 */
export function splitSubject(subject: string): [string, string] {
  const colon = subject.indexOf(":");
  if (colon < 0) return ["", subject];
  const action = subject.slice(0, colon);
  const rest = subject.slice(colon + 1).replace(/^\s+/, "");
  if (action !== "" && !action.includes(" ")) return [action, rest];
  // `commit (initial): one` keeps its parenthesised qualifier in the message
  // and its verb in `action`.
  const space = action.indexOf(" ");
  if (space < 0) return [action, rest];
  return [action.slice(0, space), `${action.slice(space + 1)} ${rest}`.trim()];
}

/** `HEAD@{2026-09-06T12:00:00+08:00}` → the timestamp inside the braces. */
export function selectorTime(selector: string): string {
  const open = selector.indexOf("{");
  if (open < 0 || !selector.endsWith("}")) return "";
  return selector.slice(open + 1, -1);
}

export async function reflog(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
  request: ReflogRequest,
): Promise<ReflogPage> {
  if (request.limit === 0 || request.limit > MAX_REFLOG_PAGE) {
    throw badRequest("Reflog page size must be 1–200");
  }
  const context = await service.context(workspaceRoot, requested);
  // An object id has no reflog: only a ref does. Accepting one would answer an
  // empty page for a request that can never have an answer.
  if (validOid(request.reference)) {
    throw badRequest("A reflog is read for a reference, not for a commit");
  }
  await service.validateReference(context.repository, request.reference);
  let offset = 0;
  if (request.cursor !== null && request.cursor !== undefined) {
    if (request.cursor.length > 4096) throw cursorRefused();
    const cursor = decodeCursor<ReflogCursor>(request.cursor, cursorRefused);
    if (
      cursor.version !== 1 ||
      cursor.repositoryId !== repositoryId(context) ||
      cursor.reference !== request.reference ||
      cursor.offset > 1_000_000
    ) {
      throw cursorRefused();
    }
    offset = cursor.offset;
  }
  // One extra row is read for two reasons at once: it says whether there is
  // another page, and it supplies the `previousOid` of the last entry shown.
  let output: Buffer;
  try {
    output = await service.read(context.repository, [
      "log",
      "-g",
      "--no-show-signature",
      "--no-decorate",
      "--date=iso-strict",
      "-z",
      "--format=%H%x00%gD%x00%gs%x00%gn%x00%ge",
      `--skip=${offset}`,
      `--max-count=${request.limit + 1}`,
      request.reference,
      "--",
    ]);
  } catch {
    // A ref that exists but has never been written to has no reflog file, and
    // Git exits non-zero for it. That is an empty log, not a failure.
    output = Buffer.alloc(0);
  }
  const rows = fieldsWithNul(output, 5);
  const entries = rows.slice(0, request.limit).map((row, position) => ({
    index: offset + position,
    selector: `${request.reference}@{${offset + position}}`,
    oid: row[0] as string,
    previousOid: (rows[position + 1]?.[0] as string | undefined) ?? null,
    ...splitFields(row[2] as string),
    committerName: row[3] as string,
    committerEmail: row[4] as string,
    loggedAt: selectorTime(row[1] as string),
  }));
  return {
    reference: request.reference,
    entries,
    nextCursor:
      rows.length > request.limit
        ? encodeCursor({
            version: 1,
            repositoryId: repositoryId(context),
            reference: request.reference,
            offset: offset + entries.length,
          } satisfies ReflogCursor)
        : null,
  };
}

function splitFields(subject: string): { action: string; message: string } {
  const [action, message] = splitSubject(subject);
  return { action, message };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
