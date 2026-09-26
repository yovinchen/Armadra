/**
 * `e12` handles, and the rules that make them safe to hand a model.
 *
 * A ref names ONE element: a backend DOM node id in one CDP session (the page,
 * or one out-of-process iframe). Three properties, each a check rather than a
 * convention:
 *
 *   1. **Stable.** The same element keeps the same ref across snapshots, for
 *      as long as the page does not navigate. That is what lets a snapshot
 *      after an action be a DIFF: a line that did not change keeps its ref.
 *   2. **Never reused.** Ordinals only grow, for the life of the session. `e7`
 *      from before a navigation can never quietly come to mean whatever the
 *      next page's seventh element is — the number is simply not handed out
 *      again, and the old record says which generation it belonged to.
 *   3. **Re-resolved once, by what it described, or refused.** A ref whose
 *      node is gone (a re-render, a navigation) is looked up again by its role
 *      and accessible name, on the same origin only. Exactly one match is used
 *      and the answer says so; zero or several is a refusal that says which.
 *      The name is what a person reading the snapshot saw, so "the button
 *      called Next page" still means that button — and never a "Delete
 *      account" that happens to sit where it was.
 */

export interface RefRecord {
  /** The number both a person and an agent see: `e1`, `e2`. */
  readonly ordinal: number;
  /** `""` for the page itself, else the flat session of an iframe target. */
  readonly session: string;
  readonly backendNodeId: number;
  role: string;
  name: string;
  readonly generation: number;
  /** The page origin when this was minted; re-resolution stays on it. */
  readonly origin: string;
}

export type RefLookup =
  | { readonly ok: true; readonly record: RefRecord }
  | {
      readonly ok: false;
      readonly reason: "unknown" | "stale";
      readonly record?: RefRecord;
    };

/**
 * The ref syntax. `e12` is canonical; `@e12`, `ref=e12`, `[ref=e12]` and the
 * old `@12` are all read as the same thing, because a model copying a ref out
 * of a snapshot line should not fail on the brackets around it.
 */
export function parseRef(value: string): number | null {
  const match = /^\[?(?:ref=)?@?e?(\d{1,6})\]?$/i.exec(value.trim());
  if (!match) return null;
  const ordinal = Number.parseInt(match[1] ?? "", 10);
  return ordinal >= 1 ? ordinal : null;
}

export function refName(ordinal: number): string {
  return `e${ordinal}`;
}

/** Records kept, current and stale together. Old ones go first. */
const KEEP = 5_000;

/**
 * One page's refs. Held in memory only — like every other fact about who may
 * drive what.
 */
export class RefTable {
  private generation = 1;
  private next = 1;
  private readonly records = new Map<number, RefRecord>();
  /** `session|backendNodeId` → ordinal, for the current generation only. */
  private readonly byNode = new Map<string, number>();

  currentGeneration(): number {
    return this.generation;
  }

  /**
   * The main frame navigated, or its execution contexts were wiped. Every
   * outstanding ref now belongs to an older page.
   *
   * The records are KEPT: `e7` then answers "the page changed" rather than
   * "never heard of it", and the difference is the whole message — one tells
   * the reader to read again, the other that they typed something wrong.
   */
  bumpGeneration(): number {
    this.generation += 1;
    this.byNode.clear();
    return this.generation;
  }

  /**
   * The ref for one element, minting one if it has none yet. An element that
   * already has a ref keeps it; its role and name are refreshed, because a
   * button whose label changed from "Save" to "Saved" is still that button.
   */
  mint(
    session: string,
    backendNodeId: number,
    role: string,
    name: string,
    origin: string,
  ): RefRecord {
    const key = `${session}|${backendNodeId}`;
    const known = this.byNode.get(key);
    const existing = known === undefined ? undefined : this.records.get(known);
    if (existing !== undefined && existing.generation === this.generation) {
      existing.role = role;
      existing.name = name;
      return existing;
    }
    const record: RefRecord = {
      ordinal: this.next,
      session,
      backendNodeId,
      role,
      name,
      generation: this.generation,
      origin,
    };
    this.next += 1;
    this.records.set(record.ordinal, record);
    this.byNode.set(key, record.ordinal);
    while (this.records.size > KEEP) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    return record;
  }

  /** Forgets one element's ref, when its node turned out to be gone. */
  forget(record: RefRecord): void {
    const key = `${record.session}|${record.backendNodeId}`;
    if (this.byNode.get(key) === record.ordinal) this.byNode.delete(key);
  }

  lookup(ordinal: number): RefLookup {
    const record = this.records.get(ordinal);
    if (record === undefined) return { ok: false, reason: "unknown" };
    if (record.generation !== this.generation) {
      return { ok: false, reason: "stale", record };
    }
    return { ok: true, record };
  }

  /** Refs that are still usable. */
  size(): number {
    let live = 0;
    for (const record of this.records.values()) {
      if (record.generation === this.generation) live += 1;
    }
    return live;
  }
}

/**
 * Whether the element found now is still the one the ref described. Role must
 * match exactly; the name is compared after collapsing whitespace, because a
 * page that re-renders the same button may reflow its label without changing
 * it.
 */
export function verifyIdentity(
  record: { readonly role: string; readonly name: string },
  found: { readonly role: string; readonly name: string },
): boolean {
  return (
    record.role === found.role &&
    normalizeName(record.name) === normalizeName(found.name)
  );
}

export function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** What a caller is told about a ref that could not be found again. */
export function staleRefMessage(
  ordinal: number,
  why: "gone" | "none" | "many" | "moved",
  count = 0,
): string {
  const ref = refName(ordinal);
  switch (why) {
    case "none":
      return `${ref} 已不在页面上，按角色与名称也没找到同样的元素；请重新 read`;
    case "many":
      return `${ref} 已不在页面上，按角色与名称找到 ${count} 个同样的元素，无法确定是哪个；请重新 read`;
    case "moved":
      return `${ref} 属于之前的页面（已跳到另一个站点）；请重新 read`;
    default:
      return `${ref} 已不在页面上；请重新 read`;
  }
}

export function unknownRefMessage(ordinal: number): string {
  return `${refName(ordinal)} 不是这个页面给出的引用；请先 read`;
}
