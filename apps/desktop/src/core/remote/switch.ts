/**
 * Moving a workspace to a different execution host.
 *
 * Ported from the pre-merge implementation.
 *
 * A switch is a **rebinding with verification**, never a file move. Files are
 * moved by the person, with Git; this decides only whether the directory the
 * new host offers is the same project, and refuses if it cannot tell.
 *
 * Three refusals, each with its own reason code:
 *
 *  * `root_mismatch` — the new host's root exists but its `HEAD` and its
 *    top-level listing do not match what the old one had. Both digests are
 *    returned so a person can see *what* differs. `force` overrides it, needs
 *    the workspace write grant, and is recorded.
 *  * `switch_blocked` — something is still bound to the old host: an open
 *    editor draft, a live terminal, a browser session, an automation node, an
 *    owned Git operation. These are listed rather than counted, because "3
 *    blockers" is not something anybody can act on.
 *  * `unsupported` — a request to *migrate the files*. Copying a project
 *    between machines behind a settings toggle would be a data operation
 *    disguised as a preference.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/** What the caller asks for. */
export interface SwitchRequest {
  /** A `settings.ssh.hosts[].id`, or empty for this machine. */
  readonly executionHostId: string;
  /** An absolute path on that host. */
  readonly rootPath: string;
  /** Rebind even when the two roots do not look like the same project. */
  readonly force?: boolean;
  /**
   * End the terminals and browser sessions that are in the way, then switch.
   * Off by default and never implied by `force`: stopping somebody else's
   * running agent is a decision, and the person making it has to have seen the
   * list first — which is why the refusal names every entry.
   *
   * It never covers an editor draft or an in-flight Git operation. Those hold
   * work that cannot be recovered by reopening a node, so they stay refusals
   * whatever the request asks for.
   */
  readonly stopBlockers?: boolean;
  /**
   * Asking for the files to be copied across. Always refused; the field exists
   * so the refusal can name what was asked rather than ignoring it.
   */
  readonly migrateFiles?: boolean;
}

/** What a root looks like, cheaply enough to compare across machines. */
export interface RootFingerprint {
  /**
   * The commit `HEAD` resolves to, or empty when the root is not a repository
   * or has an unborn HEAD.
   */
  readonly head: string;
  /** A digest of the sorted top-level entry names and kinds. */
  readonly entries: string;
  /** How many top-level entries the digest covers, for the message. */
  readonly entryCount: number;
}

/** One thing that has to end before the workspace can move. */
export interface Blocker {
  /**
   * A stable key the UI translates: `editorDraft`, `terminal`, `browser`,
   * `automation`, `gitOperation`, `upload`.
   */
  readonly kind: string;
  /** What exactly — a path, a session id, a node id. */
  readonly detail: string;
}

/** The 409 body for a refused switch. */
export interface Refusal {
  readonly code: "switch_blocked" | "root_mismatch";
  readonly message: string;
  readonly from?: RootFingerprint;
  readonly to?: RootFingerprint;
  readonly blockers?: readonly Blocker[];
  /**
   * What `stopBlockers` actually ended before the switch was refused anyway.
   * Reported so the answer is not "nothing happened" when a terminal really
   * was killed — the person has to be told what they spent.
   */
  readonly stopped?: readonly Blocker[];
}

/**
 * The separator inside one entry's digest input.
 *
 * `U+0001` because it cannot occur in a filename on any platform Armadra runs
 * on, and the Rust side uses the same byte. Without it `ab` + `c` and `a` +
 * `bc` would digest identically.
 */
const FIELD = "\u0001";

