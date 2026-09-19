/**
 * `WS /api/workspaces/{id}/events` — the per-workspace fan-out.
 *
 * Ported from `apps/runtime/src/events.rs` (`EventHub`) and
 * `apps/runtime/src/api/events.rs` (the socket loop). The acceptance test for
 * this file is `apps/web/src/api/events.ts`, which is not allowed to change: a
 * frame it cannot parse through `workspaceEventSchema` is a frame it drops.
 *
 * What the Rust side does, and therefore what this does:
 *
 *   * **No handshake.** The stream opens and says nothing. There is no initial
 *     snapshot and no server hello — the front end's own reducers are seeded by
 *     the REST reads it already made, and a snapshot frame would be a 22nd
 *     event type nothing parses.
 *   * **No heartbeat.** Neither side pings. The Rust loop is a `select!` over
 *     the broadcast receiver and the incoming stream and writes nothing of its
 *     own, so a quiet workspace is a quiet socket.
 *   * **Read-only.** A client frame matters only as a close. Anything else is
 *     ignored rather than answered, and there is no ack: the transport is the
 *     acknowledgement, and a client that missed frames re-reads instead.
 *   * **A slow subscriber loses frames, not its connection.** The Rust receiver
 *     is a `broadcast` channel of 256; a subscriber that falls further behind
 *     than that gets `RecvError::Lagged`, which the loop answers with
 *     `continue` — it resumes at the oldest frame still in the ring and the
 *     skipped ones are gone. It is never disconnected for being slow, because
 *     disconnecting it would cost it the frames it *could* still keep up with.
 *   * **Reconnection is the client's.** `nextReconnectDelay` in `api/events.ts`
 *     backs off 1 s → 2 s → 4 s → 8 s → 10 s and resets on open. The server has
 *     no part in it and keeps no session across one.
 */

import type { WebSocket } from "ws";

import type { EventBus, WorkspaceEvent } from "../bus";

/**
 * How far behind one connection may fall before it starts losing frames.
 *
 * 256, the capacity of the Rust `broadcast` channel, and for the same reason: a
 * board being dragged produces frames faster than a socket on a busy machine
 * drains them, and the choice is between a bounded loss and an unbounded
 * buffer. `ws` will happily queue gigabytes into `bufferedAmount`, so the bound
 * has to be kept here.
 */
export const MAX_QUEUED_FRAMES = 256;

/**
 * What a subscriber is, once the socket details are stripped away.
 *
 * `written` is the backpressure signal and the only reason this is an interface
 * rather than a `WebSocket`: a sink that calls it immediately never queues, and
 * a sink that calls it when the bytes have left the process is what bounds a
 * slow client's backlog.
 */
export interface EventSink {
  /** Serialised frame, ready for the wire. */
  send(frame: string, written: () => void): void;
}

interface Subscription {
  readonly sink: EventSink;
  /** Oldest first. Bounded by `MAX_QUEUED_FRAMES`; the oldest is dropped. */
  readonly queue: string[];
  /** True while a `send` is in flight; the queue drains one frame at a time. */
  writing: boolean;
  closed: boolean;
  /** How many frames this connection has lost to the bound, for diagnostics. */
  dropped: number;
}

/**
 * The fan-out itself: subscriptions by workspace, and one bounded queue per
 * connection.
 *
 * Deliberately not one queue per workspace. Two clients watching the same board
 * are two connections with two drain rates, and a shared queue would make the
 * slower one's backlog the faster one's latency — which is precisely the
 * property the acceptance asks about ("慢客户端不拖慢快客户端").
 */
export class WorkspaceEventStream {
  private readonly subscriptions = new Map<string, Set<Subscription>>();

  /**
   * Attaches to a bus and returns the detach function.
   *
   * Every domain emits `workspace.event`; nothing emits to a socket directly.
   */
  attach(bus: EventBus): () => void {
    return bus.on("workspace.event", ({ workspaceId, event }) => {
      this.publish(workspaceId, event);
    });
  }

