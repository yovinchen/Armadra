import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  EventCursorStatus,
  EventDomain,
  EventPriority,
  EventPageSchema,
  EventStreamFrameSchema,
  type EventEnvelope,
} from "@armadra/protocol";
import {
  HostEventStreamClient,
  HostEventStreamError,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  SILENCE_TIMEOUT_MS,
  eventStreamUrl,
  nextReconnectDelay,
  type HostEventStreamStatus,
  type WebSocketLike,
} from "../src/events.js";

const origin = "https://host.example";
const workspaceId = "workspace-1";

/** A scripted socket. Nothing here touches the network or a real timer. */
class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  closed = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer),
    );
  }
  close(): void {
    this.closed += 1;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame: Parameters<typeof create<typeof EventStreamFrameSchema>>[1]) {
    const wire = toBinary(
      EventStreamFrameSchema,
      create(EventStreamFrameSchema, frame),
    );
    this.onmessage?.({ data: wire.buffer.slice(0) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  /** What the client sent, decoded. */
  frames() {
    return this.sent.map((wire) => fromBinary(EventStreamFrameSchema, wire));
  }
}

/** A controllable clock: nothing waits on wall time in these tests. */
class Timers {
  #next = 1;
  readonly pending = new Map<number, { run: () => void; ms: number }>();
  set = (run: () => void, ms: number): unknown => {
    const handle = this.#next++;
    this.pending.set(handle, { run, ms });
    return handle;
  };
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  /** Fires the pending timer whose delay matches, newest first. */
  fire(ms: number): boolean {
    for (const [handle, entry] of [...this.pending].reverse()) {
      if (entry.ms !== ms) continue;
      this.pending.delete(handle);
      entry.run();
      return true;
    }
    return false;
  }
  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }
}

interface Harness {
  client: HostEventStreamClient;
  sockets: FakeSocket[];
  /** The nth socket the client opened. Fails loudly rather than returning
   *  undefined: a test asserting about a connection that was never made would
   *  otherwise pass for the wrong reason. */
  at: (index: number) => FakeSocket;
  timers: Timers;
  pages: EventEnvelope[][];
  statuses: HostEventStreamStatus[];
}

function harness(
  overrides: Partial<
    ConstructorParameters<typeof HostEventStreamClient>[0]
  > = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const timers = new Timers();
  const pages: EventEnvelope[][] = [];
  const statuses: HostEventStreamStatus[] = [];
  const client = new HostEventStreamClient({
    baseUrl: origin,
    workspaceIds: [workspaceId],
    onEvents: (events) => pages.push(events),
    onStatus: (status) => statuses.push(status),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    ...overrides,
  });
  return {
    client,
    sockets,
    at: (index) => {
      const socket = sockets[index];
      if (!socket) throw new Error(`the client never opened socket ${index}`);
      return socket;
    },
    timers,
    pages,
    statuses,
  };
}

function envelope(sequence: bigint, entityId = `node-${sequence}`) {
  return {
    sequence,
    transactionId: sequence,
    transactionSize: 1,
    workspaceId,
    domain: EventDomain.CANVAS,
    kind: "node",
    entityId,
    priority: EventPriority.NORMAL,
    revision: 1n,
  };
}

function page(
  events: ReturnType<typeof envelope>[],
  nextCursor: bigint,
  extra: Record<string, unknown> = {},
) {
  return {
    payload: {
      case: "page" as const,
      value: create(EventPageSchema, {
        status: EventCursorStatus.OK,
        events,
        nextCursor,
        minCursor: 0n,
        highWatermark: nextCursor,
        ...extra,
      }),
    },
  };
}

describe("host event stream URL", () => {
  it("upgrades an HTTPS origin and refuses anything a cookie must not cross", () => {
    expect(eventStreamUrl(origin)).toBe(
      "wss://host.example/ws/armadra.v1.EventStream",
    );
    expect(eventStreamUrl("http://127.0.0.1:8443")).toBe(
      "ws://127.0.0.1:8443/ws/armadra.v1.EventStream",
    );
    // A remote http origin would carry the session cookie in the clear.
    for (const bad of [
      "http://host.example",
      "ftp://host.example",
      "https://user:pass@host.example",
      "https://host.example?a=1",
      "not a url",
    ])
      expect(() => eventStreamUrl(bad)).toThrow(HostEventStreamError);
  });
});

describe("host event stream client", () => {
  it("subscribes from its cursor and applies pages in order", () => {
    const h = harness({ afterSequence: 4n });
    h.client.start();
    h.at(0).open();
    const subscribe = h.at(0).frames()[0];
    if (subscribe?.payload.case !== "subscribe")
      throw new Error("the client never subscribed");
    expect(subscribe.payload.value.afterSequence).toBe(4n);
    expect(subscribe.payload.value.workspaceIds).toEqual([workspaceId]);

    h.at(0).deliver(page([envelope(5n), envelope(6n)], 6n));
    expect(h.pages.flat().map((event) => event.sequence)).toEqual([5n, 6n]);
    expect(h.client.cursor).toBe(6n);
    const ack = h.at(0).frames()[1];
    if (ack?.payload.case !== "ack") throw new Error("the page was not acked");
    expect(ack.payload.value.receivedThrough).toBe(6n);
  });

  it("resumes from the cursor it holds, without a gap and without a replay", () => {
    const h = harness();
    h.client.start();
    h.at(0).open();
    h.at(0).deliver(page([envelope(1n), envelope(2n)], 2n));
    h.at(0).drop();
    // Backoff, then the second attempt asks for what follows sequence 2.
    expect(h.timers.fire(RECONNECT_MIN_MS)).toBe(true);
    h.at(1).open();
    const resumed = h.at(1).frames()[0];
    if (resumed?.payload.case !== "subscribe")
      throw new Error("the client never re-subscribed");
    expect(resumed.payload.value.afterSequence).toBe(2n);
    h.at(1).deliver(page([envelope(3n)], 3n));
    expect(h.pages.flat().map((event) => event.sequence)).toEqual([1n, 2n, 3n]);
  });

  it("advances past a page whose events were all filtered out", () => {
    const h = harness();
    h.client.start();
    h.at(0).open();
    // The Host saw commits for another workspace; the cursor still moves, so a
    // reconnect does not re-scan that stretch of history.
    h.at(0).deliver(page([], 40n));
    expect(h.pages).toEqual([[]]);
    expect(h.client.cursor).toBe(40n);
  });

  it("stops on a cursor the Host cannot serve, and resumes only from a snapshot", () => {
    const h = harness();
    h.client.start();
    h.at(0).open();
    h.at(0).deliver({
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.SNAPSHOT_REQUIRED,
          minCursor: 40n,
          highWatermark: 120n,
        }),
      },
    });
    expect(h.client.status).toBe("snapshotRequired");
    // No reconnect is queued: reconnecting from the same cursor would be told
    // the same thing again.
    expect(h.timers.delays()).toEqual([]);

    h.client.resumeFromSnapshot(41n);
    h.at(1).open();
    const resumed = h.at(1).frames()[0];
    if (resumed?.payload.case !== "subscribe")
      throw new Error("the client never re-subscribed");
    expect(resumed.payload.value.afterSequence).toBe(41n);
  });

  it("refuses to rewind when it is ahead of the Host", () => {
    const h = harness({ afterSequence: 500n });
    h.client.start();
    h.at(0).open();
    h.at(0).deliver({
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.CURSOR_AHEAD,
          minCursor: 1n,
          highWatermark: 9n,
        }),
      },
    });
    expect(h.client.status).toBe("diverged");
    expect(h.client.cursor).toBe(500n);
    expect(h.timers.delays()).toEqual([]);
  });

  it("treats an unknown page status as unusable rather than as an empty OK", () => {
    const h = harness();
    h.client.start();
    h.at(0).open();
    h.at(0).deliver({
      payload: {
        case: "page",
        // A status this build has never heard of: not "probably OK".
        value: create(EventPageSchema, {
          status: 99 as EventCursorStatus,
          nextCursor: 77n,
        }),
      },
    });
    expect(h.pages).toEqual([]);
    expect(h.client.cursor).toBe(0n);
  });

  it("rejects a page that is not a forward prefix of the sequence", () => {
    const h = harness({ afterSequence: 10n });
    h.client.start();
    h.at(0).open();
    // Out of order, then a cursor behind what it just claimed to deliver.
    h.at(0).deliver(page([envelope(12n), envelope(11n)], 12n));
    h.at(0).deliver(page([envelope(11n)], 5n));
    expect(h.pages).toEqual([]);
    expect(h.client.cursor).toBe(10n);
  });

  it("backs off 1s to 10s and resets only after a page is delivered", () => {
    const h = harness();
    h.client.start();
    let expected = RECONNECT_MIN_MS;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      h.at(attempt).open();
      h.at(attempt).drop();
      expect(h.timers.delays()).toEqual([expected]);
      expect(h.timers.fire(expected)).toBe(true);
      expected = Math.min(expected * 2, RECONNECT_MAX_MS);
    }
    // A socket that merely opened does not reset the backoff — a proxy will
    // open one for a Host that is not answering.
    h.at(5).open();
    h.at(5).deliver(page([envelope(1n)], 1n));
    h.at(5).drop();
    expect(h.timers.delays()).toEqual([RECONNECT_MIN_MS]);
  });

  it("reconnects when the stream goes silent even though the socket is open", () => {
    const h = harness();
    h.client.start();
    h.at(0).open();
    expect(h.timers.delays()).toContain(SILENCE_TIMEOUT_MS);
    h.timers.fire(SILENCE_TIMEOUT_MS);
    expect(h.at(0).closed).toBe(1);
    expect(h.client.status).toBe("reconnecting");
    expect(h.timers.fire(RECONNECT_MIN_MS)).toBe(true);
    expect(h.sockets).toHaveLength(2);
  });

  it("keeps a heartbeat from being mistaken for data while still proving life", () => {
    const h = harness();
    h.client.start();
    h.at(0).open();
    h.at(0).deliver({
      payload: {
        case: "heartbeat",
        value: { highWatermark: 12n, sentAtUnixMs: 1788557900000n },
      },
    });
    expect(h.pages).toEqual([]);
    expect(h.client.cursor).toBe(0n);
    // The watchdog was rearmed, so the connection is not torn down.
    expect(h.timers.delays()).toContain(SILENCE_TIMEOUT_MS);
  });

  it("stops for good on a refusal and keeps reconnecting on anything else", () => {
    const denied = harness();
    denied.client.start();
    const refused = denied.sockets[0] as FakeSocket;
    refused.open();
    refused.deliver({
      payload: {
        case: "error",
        value: { code: "PERMISSION_DENIED", message: "not your workspace" },
      },
    });
    expect(denied.client.status).toBe("denied");
    expect(denied.timers.delays()).toEqual([]);

    const exhausted = harness();
    exhausted.client.start();
    const socket = exhausted.sockets[0] as FakeSocket;
    socket.open();
    socket.deliver({
      payload: {
        case: "error",
        value: { code: "RESOURCE_EXHAUSTED", message: "queue budget" },
      },
    });
    socket.drop();
    expect(exhausted.timers.delays()).toEqual([RECONNECT_MIN_MS]);
  });

  it("leaves the cursor where it was when a handler throws", () => {
    const sockets: FakeSocket[] = [];
    const timers = new Timers();
    const client = new HostEventStreamClient({
      baseUrl: origin,
      workspaceIds: [workspaceId],
      onEvents: () => {
        throw new Error("the caller could not apply this page");
      },
      socket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeout: timers.set,
      clearTimeout: timers.clear,
    });
    client.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    expect(() => socket.deliver(page([envelope(1n)], 1n))).toThrow();
    expect(client.cursor).toBe(0n);
    // No ack either: the Host must keep the page in its budget until it lands.
    expect(socket.frames().filter((f) => f.payload.case === "ack")).toEqual([]);
  });

  it("refuses a subscription it could not honour", () => {
    for (const options of [
      { workspaceIds: [] },
      { workspaceIds: [workspaceId, workspaceId] },
      { workspaceIds: ["../escape"] },
      { workspaceIds: Array.from({ length: 33 }, (_, i) => `workspace-${i}`) },
      { afterSequence: -1n },
    ])
      expect(() =>
        harness(
          options as Partial<
            ConstructorParameters<typeof HostEventStreamClient>[0]
          >,
        ),
      ).toThrow(HostEventStreamError);
  });

  it("stops cleanly and does not reconnect afterwards", () => {
    const h = harness();
    h.client.start();
    const socket = h.sockets[0] as FakeSocket;
    socket.open();
    h.client.stop();
    expect(socket.closed).toBe(1);
    expect(h.client.status).toBe("idle");
    socket.drop();
    expect(h.timers.delays()).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  it("computes the documented backoff ladder", () => {
    expect(nextReconnectDelay(null)).toBe(1_000);
    expect(nextReconnectDelay(1_000)).toBe(2_000);
    expect(nextReconnectDelay(8_000)).toBe(10_000);
    expect(nextReconnectDelay(10_000)).toBe(10_000);
  });
});