/** A NUL after every entry, so two entry lists cannot run into each other. */
export function digest(names: readonly string[]): string {
  const hasher = createHash("sha256");
  for (const name of names) {
    hasher.update(Buffer.from(name, "utf8"));
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest("hex");
}

/** One directory listing → the digest half of a fingerprint. */
export function fingerprintOf(
  head: string,
  entries: readonly { readonly name: string; readonly kind: string }[],
): RootFingerprint {
  const names = entries
    .map((entry) => `${entry.name}${FIELD}${entry.kind}`)
    .sort();
  return { head, entries: digest(names), entryCount: names.length };
}

/**
 * This machine's answer, for the local half of a switch.
 *
 * `head` is passed in rather than read: resolving `HEAD` is the Git domain's
 * (R4), and a directory that is not a repository is a perfectly good workspace
 * root — it simply has no commit to compare, so an empty string is the correct
 * value rather than a failure.
 */
export function localFingerprint(root: string, head: string): RootFingerprint {
  const entries = readdirSync(root, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : "file",
  }));
  return fingerprintOf(head, entries);
}

/**
 * Whether two roots look like the same project.
 *
 * `HEAD` alone is not enough — two checkouts of the same commit in different
 * directories really are the same project, but a directory that is not a
 * repository has no commit at all — and the listing alone is not enough
 * either, because two branches of the same project differ in neither. Both
 * have to agree.
 */
export function matches(from: RootFingerprint, to: RootFingerprint): boolean {
  return from.head === to.head && from.entries === to.entries;
}

/* --------------------------------- blockers -------------------------------- */

/**
 * Where each kind of blocker comes from.
 *
 * Injected rather than read here because every source belongs to a domain that
 * is not this one — terminals are R2a's manager, browser sessions are R5's,
 * editor drafts are R4's file watch — and a switch that quietly forgot to ask
 * one of them would rebind underneath live work. A source that is not wired up
 * yet is `undefined` and contributes nothing, which is visible in the code
 * rather than hidden behind an empty implementation.
 */
export interface BlockerSources {
  readonly editorDrafts?: (workspaceId: string) => readonly string[];
  readonly terminals?: (
    workspaceId: string,
  ) => Promise<
    readonly { readonly nodeId: string; readonly sessionId: string }[]
  >;
  readonly browserSessions?: (
    workspaceId: string,
  ) => Promise<readonly { readonly nodeId: string; readonly id: string }[]>;
  readonly gitOperations?: (workspaceId: string) => readonly string[];
}

/** Everything still bound to the workspace's current host. */
export async function blockers(
  database: DatabaseSync,
  workspaceId: string,
  sources: BlockerSources,
): Promise<Blocker[]> {
  const listed: Blocker[] = [];
  for (const path of sources.editorDrafts?.(workspaceId) ?? []) {
    listed.push({ kind: "editorDraft", detail: path });
  }
  for (const session of (await sources.terminals?.(workspaceId)) ?? []) {
    listed.push({ kind: "terminal", detail: session.nodeId });
  }
  // A browser session holds a profile directory and a running browser on the
  // machine the workspace is leaving. Its downloads land in that workspace's
  // root, so it is bound to the host quite as firmly as a terminal is.
  for (const session of (await sources.browserSessions?.(workspaceId)) ?? []) {
    listed.push({ kind: "browser", detail: session.nodeId });
  }
  // An automation node's plan names the execution host it was pinned to.
  // Rebinding underneath it would leave the plan writing to a machine nobody
  // chose. The card is the only signal this process can see without asking
  // another service, and it is enough to name what has to be dealt with.
  for (const nodeId of automationNodes(database, workspaceId)) {
    listed.push({ kind: "automation", detail: nodeId });
  }
  for (const operation of sources.gitOperations?.(workspaceId) ?? []) {
    listed.push({ kind: "gitOperation", detail: operation });
  }
  return listed;
}

/** The automation nodes on this workspace's boards, by node id. */
export function automationNodes(
  database: DatabaseSync,
  workspaceId: string,
): string[] {
  try {
    const rows = database
      .prepare(
        "SELECT n.id FROM nodes n JOIN boards b ON b.id = n.board_id " +
          "WHERE b.workspace_id = ? AND n.type = 'automation' ORDER BY n.created_at",
      )
      .all(workspaceId) as { id: string }[];
    return rows.map((row) => row.id);
  } catch {
    // A core whose canvas tables are not assembled yet answers "none" rather
    // than failing the switch: the same degradation the workspace counts take.
    return [];
  }
}

