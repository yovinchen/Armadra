import { EventDomain, type EventEnvelope } from "@armadra/protocol";

import type { WorkspaceEvent } from "./api/events.js";

/**
 * Host `EventEnvelope` → the `WorkspaceEvent` the UI already subscribes to
 * (host business migration §2.3).
 *
 * The subscription interface does not change when a domain switches owner. A
 * panel keeps calling `onWorkspaceEvent("board.changed", …)`; what changes is
 * which service produced the frame. Keeping the projection here rather than in
 * the transport is what makes that true for every consumer at once — and what
 * keeps a Runtime-sourced event and a Host-sourced one from drifting into two
 * subtly different shapes for the same change.
 *
 * The same event type never has two sources at one time: a domain is owned by
 * exactly one service, so a client reads it from exactly one stream.
 */

/**
 * The canvas an envelope belongs to, or null when it cannot be determined.
 *
 * Only the canvas itself carries its id in `entityId`. A node, edge or
 * annotation carries its own id there and names its canvas inside the entity —
 * which a tombstone does not have, because a deletion states an id and a
 * revision and nothing else. `null` therefore means "this changed something in
 * the workspace, but not something whose board can be named", and the caller
 * has to reload rather than patch one board.
 */
export function hostEventCanvasId(event: EventEnvelope): string | null {
  if (event.domain !== EventDomain.CANVAS) return null;
  if (event.kind === "canvas") return event.entityId || null;
  switch (event.entity.case) {
    case "canvas":
      return event.entity.value.canvasId || null;
    case "canvasNode":
    case "canvasEdge":
    case "canvasAnnotation":
      return event.entity.value.canvasId || null;
    default:
      return null;
  }
}

/**
 * Projects one envelope, or returns null when this version publishes no
 * `WorkspaceEvent` for it.
 *
 * Null is not "nothing happened": a workspace record changing, or a nested
 * object being deleted, is a real change with no per-board event to describe
 * it. Callers treat a page containing nulls as a reason to reload the domain,
 * which is why `toWorkspaceEvents` reports both halves.
 */
export function hostEventToWorkspaceEvent(
  event: EventEnvelope,
): WorkspaceEvent | null {
  if (event.domain !== EventDomain.CANVAS) return null;
  const boardId = hostEventCanvasId(event);
  if (!boardId) return null;
  return {
    type: "board.changed",
    boardId,
    updatedAt: hostEventTimestamp(event),
  };
}

/** The instant a change was made, as the UI's ISO string. */
function hostEventTimestamp(event: EventEnvelope): string {
  const millis =
    event.entity.case === "canvas"
      ? event.entity.value.updatedAtUnixMs
      : event.entity.case === "canvasNode" ||
          event.entity.case === "canvasEdge" ||
          event.entity.case === "canvasAnnotation"
        ? event.entity.value.updatedAtUnixMs
        : 0n;
  // A tombstone carries no entity and therefore no timestamp of its own. The
  // moment it was observed is the honest answer; inventing an epoch date would
  // make a deletion sort before every change it followed.
  const value = millis > 0n ? Number(millis) : Date.now();
  return new Date(value).toISOString();
}

export interface HostEventProjection {
  /** Events the UI's existing subscribers understand. */
  events: WorkspaceEvent[];
  /**
   * True when at least one envelope had no `WorkspaceEvent` of its own. The
   * change is real; it just has no per-entity shape, so the caller reloads.
   */
  reloadRequired: boolean;
}

/** Projects one page, keeping its order. */
export function toWorkspaceEvents(
  envelopes: EventEnvelope[],
): HostEventProjection {
  const events: WorkspaceEvent[] = [];
  let reloadRequired = false;
  for (const envelope of envelopes) {
    const projected = hostEventToWorkspaceEvent(envelope);
    if (projected) events.push(projected);
    else reloadRequired = true;
  }
  return { events, reloadRequired };
}
