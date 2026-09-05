import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  EventCursorStatus,
  EventDomain,
  EventEnvelopeSchema,
  EventHeartbeatSchema,
  EventPageSchema,
  EventPriority,
  EventStreamFrameSchema,
  SubscribeEventsRequestSchema,
} from "../src/index.js";

/**
 * The Host → client event stream (host business migration §2.3), read from the
 * same fixtures the Go runtime wrote.
 *
 * The browser is the consumer that most needs these distinctions kept: it
 * applies pages to a live document, so a tombstone that decoded as an empty
 * entity would blank a node, and a refusal that decoded as an empty OK page
 * would advance the cursor past changes it never received.
 */
function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const maxUint64 = 18_446_744_073_709_551_615n;

describe("host event stream wire contract", () => {
  it("carries identity, transaction grouping and the entity itself", () => {
    check("events_envelope_node", EventEnvelopeSchema, {
      sequence: 9007199254740993n,
      transactionId: maxUint64,
      operationId: "canvas/工作区-1/画布-1/7",
      transactionIndex: 2,
      transactionSize: 3,
      workspaceId: "工作区-1",
      domain: EventDomain.CANVAS,
      kind: "node",
      entityId: "节点-1",
      priority: EventPriority.NORMAL,
      revision: maxUint64,
      entity: {
        case: "canvasNode",
        value: {
          nodeId: "节点-1",
          canvasId: "画布-1",
          type: "terminal",
          title: "终端📟",
          position: { x: -1.5, y: 2.25 },
          dataJson: new TextEncoder().encode('{"backend":"tmux"}'),
          revision: 7n,
        },
      },
    });
  });

  it("keeps a deletion a tombstone rather than an emptied entity", () => {
    const decoded = fromBinary(
      EventEnvelopeSchema,
      fixture("events_envelope_deleted"),
    );
    expect(decoded.deleted).toBe(true);
    expect(decoded.entity.case).toBeUndefined();
    expect(decoded.entityId).toBe("画布-1");
    expect(decoded.revision).toBe(4n);
  });

  it("relays a domain it was built before without renaming it", () => {
    const decoded = fromBinary(
      EventEnvelopeSchema,
      fixture("events_envelope_future_domain"),
    );
    expect(decoded.domain).toBe(99);
    expect(decoded.domain).not.toBe(EventDomain.UNSPECIFIED);
    expect(decoded.priority).toBe(EventPriority.HIGH);
    expect(toBinary(EventEnvelopeSchema, decoded)).toEqual(
      fixture("events_envelope_future_domain"),
    );
  });

  it("states the cursor, the scope and the budget of a subscription", () => {
    check("events_subscribe", EventStreamFrameSchema, {
      payload: {
        case: "subscribe",
        value: create(SubscribeEventsRequestSchema, {
          afterSequence: 9007199254740993n,
          workspaceIds: ["工作区-1", "workspace-2"],
          domains: [EventDomain.CANVAS, EventDomain.AGENT],
          pageBytes: 262144,
          minPriority: EventPriority.HIGH,
        }),
      },
    });
  });

  it("names a cursor it cannot serve and never implies one with an empty page", () => {
    check("events_page_snapshot_required", EventStreamFrameSchema, {
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.SNAPSHOT_REQUIRED,
          minCursor: 40n,
          highWatermark: 120n,
        }),
      },
    });
    check("events_page_cursor_ahead", EventStreamFrameSchema, {
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.CURSOR_AHEAD,
          minCursor: 1n,
          highWatermark: 3n,
        }),
      },
    });
    // An absent status must not decode as OK: that page would be applied and
    // the cursor advanced past events this client never saw.
    expect(create(EventPageSchema).status).toBe(
      EventCursorStatus.UNSPECIFIED as number,
    );
    expect(EventCursorStatus.UNSPECIFIED).not.toBe(EventCursorStatus.OK);
  });

  it("keeps page, heartbeat, ack and error apart on one connection", () => {
    check("events_page_ok", EventStreamFrameSchema, {
      payload: {
        case: "page",
        value: create(EventPageSchema, {
          status: EventCursorStatus.OK,
          events: [
            {
              sequence: 6n,
              transactionId: 4n,
              transactionSize: 1,
              workspaceId: "工作区-1",
              domain: EventDomain.CANVAS,
              kind: "edge",
              entityId: "连线-1",
              revision: 1n,
            },
          ],
          nextCursor: 6n,
          minCursor: 2n,
          highWatermark: 9n,
          hasMore: true,
        }),
      },
    });
    check("events_heartbeat", EventStreamFrameSchema, {
      payload: {
        case: "heartbeat",
        value: create(EventHeartbeatSchema, {
          highWatermark: 9007199254740993n,
          sentAtUnixMs: 1788557900000n,
        }),
      },
    });
    check("events_ack", EventStreamFrameSchema, {
      payload: {
        case: "ack",
        value: { receivedThrough: maxUint64, availableCreditBytes: 4194304 },
      },
    });
    check("events_error", EventStreamFrameSchema, {
      payload: {
        case: "error",
        value: { code: "RESOURCE_EXHAUSTED", message: "订阅队列已满" },
      },
    });
    const concatenated = new Uint8Array([
      ...fixture("events_page_ok"),
      ...fixture("events_error"),
    ]);
    expect(fromBinary(EventStreamFrameSchema, concatenated).payload.case).toBe(
      "error",
    );
  });
});