  /**
   * Hands one event to everybody watching that workspace.
   *
   * Serialised once for all of them: the frame is identical per connection, and
   * a board with thirty nodes open in two windows would otherwise pay for the
   * same `JSON.stringify` twice. Publishing into a workspace nobody watches is
   * a no-op and never an error — a save that nobody is looking at is still a
   * save.
   */
  publish(workspaceId: string, event: WorkspaceEvent): number {
    const watchers = this.subscriptions.get(workspaceId);
    if (watchers === undefined || watchers.size === 0) return 0;
    const frame = JSON.stringify(event);
    for (const subscription of watchers) this.enqueue(subscription, frame);
    return watchers.size;
  }

  /** Registers a sink and returns the function that removes it. */
  subscribe(workspaceId: string, sink: EventSink): () => void {
    const subscription: Subscription = {
      sink,
      queue: [],
      writing: false,
      closed: false,
      dropped: 0,
    };
    const watchers = this.subscriptions.get(workspaceId) ?? new Set<Subscription>();
    watchers.add(subscription);
    this.subscriptions.set(workspaceId, watchers);
    return () => {
      subscription.closed = true;
      subscription.queue.length = 0;
      watchers.delete(subscription);
      // A workspace nobody watches keeps no entry: the map would otherwise grow
      // by one every time a board was opened and closed for the rest of the run.
      if (watchers.size === 0) this.subscriptions.delete(workspaceId);
    };
  }

  /** How many connections are watching one workspace. */
  subscriberCount(workspaceId: string): number {
    return this.subscriptions.get(workspaceId)?.size ?? 0;
  }

  /** Every workspace with at least one watcher, for the sampling domains. */
  watchedWorkspaces(): string[] {
    return [...this.subscriptions.keys()];
  }

  private enqueue(subscription: Subscription, frame: string): void {
    if (subscription.closed) return;
    subscription.queue.push(frame);
    // The ring overwrites its oldest entry, and the Rust receiver resumes at
    // the oldest one still in it. Dropping from the front is the same thing
    // said from the other end.
    while (subscription.queue.length > MAX_QUEUED_FRAMES) {
      subscription.queue.shift();
      subscription.dropped += 1;
    }
    this.drain(subscription);
  }

  /**
   * Writes one frame and waits for it to leave before writing the next.
   *
   * The wait is what makes the bound mean anything. `WebSocket.send` returns as
   * soon as the frame is queued in the socket's own buffer, so a loop that
   * pushed the whole queue at once would move an unbounded backlog from this
   * queue into `bufferedAmount` and the drop rule would never fire.
   */
  private drain(subscription: Subscription): void {
    if (subscription.writing || subscription.closed) return;
    const frame = subscription.queue.shift();
    if (frame === undefined) return;
    subscription.writing = true;
    let advanced = false;
    subscription.sink.send(frame, () => {
      // A sink that called back twice for one frame would let two writes race
      // down the same queue; the second call is ignored rather than trusted.
      if (advanced) return;
      advanced = true;
      subscription.writing = false;
      this.drain(subscription);
    });
  }

  /**
   * Attaches one already-upgraded socket to a workspace.
   *
   * The `ws` send callback is the drain signal, which is why the socket is
   * wrapped here rather than in the HTTP layer: separating the two would leave
   * a queue whose drain condition lived somewhere else.
   *
   * Returns the release function; the caller wires it to `close`.
   */
  attachSocket(workspaceId: string, socket: WebSocket): () => void {
    return this.subscribe(workspaceId, {
      send(frame, written) {
        socket.send(frame, () => {
          // A failed write is a socket on its way out; `close` will arrive and
          // release the subscription. Advancing anyway keeps the queue from
          // wedging in the meantime.
          written();
        });
      },
    });
  }

  /** Diagnostics: how many frames each connection has lost to the bound. */
  droppedFrames(workspaceId: string): number[] {
    return [...(this.subscriptions.get(workspaceId) ?? [])].map(
      (subscription) => subscription.dropped,
    );
  }
}
