/**
 * `@N` handles, and the one rule that makes them safe.
 *
 * A ref is scoped twice: to a node, and to a GENERATION of that node's
 * navigation. `readMap` mints refs and stamps the current generation on them;
 * a main-frame `Page.frameNavigated` or a `Runtime.executionContextsCleared`
 * bumps it, and every ref minted before that is dead.
 *
 * A dead ref is REFUSED. It is never silently re-resolved, and that is the
 * whole point of the type: a ref that quietly re-resolves after a navigation is
 * how an agent clicks "Delete account" while meaning "Next page".
 *
 * A live ref is still checked on use — the resolver returns the element's role
 * and name, and `verifyIdentity` compares them with what was minted. The page
 * can move things around without navigating; a ref whose element is no longer
 * the element it described is stale too.
 */

export interface RefRecord {
  /** The number a person and an agent both see: `@1`, `@2`. */
  readonly ordinal: number;
  /** Position in the shared element enumeration (`scripts.ELEMENT_QUERY`). */
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly generation: number;
}

export interface MintedElement {
  readonly index: number;
  readonly role: string;
  readonly name: string;
}

export type RefLookup =
  | { readonly ok: true; readonly record: RefRecord }
  | { readonly ok: false; readonly reason: "unknown" | "stale" };

/** The `@N` syntax, and only that. Anything else was never a ref. */
export function parseRef(value: string): number | null {
  const match = /^@(\d{1,4})$/.exec(value.trim());
  if (!match) return null;
  const ordinal = Number.parseInt(match[1] ?? "", 10);
  return ordinal >= 1 ? ordinal : null;
}

/**
 * One node's refs. There is one of these per registered node, held in main's
 * memory only — like every other fact about who may drive what.
 */
export class RefTable {
  private generation = 1;
  private records = new Map<number, RefRecord>();

  /** The generation refs minted right now belong to. */
  currentGeneration(): number {
    return this.generation;
  }

  /**
   * A navigation happened. Every outstanding ref is now dead.
   *
   * Called for a MAIN-frame `Page.frameNavigated` and for
   * `Runtime.executionContextsCleared`. A subframe navigating is not a new
   * document for the refs the map described, and bumping on it would make refs
   * expire whenever an advert reloaded.
   */
  bumpGeneration(): number {
    this.generation += 1;
    this.records.clear();
    return this.generation;
  }

  /** Replaces the table with the refs a fresh `readMap` produced. */
  mint(elements: readonly MintedElement[]): RefRecord[] {
    this.records.clear();
    const minted = elements.map((element, position) => ({
      ordinal: position + 1,
      index: element.index,
      role: element.role,
      name: element.name,
      generation: this.generation,
    }));
    for (const record of minted) this.records.set(record.ordinal, record);
    return minted;
  }

  lookup(ordinal: number): RefLookup {
    const record = this.records.get(ordinal);
    if (record === undefined) return { ok: false, reason: "unknown" };
    if (record.generation !== this.generation) {
      return { ok: false, reason: "stale" };
    }
    return { ok: true, record };
  }

  /** Only for tests and for the drive channel's diagnostics. */
  size(): number {
    return this.records.size;
  }
}

/**
 * Whether the element the resolver just found is still the one the ref
 * described. Role must match exactly; the name is compared after collapsing
 * whitespace, because a page that re-renders the same button may reflow its
 * label without changing it.
 */
export function verifyIdentity(
  record: RefRecord,
  found: { readonly role: string; readonly name: string },
): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return record.role === found.role && normalize(record.name) === normalize(found.name);
}

/** What a caller is told about a ref that is no longer usable. */
export function staleRefMessage(ordinal: number): string {
  return `@${ordinal} is no longer on this page; read the page again to get fresh refs`;
}

export function unknownRefMessage(ordinal: number): string {
  return `@${ordinal} is not a ref this page handed out; read the page first`;
}
