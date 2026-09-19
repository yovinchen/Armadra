/**
 * Who may be registered as a drivable guest, and what a registration means.
 *
 * The rules are here rather than beside `webContents.fromId` because they are
 * the security-relevant half and must be testable without an Electron window.
 * The half that cannot move — `contents.getType() === 'webview'` — stays in
 * `main/browser/registry.ts`, and its absence is precisely the privilege
 * escalation the research named: the id that arrives here later selects a
 * webContents to attach a debugger to, so an unvalidated id is a request to
 * attach a debugger to anything the shell owns, including its own window.
 */

/** Where a guest is rendered. Only `canvas` is ever drivable. */
export type GuestSurface = "canvas" | "modal";

export interface GuestRegistration {
  readonly webContentsId: number;
  readonly nodeId: string;
  readonly tabId: string;
  readonly surface: GuestSurface;
  /** Whether this guest is the node's active tab right now. */
  readonly active: boolean;
}

/**
 * A canvas node id, as the board writes them. Deliberately narrow: the id is
 * used as a map key and appears verbatim in refusal text an agent reads, so
 * anything that could be mistaken for structure (a path separator, a quote, a
 * newline) is not an id.
 */
export function isSafeNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/** A tab id. Same shape, same reason. */
export function isSafeTabId(value: unknown): value is string {
  return isSafeNodeId(value);
}

const SURFACES: readonly string[] = ["canvas", "modal"];

/**
 * Validates what the renderer sent. Returns the registration, or the reason it
 * is not one. A reason is a stable token, never the offending value: a
 * registration refusal is read by developers, but it is produced from input the
 * page controls.
 */
export function parseRegistration(
  raw: unknown,
): { ok: true; registration: GuestRegistration } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "malformed" };
  }
  const value = raw as Record<string, unknown>;
  const id = value.webContentsId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: "badWebContentsId" };
  }
  if (!isSafeNodeId(value.nodeId)) return { ok: false, reason: "badNodeId" };
  if (!isSafeTabId(value.tabId)) return { ok: false, reason: "badTabId" };
  if (typeof value.surface !== "string" || !SURFACES.includes(value.surface)) {
    return { ok: false, reason: "badSurface" };
  }
  if (typeof value.active !== "boolean") return { ok: false, reason: "badActive" };
  return {
    ok: true,
    registration: {
      webContentsId: id,
      nodeId: value.nodeId,
      tabId: value.tabId,
      surface: value.surface as GuestSurface,
      active: value.active,
    },
  };
}

/**
 * The guest a verb aimed at `nodeId` should drive: the node's ACTIVE CANVAS
 * tab, and nothing else.
 *
 * Two exclusions, both deliberate. A `modal` guest is a preview a person
 * opened on top of the board — driving it would move a page the canvas is not
 * showing. An inactive tab is a page nobody is looking at, which is the whole
 * premise of "the agent drives the session the human is watching".
 */
export function drivableGuest(
  guests: Iterable<GuestRegistration>,
  nodeId: string,
): GuestRegistration | null {
  for (const guest of guests) {
    if (guest.nodeId !== nodeId) continue;
    if (guest.surface !== "canvas") continue;
    if (!guest.active) continue;
    return guest;
  }
  return null;
}

/**
 * The refusal for a node that cannot be driven.
 *
 * ONE sentence for two different situations — a node that exists but is not
 * drivable, and a node that does not exist at all — and that is the point. The
 * acceptance gate asserts the two are byte-for-byte identical, because a
 * refusal that distinguishes them turns the verb into a probe for which nodes
 * are on somebody's canvas.
 */
export function notDrivableMessage(nodeId: string): string {
  return `no drivable browser node "${nodeId}"`;
}

/**
 * What a guest that went away is called.
 *
 * A lifecycle event said as a lifecycle event. The guest was discarded to save
 * memory or the node was closed; calling that a permission failure sends the
 * reader looking for a setting that does not exist.
 */
export function discardedMessage(nodeId: string): string {
  return `browser node "${nodeId}" released its page to save memory; it reloads when somebody looks at it`;
}
