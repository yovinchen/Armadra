import { createHash } from "node:crypto";
import { canonicalDirectory, resolveInRoot } from "../../workspaces/roots";
import { validPathspecs } from "../context";
import { repositories } from "../discovery";
import {
  badRequest,
  decodeCursor,
  encodeCursor,
  hasControlCharacter,
  logCursorRefused,
  malformed,
  notFound,
  sha256Hex,
  validOid,
} from "../support";
import { splitNul } from "./parse";
import { RepositoryService, commandError } from "./service";
import type { CommitRecord, LogCommit, LogPage, LogRequest } from "./types";

/**
 * The workspace-wide commit log.
 *
 * A port of `apps/runtime/src/git/repository/log.rs`. A workspace is not one
 * repository, and the Git window does not switch between them: it draws **one**
 * graph in which every discovered repository's commits are interleaved by
 * committer time, each row carrying the checkout it came from.
 *
 * Paging is per repository — an `(anchorOid, offset)` pair each — because the
 * merged sequence has no single offset: repository *B* may have contributed
 * nothing to page one. The pairs travel inside the cursor together with a hash
 * of the filters, and a cursor whose filters no longer match is refused rather
 * than answered: `--skip` counts commits that passed the filter, so continuing
 * under a different one would skip a set nobody has seen.
 */

const MAX_LOG_REPOSITORIES = 32;
const MAX_LOG_PAGE = 200;
const MAX_FILTER_VALUES = 64;

interface SelectedRepository {
  readonly path: string;
  readonly color: number;
  readonly directory: string;
}

interface LoggedCommit {
  readonly record: CommitRecord;
  /**
   * `%ct` — seconds since the epoch — rather than the published `%cI` string,
   * because two repositories in one workspace can carry different committer
   * timezones and comparing those strings would order by their text.
   */
  readonly committedAt: number;
}

interface RepositoryPage {
  readonly path: string;
  readonly commits: LoggedCommit[];
  readonly more: boolean;
  readonly offset: number;
  readonly anchorOid: string | null;
}

interface LogAnchor {
  path: string;
  anchorOid: string | null;
  offset: number;
}

interface LogCursor {
  version: number;
  filter: string;
  repositories: LogAnchor[];
}

interface LogArguments {
  readonly options: string[];
  readonly revisions: string[];
  readonly paths: string[];
}

export async function log(
  service: RepositoryService,
  workspaceRoot: string,
  discoveryKey: string,
  request: LogRequest,
): Promise<LogPage> {
  if (request.limit === 0 || request.limit > MAX_LOG_PAGE) {
    throw badRequest("Log page size must be 1–200");
  }
  const root = canonicalDirectory(workspaceRoot);
  const selection = await selectRepositories(
    root,
    discoveryKey,
    request.repositories,
  );
  const filter = filterIdentity(request, selection.repositories);
  const anchors = decodeLogCursor(
    request.cursor,
    filter,
    selection.repositories,
  );
  const args = logArguments(request);

  const pages: RepositoryPage[] = [];
  for (const repository of selection.repositories) {
    const anchor = anchors?.find((entry) => entry.path === repository.path);
    pages.push(
      await repositoryPage(service, repository, args, anchor, request.limit),
    );
  }
  const { commits, taken } = merge(pages, request.limit);
  // There is a next page when any repository still has rows the merge did not
  // reach — either rows it left in this page or rows Git did not send.
  const more = pages.some(
    (page, index) =>
      page.more || (taken[index] as number) < page.commits.length,
  );
  return {
    commits,
    nextCursor: more
      ? encodeCursor({
          version: 1,
          filter,
          repositories: pages.map((page, index) => ({
            path: page.path,
            anchorOid: page.anchorOid,
            offset: page.offset + (taken[index] as number),
          })),
        } satisfies LogCursor)
      : null,
    repositories: selection.repositories.map((repository) => ({
      path: repository.path,
      color: repository.color,
    })),
    truncated: selection.truncated,
  };
}

