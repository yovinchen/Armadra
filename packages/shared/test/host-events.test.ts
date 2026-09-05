import { describe, expect, it } from "vitest";
import { create, EventDomain, EventEnvelopeSchema } from "@armadra/protocol";

import {
  hostEventCanvasId,
  hostEventToWorkspaceEvent,
  toWorkspaceEvents,
} from "../src/host-events.js";

const workspaceId = "workspace-1";
const canvasId = "canvas-1";

function envelope(
  init: Parameters<typeof create<typeof EventEnvelopeSchema>>[1],
) {
  return create(EventEnvelopeSchema, {
    sequence: 1n,
    transactionId: 1n,
    transactionSize: 1,
    workspaceId,
    domain: EventDomain.CANVAS,
    revision: 1n,
    ...init,
  });
}

describe("host event projection", () => {
  it("names the board a canvas change belongs to", () => {
    const canvas = envelope({
      kind: "canvas",
      entityId: canvasId,
      entity: {
        case: "canvas",
        value: { canvasId, workspaceId, updatedAtUnixMs: 1788557900000n },
      },
    });
    expect(hostEventCanvasId(canvas)).toBe(canvasId);
    expect(hostEventToWorkspaceEvent(canvas)).toEqual({
      type: "board.changed",
      boardId: canvasId,
      updatedAt: new Date(1788557900000).toISOString(),
    });
  });

  it("resolves a nested object through the canvas it names, not its own id", () => {
    const node = envelope({
      kind: "node",
      entityId: "node-1",
      entity: {
        case: "canvasNode",
        value: { nodeId: "node-1", canvasId, updatedAtUnixMs: 1788557900001n },
      },
    });
    // The node's own id is not a board id; reading it as one would invalidate
    // a board that does not exist and leave the real one stale.
    expect(hostEventCanvasId(node)).toBe(canvasId);
    const projected = hostEventToWorkspaceEvent(node);
    expect(projected?.type === "board.changed" && projected.boardId).toBe(
      canvasId,
    );
  });

  it("reports a change it cannot name as a reload rather than dropping it", () => {
    // A tombstone carries no entity, so a deleted node names no canvas. That
    // is still a real change: silently ignoring it would leave the deleted
    // node on screen until something else happened to refresh the board.
    const tombstone = envelope({
      kind: "node",
      entityId: "node-1",
      deleted: true,
    });
    expect(hostEventCanvasId(tombstone)).toBeNull();
    expect(hostEventToWorkspaceEvent(tombstone)).toBeNull();

    const workspace = envelope({ kind: "workspace", entityId: workspaceId });
    expect(hostEventToWorkspaceEvent(workspace)).toBeNull();

    const projection = toWorkspaceEvents([tombstone, workspace]);
    expect(projection.events).toEqual([]);
    expect(projection.reloadRequired).toBe(true);
  });

  it("keeps page order and separates nameable changes from reloads", () => {
    const projection = toWorkspaceEvents([
      envelope({
        sequence: 1n,
        kind: "canvas",
        entityId: "canvas-a",
        entity: {
          case: "canvas",
          value: { canvasId: "canvas-a", updatedAtUnixMs: 1n },
        },
      }),
      envelope({ sequence: 2n, kind: "workspace", entityId: workspaceId }),
      envelope({
        sequence: 3n,
        kind: "canvas",
        entityId: "canvas-b",
        entity: {
          case: "canvas",
          value: { canvasId: "canvas-b", updatedAtUnixMs: 2n },
        },
      }),
    ]);
    expect(
      projection.events.map((event) =>
        event.type === "board.changed" ? event.boardId : event.type,
      ),
    ).toEqual(["canvas-a", "canvas-b"]);
    expect(projection.reloadRequired).toBe(true);
  });

  it("publishes nothing for a domain that has not switched", () => {
    for (const domain of [
      EventDomain.SETTINGS,
      EventDomain.FILESYSTEM,
      EventDomain.SESSION,
      EventDomain.AGENT,
      EventDomain.GIT,
    ]) {
      const event = envelope({ domain, kind: "whatever", entityId: "x" });
      expect(hostEventToWorkspaceEvent(event)).toBeNull();
    }
  });

  it("dates a tombstone by when it was seen, never by the epoch", () => {
    const before = Date.now();
    const projected = hostEventToWorkspaceEvent(
      envelope({
        kind: "canvas",
        entityId: canvasId,
        deleted: true,
      }),
    );
    // A deletion of the canvas itself is nameable: its id is its entity id.
    if (projected?.type !== "board.changed")
      throw new Error("a deleted canvas must still name its board");
    expect(projected.boardId).toBe(canvasId);
    expect(Date.parse(projected.updatedAt)).toBeGreaterThanOrEqual(before);
  });
});
