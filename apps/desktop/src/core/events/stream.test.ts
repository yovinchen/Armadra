/**
 * The per-workspace fan-out.
 *
 * Ported from the two cases in `apps/runtime/src/events.rs` plus the behaviour
 * `apps/runtime/src/api/events.rs` gets from `tokio::sync::broadcast` for free
 * and this implementation has to arrange on purpose: a bounded backlog, the
 * oldest frames dropped rather than the connection, and one slow reader not
 * holding up a fast one.
 */

import { describe, expect, it, vi } from "vitest";

import { EventBus, WORKSPACE_EVENT_TYPES, type WorkspaceEvent } from "../bus";
import {
  MAX_QUEUED_FRAMES,
  WorkspaceEventStream,
  type EventSink,
} from "./stream";

/** A sink that writes straight through — the fast client. */
function immediate(): { sink: EventSink; frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    sink: {
      send(frame, written) {
        frames.push(frame);
        written();
      },
    },
  };
}

/** A sink that never finishes a write until it is released — the stuck client. */
function stalled(): {
  sink: EventSink;
  frames: string[];
  flush: () => void;
} {
  const frames: string[] = [];
  const pending: (() => void)[] = [];
  return {
    frames,
    sink: {
      send(frame, written) {
        frames.push(frame);
        pending.push(written);
      },
    },
    flush: () => {
      // Drain in order; each release may enqueue the next frame.
      while (pending.length > 0) (pending.shift() as () => void)();
    },
  };
}

const board = (boardId: string): WorkspaceEvent => ({
  type: "board.changed",
  boardId,
  updatedAt: "2026-09-04T00:00:00+00:00",
});