async function repositoryPage(
  service: RepositoryService,
  repository: SelectedRepository,
  args: LogArguments,
  anchor: LogAnchor | undefined,
  limit: number,
): Promise<RepositoryPage> {
  const offset = anchor?.offset ?? 0;
  // A continuation re-reads the repository's newest matching commit and
  // compares it with the one the first page saw. `--skip` counts from the top,
  // so a commit that landed since would shift every later page by one; the
  // honest answer is to refuse the cursor and let the reader start again.
  if (anchor !== undefined) {
    const head = await logCommits(service, repository.directory, args, 0, 1);
    const current = head[0]?.record.oid ?? null;
    if (current !== anchor.anchorOid) throw logCursorRefused();
  }
  const all = await logCommits(
    service,
    repository.directory,
    args,
    offset,
    limit + 1,
  );
  const more = all.length > limit;
  const commits = all.slice(0, limit);
  return {
    path: repository.path,
    commits,
    more,
    offset,
    anchorOid: anchor?.anchorOid ?? commits[0]?.record.oid ?? null,
  };
}

async function logCommits(
  service: RepositoryService,
  directory: string,
  args: LogArguments,
  skip: number,
  take: number,
): Promise<LoggedCommit[]> {
  const command = [
    "log",
    "--no-show-signature",
    "--date-order",
    "--decorate=full",
    // A ref named in the filter is a workspace-wide name: most repositories
    // will not have it, and neither will an unborn `HEAD`. That is a repository
    // contributing nothing rather than a failed read, and this flag is what
    // says so — the alternative is matching Git's own error text, which is
    // translated on a localized machine.
    "--ignore-missing",
    "-z",
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%ct%x00%D%x00%s",
    `--skip=${skip}`,
    `--max-count=${take}`,
    ...args.options,
    // Everything after `--end-of-options` is a revision, everything after `--`
    // a pathspec; neither can become an option, whatever a filter says.
    "--end-of-options",
    ...args.revisions,
    "--",
    ...args.paths,
  ];
  const output = await service.output(
    directory,
    command,
    Math.min(service.commandTimeoutMs, 30_000),
  );
  if (output.status !== 0) throw commandError(output);
  return parseLog(output.stdout);
}

/**
 * The discovered repositories this read walks, with the colour index each row
 * is drawn with.
 *
 * Discovery is the single source of the list — the same walk, the same skip
 * list and the same ceilings the repository panel already uses — so a checkout
 * the panel does not show is not one the log can be pointed at either.
 */
async function selectRepositories(
  root: string,
  discoveryKey: string,
  requested: readonly string[] | null,
): Promise<{ repositories: SelectedRepository[]; truncated: boolean }> {
  const list = await repositories(discoveryKey, root, undefined, false);
  const wanted =
    requested === null
      ? undefined
      : requested.map((path) => normalizeRepositoryPath(path));
  if (wanted !== undefined && wanted.length > MAX_FILTER_VALUES) {
    throw badRequest("At most 64 repositories may be named");
  }
  const selected: SelectedRepository[] = [];
  list.repositories.forEach((record, color) => {
    if (wanted !== undefined && !wanted.includes(record.repositoryPath)) return;
    selected.push({
      path: record.repositoryPath,
      color,
      directory: resolveInRoot(root, record.repositoryPath),
    });
  });
  if (wanted !== undefined) {
    for (const path of wanted) {
      if (!selected.some((repository) => repository.path === path)) {
        throw notFound(
          `\`${path}\` is not a repository this workspace discovered`,
        );
      }
    }
  }
  const truncated = list.truncated || selected.length > MAX_LOG_REPOSITORIES;
  return {
    repositories: selected.slice(0, MAX_LOG_REPOSITORIES),
    truncated,
  };
}

export function normalizeRepositoryPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return ".";
  return trimmed.replace(/^\.\//, "");
}

