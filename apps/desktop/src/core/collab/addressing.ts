import type { DatabaseSync } from "node:sqlite";
import type { ContextLink } from "../canvas/context-links";
import { Refusal } from "./refusals";

/**
 * Naming a peer — the one place that turns `--node` / `--to` into a link.
 *
 * Ported from `apps/runtime/src/collab/addressing.rs`. Both collaboration
 * surfaces address the same thing: a node the caller is linked to on the
 * canvas. `context-link` reads it, the mailbox posts to it, and neither may
 * reach a node the user did not connect. Keeping the rule here means the two
 * verbs cannot drift into resolving the same word differently — the failure
 * mode where an agent reads one peer and writes to another.
 *
 * The order is deliberate, most specific first:
 *
 *   1. the node id, exactly;
 *   2. `data.handle`, exactly — a short alias the user assigned;
 *   3. the title, exactly, case-insensitively;
 *   4. the title, as a substring, when exactly one link contains it.
 *
 * Ambiguity is refused rather than guessed at every stage. Writing to the
 * wrong agent is worse than not writing at all.
 */

/**
 * The longest a handle may be. Short on purpose: a handle exists so an agent
 * can type a peer's name without quoting a title.
 */
export const MAX_HANDLE_CHARS = 24;

/**
 * Normalizes `raw` into a handle, or `undefined` when it is not one.
 *
 * 1–{@link MAX_HANDLE_CHARS} ASCII characters, starting with a letter or a
 * digit and continuing with letters, digits, `-` or `_`. Case is folded, so
 * `Review` and `review` are the same handle and neither can shadow the other.
 */
export function normalizeHandle(raw: string): string | undefined {
  const handle = raw.trim().toLowerCase();
  if (handle.length === 0 || handle.length > MAX_HANDLE_CHARS) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) return undefined;
  return handle;
}

/**
 * `node.data.handle`, re-validated rather than trusted: a board written by an
 * older client — or by hand — must not be able to register a handle the rename
 * verb would have refused.
 */
export function handleOf(data: Record<string, unknown>): string | undefined {
  const raw = data.handle;
  return typeof raw === "string" ? normalizeHandle(raw) : undefined;
}

/** node id → handle, for the nodes one link document points at. */
export type Handles = ReadonlyMap<string, string>;

export const NO_HANDLES: Handles = new Map();

/**
 * Reads the handles of every node a link document points at, in one query.
 *
 * Handles live in `node.data`, not in the link document: the canvas rewrites
 * links whenever an edge changes, so a copy there would go stale the moment a
 * node was renamed. `shape` links are skipped — a whiteboard shape has no node
 * row, so it has no handle either.
 */
export function loadHandles(
  database: DatabaseSync,
  links: readonly ContextLink[],
): Handles {
  const ids = links.filter((link) => link.kind !== "shape").map(({ id }) => id);
  const handles = new Map<string, string>();
  if (ids.length === 0) return handles;
  // Only the placeholder count varies; every id is still bound, so nothing a
  // link document carries reaches the statement text.
  const placeholders = ids.map(() => "?").join(",");
  const rows = database
    .prepare(`SELECT id, data_json FROM nodes WHERE id IN (${placeholders})`)
    .all(...ids) as { id: string; data_json: string }[];
  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.data_json) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const handle = handleOf(data);
    if (handle !== undefined) handles.set(row.id, handle);
  }
  return handles;
}

/* ------------------------------- resolution ------------------------------- */

export type AddressErrorKind =
  | "no_links"
  | "target_unspecified"
  | "target_not_linked"
  | "target_ambiguous";

/**
 * Why a name did not become exactly one linked node.
 *
 * Every variant carries a stable code, because "which agent did you mean?" is
 * a question a caller can act on and a prose sentence is not something it can
 * branch on.
 */
export class AddressError extends Error {
  readonly code: AddressErrorKind;
  readonly linked: number;
  readonly wanted: string;
  /** `[title, id]` for every candidate, so the caller can pick one. */
  readonly matches: readonly (readonly [string, string])[];