/**
 * End what a switch is blocked on, on the caller's explicit say-so.
 *
 * Only the two kinds that are *processes* are ended: terminals and browser
 * sessions. An editor draft is unsaved work and a Git operation is a
 * repository mutation in flight — ending either on somebody's behalf would
 * destroy something they cannot get back, so those stay refusals whatever the
 * request says. An automation node's plan is not this process's to cancel; it
 * stays a blocker until the plan is retargeted.
 *
 * What is stopped is not reopened here either: the nodes are still on the
 * board, and the client reopens them against the new host once the rebinding
 * has actually landed. Reopening before the switch commits would attach them
 * to the machine that is being left.
 */
export interface Stoppers {
  /** The persistent session goes with the process — mode `session`. */
  readonly stopTerminal?: (sessionId: string) => Promise<void>;
  readonly stopBrowserSession?: (sessionId: string) => Promise<void>;
}

export async function stop(
  workspaceId: string,
  sources: BlockerSources,
  stoppers: Stoppers,
): Promise<Blocker[]> {
  const stopped: Blocker[] = [];
  for (const session of (await sources.terminals?.(workspaceId)) ?? []) {
    // Leaving a tmux window behind on the old machine would be a session bound
    // to a host the workspace no longer uses, which is the thing being removed.
    await stoppers.stopTerminal?.(session.sessionId);
    stopped.push({ kind: "terminal", detail: session.nodeId });
  }
  for (const session of (await sources.browserSessions?.(workspaceId)) ?? []) {
    await stoppers.stopBrowserSession?.(session.id);
    stopped.push({ kind: "browser", detail: session.nodeId });
  }
  return stopped;
}

/* ---------------------------------- refusal -------------------------------- */

/** A request that could not be processed at all. */
export class SwitchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SwitchError";
  }
}

/**
 * The checks that happen before any machine is reached.
 *
 * Separated from the rest so the part with no I/O can be tested as a function
 * — which is most of what the refusals are.
 */
export function validateRequest(
  request: SwitchRequest,
  canWrite: boolean,
): void {
  if (request.migrateFiles === true) {
    throw new SwitchError(
      501,
      "unsupported",
      "Armadra 只把工作空间重新绑到另一台执行主机，不搬文件。请在新主机上克隆这个项目再打开它。",
    );
  }
  if (!request.rootPath.startsWith("/") || request.rootPath.length > 4_096) {
    throw new SwitchError(
      400,
      "bad_request",
      "执行主机上的根必须是那台机器上的绝对路径",
    );
  }
  if (request.force === true && !canWrite) {
    throw new SwitchError(403, "forbidden", "强制切换需要工作空间的写入授权");
  }
}

/**
 * Decide the switch, given the two fingerprints and the blocker list.
 *
 * The caller does the I/O — reaching both hosts, registering the new root,
 * writing the row — and this decides. Keeping the decision pure is what lets
 * every refusal have a test that does not need two machines.
 *
 * Stopping happens before the list is taken again, and the second list is what
 * decides. Anything that survived being stopped — a draft, a Git operation, an
 * automation node — still refuses the switch, so `stopBlockers` can never turn
 * into "switch anyway".
 */
export function decide(input: {
  readonly remaining: readonly Blocker[];
  readonly stopped: readonly Blocker[];
  readonly from: RootFingerprint | undefined;
  readonly to: RootFingerprint | undefined;
  readonly force: boolean;
}): Refusal | undefined {
  if (input.remaining.length > 0) {
    return {
      code: "switch_blocked",
      message: "切换前请先关掉还在用这台执行主机的东西",
      blockers: input.remaining,
      ...(input.stopped.length === 0 ? {} : { stopped: input.stopped }),
    };
  }
  if (input.from === undefined || input.to === undefined) return undefined;
  if (!matches(input.from, input.to) && !input.force) {
    return {
      code: "root_mismatch",
      message: "新执行主机上的那个目录不是同一个项目",
      from: input.from,
      to: input.to,
      ...(input.stopped.length === 0 ? {} : { stopped: input.stopped }),
    };
  }
  return undefined;
}