function logArguments(request: LogRequest): LogArguments {
  if (
    request.authors.length > MAX_FILTER_VALUES ||
    request.refs.names.length > MAX_FILTER_VALUES
  ) {
    throw badRequest("At most 64 authors or refs may be named");
  }
  const options: string[] = [];
  const revisions: string[] = [];
  if (request.refs.kind === "head") {
    revisions.push("HEAD");
  } else if (request.refs.kind === "all") {
    // Not `--all`: that also walks `refs/stash`, and a stash's two synthetic
    // commits are not history anybody asked to see.
    options.push("HEAD", "--branches", "--remotes", "--tags");
  } else {
    if (request.refs.names.length === 0) {
      throw badRequest("A named ref filter must name at least one ref");
    }
    for (const name of request.refs.names) {
      revisions.push(validLogReference(name));
    }
  }
  for (const author of request.authors) {
    options.push(`--author=${validFilterValue(author, "author")}`);
  }
  if (request.since !== null) {
    options.push(`--since=${validFilterValue(request.since, "date")}`);
  }
  if (request.until !== null) {
    options.push(`--until=${validFilterValue(request.until, "date")}`);
  }
  if (request.text !== null && request.text.query.trim() !== "") {
    const query = validFilterValue(request.text.query, "search");
    if (request.text.regex) {
      // Compiled here as well as by Git, so a pattern that cannot compile is a
      // named refusal rather than a non-zero exit read as "no rows".
      try {
        new RegExp(query);
      } catch {
        throw badRequest("The search pattern is not valid");
      }
      options.push("--extended-regexp");
    } else {
      options.push("--fixed-strings");
    }
    if (!request.text.matchCase) options.push("--regexp-ignore-case");
    options.push(`--grep=${query}`);
  }
  return { options, revisions, paths: validPathspecs(request.paths) };
}

/**
 * A filter value travels inside `--author=…`, so it can never be read as an
 * option; what is checked here is that it is text at all.
 */
function validFilterValue(value: string, kind: string): string {
  if (value === "" || value.length > 512 || hasControlCharacter(value)) {
    throw badRequest(
      `The ${kind} filter is empty, too long, or contains control characters`,
    );
  }
  return value;
}

/**
 * A ref named in a filter, checked without running Git: the same name is
 * offered to every repository in the workspace, most of which will not have it,
 * so absence is a normal answer and only the shape is checked.
 */
function validLogReference(raw: string): string {
  const name = raw.trim();
  if (
    name === "" ||
    name.length > 1024 ||
    name.startsWith("-") ||
    name.includes("@{") ||
    name.includes("..") ||
    /\s/.test(name) ||
    hasControlCharacter(name)
  ) {
    throw badRequest("A named ref is invalid");
  }
  return name;
}

/**
 * The filters a cursor is bound to, hashed.
 *
 * The page size is deliberately absent: offsets are absolute counts, so a
 * reader may change how many rows it asks for without invalidating a window it
 * already has.
 */
function filterIdentity(
  request: LogRequest,
  selected: readonly SelectedRepository[],
): string {
  const hasher = createHash("sha256");
  hasher.update("armadra.git.log.v1");
  for (const repository of selected) {
    hasher.update(Buffer.from([0]));
    hasher.update(repository.path);
  }
  hasher.update(Buffer.from([1]));
  hasher.update(request.refs.kind);
  for (const name of request.refs.names) {
    hasher.update(Buffer.from([0]));
    hasher.update(name);
  }
  hasher.update(Buffer.from([2]));
  for (const author of request.authors) {
    hasher.update(Buffer.from([0]));
    hasher.update(author);
  }
  hasher.update(Buffer.from([3]));
  hasher.update(request.since ?? "");
  hasher.update(Buffer.from([4]));
  hasher.update(request.until ?? "");
  hasher.update(Buffer.from([5]));
  for (const path of request.paths) {
    hasher.update(Buffer.from([0]));
    hasher.update(path);
  }
  hasher.update(Buffer.from([6]));
  if (request.text !== null) {
    hasher.update(request.text.query);
    hasher.update(
      Buffer.from([request.text.regex ? 1 : 0, request.text.matchCase ? 1 : 0]),
    );
  }
  return hasher.digest("hex");
}