  constructor(
    code: AddressErrorKind,
    options: {
      readonly linked?: number;
      readonly wanted?: string;
      readonly matches?: readonly (readonly [string, string])[];
    } = {},
  ) {
    super(code);
    this.name = "AddressError";
    this.code = code;
    this.linked = options.linked ?? 0;
    this.wanted = options.wanted ?? "";
    this.matches = options.matches ?? [];
  }

  /**
   * Not being linked is a permission answer, not a lookup miss: the node may
   * well exist, and saying so would let an agent probe the board by name.
   */
  get status(): number {
    return this.code === "no_links" || this.code === "target_not_linked"
      ? 403
      : 400;
  }

  private candidates(): string {
    return this.matches.map(([title, id]) => `${title}（${id}）`).join("、");
  }

  /**
   * The context-link sentence. That surface answers `text/plain` prose in
   * Chinese and names its own flag, so the wording lives with the caller
   * rather than with the rule.
   */
  refusal(flag: string): Refusal {
    const message = {
      no_links: "这个节点还没有连接任何其他节点，没有可读的上下文。",
      target_unspecified: `这个节点连接了 ${this.linked} 个节点，请用 ${flag} 指明要读哪一个。`,
      target_not_linked: `「${this.wanted}」不在这个节点的链接列表里，已拒绝；先在画布上连一条线。`,
      target_ambiguous: `「${this.wanted}」同时匹配 ${this.matches.length} 个链接：${this.candidates()}。请用节点 ID 或短名指明。`,
    }[this.code];
    return new Refusal(this.status, message);
  }

  /**
   * The mailbox sentence. The mailbox speaks English to its callers, and a
   * refusal it hands back must read like the rest of that surface.
   */
  english(flag: string): string {
    return {
      no_links: "Draw a canvas link to another agent before addressing it.",
      target_unspecified: `${this.linked} nodes are linked; name one with ${flag} <node id, handle or title>.`,
      target_not_linked: `No linked node answers to "${this.wanted}"; draw a canvas link to it first.`,
      target_ambiguous: `"${this.wanted}" matches ${this.matches.length} linked nodes: ${this.candidates()}. Use the node id or a handle.`,
    }[this.code];
  }
}

function ambiguous(
  wanted: string,
  matches: readonly ContextLink[],
): AddressError {
  return new AddressError("target_ambiguous", {
    wanted,
    matches: matches.map((link) => [link.title, link.id] as const),
  });
}

/**
 * Resolves one name against the caller's own link document.
 *
 * `wanted` is `undefined` when the caller left the flag off: one link needs no
 * name, more than one does. Pass {@link NO_HANDLES} when handles do not apply
 * — resolution then falls straight through to the title rules.
 */
export function resolveLink(
  links: readonly ContextLink[],
  handles: Handles,
  wanted: string | undefined,
): ContextLink {
  if (links.length === 0) throw new AddressError("no_links");
  const needle = wanted?.trim();
  if (needle === undefined || needle === "") {
    if (links.length === 1) return links[0] as ContextLink;
    throw new AddressError("target_unspecified", { linked: links.length });
  }
  const byId = links.find((link) => link.id === needle);
  if (byId !== undefined) return byId;

  // A handle beats a title even when a *different* node is titled the same
  // word: the handle was assigned on purpose, the title collision was not.
  const handle = normalizeHandle(needle);
  if (handle !== undefined) {
    const matches = links.filter((link) => handles.get(link.id) === handle);
    if (matches.length === 1) return matches[0] as ContextLink;
    if (matches.length > 1) throw ambiguous(needle, matches);
  }

  const lowered = needle.toLowerCase();
  const exact = links.filter((link) => link.title.toLowerCase() === lowered);
  if (exact.length === 1) return exact[0] as ContextLink;
  if (exact.length > 1) throw ambiguous(needle, exact);

  const partial = links.filter((link) =>
    link.title.toLowerCase().includes(lowered),
  );
  if (partial.length === 1) return partial[0] as ContextLink;
  if (partial.length > 1) throw ambiguous(needle, partial);
  throw new AddressError("target_not_linked", { wanted: needle });
}
