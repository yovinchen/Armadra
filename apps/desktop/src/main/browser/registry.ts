import { webContents, type WebContents } from "electron";

import {
  drivableGuest,
  parseRegistration,
  type GuestRegistration,
} from "../../shell-core/browser/registration";
import { GuestSession } from "./cdp";

/**
 * Which `webContents` is which canvas node, and which of them may be driven.
 *
 * The check that cannot move into `shell-core` lives here:
 * `contents.getType() === 'webview'`. Everything downstream selects a
 * webContents by the id this table holds and attaches a debugger to it, so an
 * id that was never checked is a request to attach a debugger to whatever the
 * renderer names — including the window the renderer itself runs in.
 *
 * The table is in memory and is never read back from disk. It is the same rule
 * as the ownership ledger, for the same reason: a file on disk can be edited to
 * declare a control relationship nobody granted.
 */

interface Entry extends GuestRegistration {
  readonly contents: WebContents;
  session: GuestSession | null;
}

const guests = new Map<number, Entry>();

export type RegisterOutcome =
  | { readonly ok: true; readonly nodeId: string; readonly tabId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Registers one guest, on the renderer's `dom-ready`.
 *
 * Re-registering the same id replaces the entry (a tab that became active) but
 * keeps its session, so switching tabs does not detach a debugger that a verb
 * is halfway through using.
 */
export function registerGuest(raw: unknown): RegisterOutcome {
  const parsed = parseRegistration(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const registration = parsed.registration;
  const contents = webContents.fromId(registration.webContentsId);
  if (!contents || contents.isDestroyed()) {
    return { ok: false, reason: "noSuchWebContents" };
  }
  // The check this whole module exists for.
  if (contents.getType() !== "webview") return { ok: false, reason: "notAWebview" };

  const existing = guests.get(registration.webContentsId);
  guests.set(registration.webContentsId, {
    ...registration,
    contents,
    session: existing?.session ?? null,
  });
  contents.once("destroyed", () => {
    unregisterGuest(registration.webContentsId, "destroyed");
  });
  return { ok: true, nodeId: registration.nodeId, tabId: registration.tabId };
}

/** Everything a revocation has to do when a guest goes away, in one place. */
type RevokeHook = (nodeId: string, reason: string) => void;
let revoke: RevokeHook = () => {};

export function onGuestLost(hook: RevokeHook): void {
  revoke = hook;
}

/**
 * Unregisters a guest. The LEASE IS DROPPED FIRST.
 *
 * Order matters and this is the order: a guest whose entry is gone cannot be
 * detached from, so releasing after removing would leave an attached debugger
 * and an ownership record for a page that no longer exists.
 */
export function unregisterGuest(webContentsId: number, reason: string): void {
  const entry = guests.get(webContentsId);
  if (!entry) return;
  entry.session?.detach(reason);
  guests.delete(webContentsId);
  revoke(entry.nodeId, reason);
}

/** Every guest of one node, in registration order. */
export function guestsOfNode(nodeId: string): Entry[] {
  return [...guests.values()].filter((entry) => entry.nodeId === nodeId);
}

export function allGuests(): Entry[] {
  return [...guests.values()];
}

/** Whether a webContents is one of ours, used by the popup rule. */
export function isRegisteredGuest(contents: WebContents): boolean {
  const entry = guests.get(contents.id);
  return entry !== undefined && entry.contents === contents;
}

export function guestByWebContentsId(webContentsId: number): Entry | undefined {
  return guests.get(webContentsId);
}

/**
 * The guest a verb aimed at this node should drive, with its session created
 * on demand. `null` when there is no such node, and `null` when the node exists
 * but has no active canvas guest — the caller turns both into the SAME
 * sentence.
 */
export function drivableSession(
  nodeId: string,
): { entry: Entry; session: GuestSession } | null {
  const entry = drivableGuest(guests.values(), nodeId) as Entry | null;
  if (!entry) return null;
  if (entry.contents.isDestroyed()) return null;
  if (entry.session === null) entry.session = new GuestSession(entry.contents);
  return { entry, session: entry.session };
}

/** Only for tests: forget everything. */
export function resetRegistry(): void {
  for (const entry of guests.values()) entry.session?.detach("reset");
  guests.clear();
}
