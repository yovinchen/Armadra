import {
  badRequest,
  malformed,
  nonempty,
  nowRfc3339,
  validOid,
} from "../support";
import { fieldsWithLf, parseTracking } from "./parse";
import { RepositoryService, repositoryId } from "./service";
import type {
  BranchRecord,
  BranchSnapshot,
  IdentityRecord,
  RemoteRecord,
  TagRecord,
  TagSnapshot,
} from "./types";
import { sanitizeRepository } from "../support";

/**
 * The three ref namespaces one checkout answers about: branches, tags and
 * remotes, plus the identity a commit from it would carry.
 *
 * Ports `branches.rs`, `refs.rs` and `identity.rs`. They share a file because
 * all four reads are one `for-each-ref` or one `git config` and nothing else,
 * and because every one of them is shaped by the same decision: an absent
 * value is `null`, never zero and never an error. A branch without an upstream
 * reports `null` ahead/behind because "nothing to push" and "nowhere to push"
 * are different answers, and a machine with no `user.email` is a normal machine
 * that has simply not committed yet.
 */

const MAX_TAGS = 5_000;
const MAX_REMOTES = 256;

export async function branches(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
): Promise<BranchSnapshot> {
  const context = await service.context(workspaceRoot, requested);
  const head = await service.head(context.repository);
  const output = await service.read(context.repository, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)%00",
    "refs/heads/",
    "refs/remotes/",
  ]);
  const records: BranchRecord[] = [];
  for (const record of fieldsWithLf(output, 5)) {
    const fullRef = record[0] as string;
    const remote = fullRef.startsWith("refs/remotes/");
    const prefix = remote ? "refs/remotes/" : "refs/heads/";
    if (!fullRef.startsWith(prefix)) throw malformed();
    const name = fullRef.slice(prefix.length);
    if (!validOid(record[1] as string)) throw malformed();
    const [ahead, behind, missing] = parseTracking(record[3] as string);
    const tracked = record[2] !== "";
    records.push({
      current: !remote && head.branch === name,
      name,
      fullRef,
      oid: record[1] as string,
      remote,
      upstream: nonempty(record[2] as string),
      ahead: tracked ? ahead : null,
      behind: tracked ? behind : null,
      upstreamMissing: missing,
      symbolicTarget: nonempty(record[4] as string),
    });
  }
  return {
    repositoryId: repositoryId(context),
    repositoryPath: context.repository,
    head,
    branches: records,
    remotes: await service.remotes(context.repository),
    observedAt: nowRfc3339(),
  };
}

const TAG_FORMAT =
  "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(taggername)%00%(taggerdate:iso-strict)%00%(contents:subject)%00";

export async function tags(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
): Promise<TagSnapshot> {
  const context = await service.context(workspaceRoot, requested);
  const head = await service.head(context.repository);
  const output = await service.read(context.repository, [
    "for-each-ref",
    "--sort=-creatordate",
    TAG_FORMAT,
    "refs/tags/",
  ]);
  const records = fieldsWithLf(output, 7);
  if (records.length > MAX_TAGS) {
    throw badRequest("This repository has more tags than this view supports");
  }
  return {
    repositoryId: repositoryId(context),
    repositoryPath: context.repository,
    head,
    tags: records.map((record) => tagFromRecord(record)),
    observedAt: nowRfc3339(),
  };
}

function tagFromRecord(record: string[]): TagRecord {
  const fullRef = record[0] as string;
  if (!fullRef.startsWith("refs/tags/")) throw malformed();
  const name = fullRef.slice("refs/tags/".length);
  // A lightweight tag has no dereferenced object, so the ref's own object is
  // already the commit.
  const targetOid =
    record[3] === "" ? (record[1] as string) : (record[3] as string);
  if (!validOid(record[1] as string) || !validOid(targetOid)) throw malformed();
  return {
    name,
    fullRef,
    oid: record[1] as string,
    targetOid,
    annotated: record[2] === "tag",
    subject: nonempty(record[6] as string),
    taggerName: nonempty(record[4] as string),
    taggerTime: nonempty(record[5] as string),
  };
}

/** One tag by name, or `undefined` when nothing holds that name. */
export async function tagRecord(
  service: RepositoryService,
  repository: string,
  name: string,
  signal?: AbortSignal,
): Promise<TagRecord | undefined> {
  await service.validateTagName(repository, name, signal);
  const output = await service.read(
    repository,
    ["for-each-ref", TAG_FORMAT, `refs/tags/${name}`],
    signal,
  );
  const records = fieldsWithLf(output, 7);
  const record = records[0];
  if (record === undefined) return undefined;
  if (records.length !== 1 || record[0] !== `refs/tags/${name}`) {
    throw malformed();
  }
  return { ...tagFromRecord(record), name };
}

/**
 * Remote URLs are redacted before they leave the service; Armadra stores none
 * of them, and a redacted value must not be sent back as an update.
 */
export async function remoteRecords(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
): Promise<RemoteRecord[]> {
  const context = await service.context(workspaceRoot, requested);
  const names = await service.remotes(context.repository);
  if (names.length > MAX_REMOTES) {
    throw badRequest(
      "This repository has more remotes than this view supports",
    );
  }
  const records: RemoteRecord[] = [];
  for (const name of names) {
    const fetch = (
      await service.read(context.repository, ["remote", "get-url", "--", name])
    )
      .toString("utf8")
      .replace(/\n$/, "");
    const push = (
      await service.read(context.repository, [
        "remote",
        "get-url",
        "--push",
        "--",
        name,
      ])
    )
      .toString("utf8")
      .replace(/\n$/, "");
    const fetchUrl = sanitizeRepository(fetch);
    const pushUrl = sanitizeRepository(push);
    records.push({
      name,
      fetchUrl,
      pushUrl,
      redacted: fetchUrl !== fetch || pushUrl !== push,
    });
  }
  return records;
}

/**
 * `git config user.name` / `user.email` for one checkout.
 *
 * A plain config read, so it needs no execution grant: nothing about it runs a
 * repository filter. Unset is `null`, never an error.
 */
export async function identity(
  service: RepositoryService,
  workspaceRoot: string,
  requested: string,
): Promise<IdentityRecord> {
  const context = await service.context(workspaceRoot, requested);
  return {
    name: await configValue(service, context.repository, "user.name"),
    email: await configValue(service, context.repository, "user.email"),
  };
}

/**
 * One config value, or `null` when it is unset.
 *
 * `git config --get` exits 1 for "no such key", which is an answer rather than
 * a failure. `--end-of-options` keeps a key beginning with a dash from being
 * read as a flag.
 */
async function configValue(
  service: RepositoryService,
  directory: string,
  key: string,
): Promise<string | null> {
  const output = await service.output(
    directory,
    ["config", "--get", "--end-of-options", key],
    Math.min(service.commandTimeoutMs, 10_000),
  );
  if (output.status !== 0) return null;
  // A key configured to the empty string is as unset as an absent one for the
  // two things this answer is used for.
  return nonempty(output.stdout.toString("utf8").replace(/\n$/, "").trim());
}