function decodeLogCursor(
  cursor: string | null,
  filter: string,
  selected: readonly SelectedRepository[],
): LogAnchor[] | undefined {
  if (cursor === null || cursor === "") return undefined;
  if (cursor.length > 16_384) throw logCursorRefused();
  const decoded = decodeCursor<LogCursor>(cursor, logCursorRefused);
  if (decoded.version !== 1 || decoded.filter !== filter) {
    throw logCursorRefused();
  }
  if (decoded.repositories.length !== selected.length) {
    throw logCursorRefused();
  }
  for (const anchor of decoded.repositories) {
    if (
      anchor.offset > 1_000_000 ||
      (anchor.anchorOid !== null && !validOid(anchor.anchorOid)) ||
      !selected.some((repository) => repository.path === anchor.path)
    ) {
      throw logCursorRefused();
    }
  }
  return decoded.repositories;
}

/**
 * Merge the repositories' pages by committer time, descending.
 *
 * A tie keeps the repository already chosen, which is the earlier position in
 * the discovery list: two checkouts committing inside the same second is common
 * in a monorepo, and "whichever process answered first" is not an order a
 * reader can page through.
 */
function merge(
  pages: readonly RepositoryPage[],
  limit: number,
): { commits: LogCommit[]; taken: number[] } {
  const taken = pages.map(() => 0);
  const commits: LogCommit[] = [];
  while (commits.length < limit) {
    let best: number | undefined;
    pages.forEach((page, index) => {
      const candidate = page.commits[taken[index] as number];
      if (candidate === undefined) return;
      if (best === undefined) {
        best = index;
        return;
      }
      const current = (pages[best] as RepositoryPage).commits[
        taken[best] as number
      ] as LoggedCommit;
      if (candidate.committedAt > current.committedAt) best = index;
    });
    if (best === undefined) break;
    const page = pages[best] as RepositoryPage;
    const entry = page.commits[taken[best] as number] as LoggedCommit;
    commits.push({ ...entry.record, repositoryPath: page.path });
    taken[best] = (taken[best] as number) + 1;
  }
  return { commits, taken };
}

/** `git log -z --decorate=full --format=…`: nine fields per record. */
function parseLog(bytes: Buffer): LoggedCommit[] {
  if (bytes.length === 0) return [];
  const fields = splitNul(bytes);
  if (fields.length % 9 !== 0) throw malformed();
  const commits: LoggedCommit[] = [];
  for (let index = 0; index < fields.length; index += 9) {
    const row = fields
      .slice(index, index + 9)
      .map((value) => value.toString("utf8"));
    const oid = row[0] as string;
    const parents = (row[1] as string).split(/\s+/).filter((v) => v !== "");
    if (!validOid(oid) || parents.some((parent) => !validOid(parent))) {
      throw malformed();
    }
    const committedAt = Number.parseInt(row[6] as string, 10);
    if (Number.isNaN(committedAt)) throw malformed();
    commits.push({
      committedAt,
      record: {
        oid,
        parents,
        subject: row[8] as string,
        authorName: row[2] as string,
        authorEmail: row[3] as string,
        authorTime: row[4] as string,
        committerTime: row[5] as string,
        refs: parseDecoration(row[7] as string),
      },
    });
  }
  return commits;
}

/**
 * `%D` under `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1`.
 *
 * Only full ref names survive, so the list has the same shape the
 * `for-each-ref` path produces. A detached `HEAD` decorates as the bare word
 * and is dropped: it is not a ref name, and a client that resolved it would be
 * resolving a different commit on every checkout.
 */
function parseDecoration(value: string): string[] {
  return value
    .split(", ")
    .map((entry) => entry.trim())
    .map((entry) => {
      const arrow = entry.lastIndexOf(" -> ");
      return arrow < 0 ? entry : entry.slice(arrow + 4);
    })
    .map((entry) =>
      entry.startsWith("tag: ") ? entry.slice("tag: ".length) : entry,
    )
    .filter((entry) => entry.startsWith("refs/"));
}

export { sha256Hex };