describe("WorkspaceEventStream", () => {
  it("delivers an event only to its own workspace", () => {
    const stream = new WorkspaceEventStream();
    const first = immediate();
    const second = immediate();
    stream.subscribe("ws-1", first.sink);
    stream.subscribe("ws-2", second.sink);

    expect(
      stream.publish("ws-1", {
        type: "terminal.exit",
        sessionId: "s",
        nodeId: "n",
        exitCode: 0,
      }),
    ).toBe(1);
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(0);

    // Nobody is listening on ws-3; publishing must still succeed. A save that
    // nobody is looking at is still a save.
    expect(stream.publish("ws-3", board("b"))).toBe(0);
  });

  /**
   * Internally tagged, not wrapped. `workspaceEventSchema` in
   * `packages/shared` is a `discriminatedUnion` over `{ type, …fields }`, and
   * `apps/web/src/api/events.ts` drops any frame it cannot parse through it.
   */
  it("puts the fields beside the tag rather than under a payload key", () => {
    const stream = new WorkspaceEventStream();
    const client = immediate();
    stream.subscribe("ws-1", client.sink);
    stream.publish("ws-1", board("b"));
    expect(JSON.parse(client.frames[0] as string)).toEqual({
      type: "board.changed",
      boardId: "b",
      updatedAt: "2026-09-04T00:00:00+00:00",
    });
  });

  /**
   * `skip_serializing_if = "Option::is_none"` on the Rust side: the key is
   * absent, not null. `file.changed` deliberately does the opposite, so a
   * client never has to tell "absent" from "gone".
   */
  it("omits the optional keys and keeps the nulled ones", () => {
    const stream = new WorkspaceEventStream();
    const client = immediate();
    stream.subscribe("ws-1", client.sink);
    stream.publish("ws-1", { type: "terminal.exit", sessionId: "s" });
    stream.publish("ws-1", {
      type: "file.changed",
      workspaceId: "ws-1",
      path: "src/main.ts",
      kind: "removed",
      sha256: null,
      size: null,
      mtime: null,
    });
    const exit = JSON.parse(client.frames[0] as string) as Record<
      string,
      unknown
    >;
    expect("nodeId" in exit).toBe(false);
    expect("exitCode" in exit).toBe(false);
    const changed = JSON.parse(client.frames[1] as string) as Record<
      string,
      unknown
    >;
    expect(changed.sha256).toBeNull();
    expect(changed.size).toBeNull();
    expect(changed.mtime).toBeNull();
  });

  it("carries the 21 contractual type strings and no others", () => {
    expect(WORKSPACE_EVENT_TYPES).toHaveLength(21);
    expect(new Set(WORKSPACE_EVENT_TYPES).size).toBe(21);
    // A rename here is a break in `packages/shared`'s discriminated union and
    // in every front-end reducer that switches on it (contract §5).
    expect([...WORKSPACE_EVENT_TYPES]).toEqual([
      "agent.context",
      "agent.status",
      "agent.subagent",
      "agent.approval",
      "agent.delivery",
      "terminal.exit",
      "board.changed",
      "ssh.prompt",
      "workspace.updated",
      "control.confirm",
      "resource.sample",
      "browser.session",
      "browser.download",
      "browser.lease",
      "browser.tabs",
      "browser.dialog",
      "browser.fileChooser",
      "browser.activity",
      "language.session",
      "language.server",
      "file.changed",
    ]);
  });

  it("fans one event out to every watcher of the same workspace", () => {
    const stream = new WorkspaceEventStream();
    const first = immediate();
    const second = immediate();
    stream.subscribe("ws-1", first.sink);
    stream.subscribe("ws-1", second.sink);
    expect(stream.publish("ws-1", board("b"))).toBe(2);
    expect(first.frames).toEqual(second.frames);
  });

  it("stops delivering once a subscriber is released, and forgets the workspace", () => {
    const stream = new WorkspaceEventStream();
    const client = immediate();
    const release = stream.subscribe("ws-1", client.sink);
    stream.publish("ws-1", board("a"));
    release();
    // Releasing twice is harmless: a socket may report both `close` and
    // `error`, and both wire to the same function.
    release();
    stream.publish("ws-1", board("b"));
    expect(client.frames).toHaveLength(1);
    // A workspace nobody watches keeps no entry: the map would otherwise grow
    // by one every time a board was opened and closed for the rest of the run.
    expect(stream.watchedWorkspaces()).toEqual([]);
    expect(stream.subscriberCount("ws-1")).toBe(0);
  });

  /**
   * The Rust receiver is a `broadcast` channel of 256; a subscriber further
   * behind than that gets `RecvError::Lagged`, which the loop answers with
   * `continue` — it resumes at the oldest frame still in the ring. It is never
   * disconnected for being slow, because disconnecting it would cost it the
   * frames it could still keep up with.
   */
  it("drops the oldest frames of a stuck client rather than the client", () => {
    const stream = new WorkspaceEventStream();
    const slow = stalled();
    stream.subscribe("ws-1", slow.sink);

    const total = MAX_QUEUED_FRAMES + 50;
    for (let index = 0; index < total; index += 1) {
      stream.publish("ws-1", board(`b-${index}`));
    }
    // One frame is in flight and 256 are queued, so 257 are still held and the
    // bound has bitten on the remaining 49.
    expect(stream.droppedFrames("ws-1")).toEqual([
      total - MAX_QUEUED_FRAMES - 1,
    ]);
    expect(slow.frames).toHaveLength(1);

    slow.flush();
    // It resumes at the oldest frame still held, not at the one it was on.
    expect(slow.frames).toHaveLength(MAX_QUEUED_FRAMES + 1);
    expect(JSON.parse(slow.frames[0] as string).boardId).toBe("b-0");
    expect(JSON.parse(slow.frames[1] as string).boardId).toBe("b-50");
    expect(
      JSON.parse(slow.frames[slow.frames.length - 1] as string).boardId,
    ).toBe(`b-${total - 1}`);
    // Still connected.
    expect(stream.subscriberCount("ws-1")).toBe(1);
  });

  /**
   * Two clients watching the same board are two connections with two drain
   * rates. A queue shared between them would make the slower one's backlog the
   * faster one's latency.
   */
  it("does not let a slow client hold up a fast one", () => {
    const stream = new WorkspaceEventStream();
    const slow = stalled();
    const fast = immediate();
    stream.subscribe("ws-1", slow.sink);
    stream.subscribe("ws-1", fast.sink);

    for (let index = 0; index < 1_000; index += 1) {
      stream.publish("ws-1", board(`b-${index}`));
    }
    expect(fast.frames).toHaveLength(1_000);
    expect(slow.frames).toHaveLength(1);
    expect(stream.droppedFrames("ws-1")).toEqual([
      1_000 - 1 - MAX_QUEUED_FRAMES,
      0,
    ]);
  });

  it("serialises one event once however many clients are watching", () => {
    const stream = new WorkspaceEventStream();
    for (let index = 0; index < 5; index += 1) {
      stream.subscribe("ws-1", immediate().sink);
    }
    const stringify = vi.spyOn(JSON, "stringify");
    stream.publish("ws-1", board("b"));
    expect(stringify).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
  });

  it("takes everything from the bus and nothing from anywhere else", () => {
    const bus = new EventBus();
    const stream = new WorkspaceEventStream();
    const detach = stream.attach(bus);
    const client = immediate();
    stream.subscribe("ws-1", client.sink);

    bus.emit("workspace.event", { workspaceId: "ws-1", event: board("a") });
    bus.emit("workspace.event", { workspaceId: "ws-2", event: board("b") });
    expect(client.frames).toHaveLength(1);

    detach();
    bus.emit("workspace.event", { workspaceId: "ws-1", event: board("c") });
    expect(client.frames).toHaveLength(1);
  });
});
