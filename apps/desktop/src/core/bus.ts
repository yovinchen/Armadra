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

/**
 * A payload this bus carries but does not read.
 *
 * Six of the 21 workspace events are large records owned by domains that land
 * in R4 and R5 — a resource sample, five browser records, two language ones.
 * Spelling their fields out here would put a second definition of each beside
 * the one its own domain will bring, and the two would drift. What the event
 * stream actually needs from them is that they are JSON objects, and that is
 * what this says.
 */
export type OpaquePayload = Readonly<Record<string, unknown>>;

/**
 * The 21 `WorkspaceEvent` variants of 合并前的实现, by their
 * contractual `type` string (contract §5, last paragraph: "21 个
 * `WorkspaceEvent` 的 `type` 字符串逐字不变").
 *
 * The value of each entry is the event's **own fields**, not a wrapper. The
 * Rust enum is `#[serde(tag = "type")]` — internally tagged — so a frame on the
 * wire is `{"type":"board.changed","boardId":…,"updatedAt":…}` with the fields
 * beside the tag, never nested under a `payload` key. `workspaceEventSchema` in
 * `packages/shared` is a `discriminatedUnion` over exactly that shape, and
 * `apps/web/src/api/events.ts` parses every frame through it before dispatching.
 *
 * An optional field here is one the Rust side marks
 * `skip_serializing_if = "Option::is_none"`: the key is **absent**, not null.
 * `terminal.exit` and `file.changed` differ on this deliberately — a removal
 * keeps `sha256` / `size` / `mtime` and nulls them, so a client never has to
 * tell "absent" from "gone".
 */
export interface WorkspaceEventPayloads {
  "agent.context": {
    readonly nodeId: string;
    readonly sessionId: string;
    readonly generation: number;
  };
  "agent.status": { readonly status: OpaquePayload };
  "agent.subagent": { readonly event: OpaquePayload };
  "agent.approval": {
    readonly nodeId: string;
    readonly pendingId: string;
    readonly request: unknown;
  };
  "agent.delivery": {
    readonly traceId: string;
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly outcome: string;
  };
  "terminal.exit": {
    readonly sessionId: string;
    readonly nodeId?: string;
    readonly exitCode?: number;
  };
  "board.changed": { readonly boardId: string; readonly updatedAt: string };
  /**
   * `ssh` is asking for a password or a key passphrase and there is no TTY to
   * ask on. Broadcast rather than answered: the secret belongs to a person, and
   * the prompt text is already redacted by the time it reaches this event.
   */
  "ssh.prompt": { readonly prompt: OpaquePayload };
  /**
   * The workspace itself changed in a way that invalidates everything the
   * client is holding about it — today only an execution-host switch. Carries
   * no other field on purpose: a partial patch is exactly what must not happen
   * here.
   */
  "workspace.updated": { readonly workspaceId: string };
  /** A control verb waiting for a human; the verb gives up after 130 s. */
  "control.confirm": {
    readonly requestId: string;
    readonly verb: string;
    readonly nodeId: string;
    readonly summary: string;
  };
  /**
   * A host / session resource sample. Only published while somebody holds a
   * subscription for this workspace, so a closed panel produces no traffic and
   * no sampling.
   */
  "resource.sample": { readonly snapshot: OpaquePayload };
  "browser.session": { readonly session: OpaquePayload };
  "browser.download": { readonly download: OpaquePayload };
  "browser.lease": {
    readonly sessionId: string;
    readonly lease: OpaquePayload;
  };
  "browser.tabs": { readonly sessionId: string; readonly tabs: OpaquePayload };
  /** Absent `dialog` means the dialog has been answered or has timed out. */
  "browser.dialog": {
    readonly sessionId: string;
    readonly dialog?: OpaquePayload;
  };
  "browser.fileChooser": {
    readonly sessionId: string;
    readonly chooser?: OpaquePayload;
  };
  /**
   * One line of "who did what" for the node header. The activity record is
   * `#[serde(flatten)]`ed into the frame, so its own keys sit beside `type`
   * rather than under an `activity` key.
   */
  "browser.activity": OpaquePayload;
  "language.session": {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly serverId: string;
    readonly generation: number;
    readonly state: string;
    readonly reason?: string;
    readonly restartCount: number;
    readonly progress?: OpaquePayload;
  };
  "language.server": {
    readonly workspaceId: string;
    readonly executionHostId: string;
    readonly server: OpaquePayload;
    readonly stderrTail?: string;
  };
  "file.changed": {
    readonly workspaceId: string;
    readonly path: string;
    readonly kind: "modified" | "removed" | "replaced";
    readonly sha256: string | null;
    readonly size: number | null;
    readonly mtime: string | null;
  };
}

export type WorkspaceEventType = keyof WorkspaceEventPayloads;

/** One frame of `WS /api/workspaces/{id}/events`, tag and fields together. */
export type WorkspaceEvent = {
  [Type in WorkspaceEventType]: { readonly type: Type } & Omit<
    WorkspaceEventPayloads[Type],
    "type"
  >;
}[WorkspaceEventType];

/**
 * Every `type` string, in the order the pre-merge implementation declares its
 * variants. Exported so a test can assert the set rather than trusting that
 * nobody renamed one while moving code around.
 */
export const WORKSPACE_EVENT_TYPES = [
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
] as const satisfies readonly WorkspaceEventType[];

export interface CoreEvents {
  /**
   * Emitted once per run, right after the listeners are published. It carries
   * the instance id so a subscriber that attached to the wrong core can tell.
   */
  "runtime.hello": { readonly instanceId: string; readonly version: string };
  /**
   * One workspace event, on its way to whoever is watching that workspace.
   *
   * Every domain emits this and nothing else: the fan-out by `workspaceId`, the
   * per-connection queue and the WebSocket writing all live in `core/events`,
   * so a domain that saved a board does not have to know whether anybody is
   * listening — or care that one of the listeners is slow. The Rust Runtime
   * split the same way (`EventHub::publish` returns a count nobody checks); the
   * difference is only that there is no longer a second process on the far side
   * of it.
   */
  "workspace.event": {
    readonly workspaceId: string;
    readonly event: WorkspaceEvent;
  };
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
