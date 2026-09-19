/**
 * The in-process event bus, and the shape a WebSocket broadcast takes.
 *
 * Every domain publishes here and nothing publishes anywhere else. That is the
 * whole point of the merge: the Rust Runtime fanned events out through an
 * `EventHub` and the Go Host through a durable `eventstream` with an outbox
 * table, because a business write and its event were in two processes. In one
 * process a subscriber is a function call away, and the outbox becomes a
 * question only about *reconnecting* clients — which is R1's problem, not this
 * one.
 *
 * R0 defines one event, `runtime.hello`, so the transport can be proven before
 * a domain exists to fill it. The 21 `WorkspaceEvent` type strings are
 * contractual and arrive verbatim in R1 (contract §5).
 */

export interface CoreEvents {
  /**
   * Emitted once per run, right after the listeners are published. It carries
   * the instance id so a subscriber that attached to the wrong core can tell.
   */
  "runtime.hello": { readonly instanceId: string; readonly version: string };
  /**
   * One frame of `WS /api/workspaces/{id}/events`, with the workspace it
   * belongs to beside it.
   *
   * The envelope exists because the stream is *scoped* and the frame is
   * *contractual*. `workspaceEventSchema` in packages/shared is a discriminated
   * union on `type`, and two of its members — `board.changed` is the clearest —
   * carry no workspace id at all: the Rust `EventHub::publish(&workspace_id, …)`
   * kept the routing key outside the payload, and so does this. So a publisher
   * sets `workspaceId` for the fan-out to route on, and `event` is forwarded to
   * subscribers byte for byte.
   *
   * The authoritative list of what `event` may be is `workspaceEventSchema` in
   * `packages/shared/src/api/events.ts` — 21 `type` strings, contractual and
   * unchanged (design §5). It is not restated as a union here: the core does
   * not depend on that package, and a second copy of the list would be a
   * second thing to drift. What guards the shape instead is the parity check,
   * which parses every frame this core emits with the real schema.
   */
  "workspace.event": {
    readonly workspaceId: string;
    readonly event: WorkspaceEventFrame;
  };
}

/** One frame of the workspace stream: a contractual `type`, plus its fields. */
export interface WorkspaceEventFrame {
  readonly type: string;
  readonly [field: string]: unknown;
}

export type EventName = keyof CoreEvents;

export type Subscriber<Name extends EventName> = (
  payload: CoreEvents[Name],
) => void;

/** What a subscriber sends back over the wire. camelCase, like everything else. */
export interface BusFrame<Name extends EventName = EventName> {
  readonly type: Name;
  readonly payload: CoreEvents[Name];
}

export class EventBus {
  private readonly subscribers = new Map<EventName, Set<Subscriber<never>>>();

  /** Returns the unsubscribe function; calling it twice is harmless. */
  on<Name extends EventName>(
    name: Name,
    subscriber: Subscriber<Name>,
  ): () => void {
    const existing = this.subscribers.get(name) ?? new Set();
    existing.add(subscriber as Subscriber<never>);
    this.subscribers.set(name, existing);
    return () => {
      existing.delete(subscriber as Subscriber<never>);
    };
  }

  /**
   * One subscriber that throws must not stop the others, and must not take the
   * publisher's write down with it: a board that saved is saved whether or not
   * a WebSocket client could be told about it.
   */
  emit<Name extends EventName>(
    name: Name,
    payload: CoreEvents[Name],
    onError: (error: unknown) => void = () => {},
  ): void {
    for (const subscriber of this.subscribers.get(name) ?? []) {
      try {
        (subscriber as Subscriber<Name>)(payload);
      } catch (error) {
        onError(error);
      }
    }
  }

  frame<Name extends EventName>(
    name: Name,
    payload: CoreEvents[Name],
  ): BusFrame<Name> {
    return { type: name, payload };
  }

  subscriberCount(name: EventName): number {
    return this.subscribers.get(name)?.size ?? 0;
  }
}
