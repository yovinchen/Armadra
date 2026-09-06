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
  CanvasConsistencyReportSchema,
  CanvasCursorStatus,
  CanvasDocumentSchema,
  CanvasEdgeKind,
  CanvasEntityKind,
  CanvasEventEnvelopeSchema,
  CanvasEventPageSchema,
  CanvasNodeSchema,
  CanvasOperationReceiptSchema,
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
  CanvasOwnershipSchema,
  SaveCanvasDocumentRequestSchema,
  WorkerRequestSchema,
  WorkerResponseSchema,
} from "../src/index.js";

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

describe("canvas ownership and document wire contracts", () => {
  const minInt64 = -9_223_372_036_854_775_808n;
  const beyondDouble = 9_007_199_254_740_993n;
  const canvasNode = () => ({
    nodeId: "node-终端",
    canvasId: "canvas-1",
    type: "terminal",
    title: "构建 📦",
    color: "#0a84ff",
    position: { x: -1024.5, y: 2048.25 },
    size: { width: 640, height: 480 },
    collapsed: false,
    expandedHeight: 0,
    // Frame nesting is a plain parent reference, so a migration can compare it
    // without understanding what a frame draws like.
    parentId: "node-frame",
    dataJson: new TextEncoder().encode('{"sessionId":"session-1"}'),
    assets: [
      {
        assetId: "asset-1",
        workspaceId: "workspace-1",
        relativePath: ".armadra/assets/ab/cd/图片.png",
        sha256: new Uint8Array(32).fill(5),
        bytes: beyondDouble,
        mimeType: "image/png",
      },
    ],
    createdAtUnixMs: 1788557000000n,
    updatedAtUnixMs: 1788557900000n,
    revision: beyondDouble,
  });

  it("keeps a whole canvas document byte-identical across runtimes", () => {
    check("canvas_document", CanvasDocumentSchema, {
      canvas: {
        canvasId: "canvas-1",
        workspaceId: "workspace-1",
        name: "默认画布",
        sortOrder: minInt64,
        viewport: { x: -0.5, y: 12.25, zoom: 1.5 },
        whiteboard: {
          schemaVersion: 2,
          engineVersion: "armadra-flow",
          snapshot: new Uint8Array([0x00, 0x9f, 0x99, 0x82]),
          sha256: new Uint8Array(32).fill(1),
          bytes: 4n,
        },
        createdAtUnixMs: 1788557000000n,
        updatedAtUnixMs: 1788557900000n,
        revision: maxUint64,
      },
      nodes: [
        canvasNode(),
        {
          nodeId: "node-frame",
          canvasId: "canvas-1",
          type: "group",
          title: "Frame",
          position: {},
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557000000n,
          revision: 1n,
        },
      ],
      edges: [
        {
          edgeId: "edge-1",
          canvasId: "canvas-1",
          sourceNodeId: "node-终端",
          targetNodeId: "node-frame",
          kind: CanvasEdgeKind.LINK,
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557000000n,
          revision: 1n,
        },
      ],
      annotations: [
        {
          annotationId: "annotation-1",
          canvasId: "canvas-1",
          nodeId: "node-终端",
          labels: ["构建", "夜间"],
          note: "备注 🈶",
          createdAtUnixMs: 1788557000000n,
          updatedAtUnixMs: 1788557900000n,
          revision: 2n,
        },
      ],
      eventSequence: beyondDouble,
    });
  });

  it("names the operation and the revision a save was written against", () => {
    check("canvas_save_request", SaveCanvasDocumentRequestSchema, {
      meta: {
        requestId: "save-1",
        scope: {
          hostId: "0123456789abcdef0123456789abcdef",
          workspaceId: "workspace-1",
          executionHostId: "0123456789abcdef0123456789abcdef",
        },
        idempotencyKey: "canvas/workspace-1/canvas-1/7",
      },
      operationId: "canvas/workspace-1/canvas-1/7",
      canvas: {
        canvasId: "canvas-1",
        workspaceId: "workspace-1",
        name: "默认画布",
        viewport: { zoom: 1 },
      },
      expectedRevision: beyondDouble,
      nodes: [canvasNode()],
    });
    check("canvas_receipt", CanvasOperationReceiptSchema, {
      operationId: "canvas/workspace-1/canvas-1/7",
      transactionId: beyondDouble,
      firstSequence: beyondDouble,
      lastSequence: maxUint64,
      replayed: true,
      revisions: [
        {
          kind: CanvasEntityKind.CANVAS,
          entityId: "canvas-1",
          revision: 2n,
        },
        {
          kind: CanvasEntityKind.NODE,
          entityId: "node-终端",
          revision: maxUint64,
          deleted: true,
        },
      ],
    });
  });

  it("carries the whole entity with the event that changed it", () => {
    check("canvas_event", CanvasEventEnvelopeSchema, {
      sequence: beyondDouble,
      transactionId: 42n,
      operationId: "canvas/workspace-1/canvas-1/7",
      transactionIndex: 1,
      transactionSize: 3,
      workspaceId: "workspace-1",
      kind: CanvasEntityKind.NODE,
      entityId: "node-终端",
      revision: maxUint64,
      entity: { case: "node", value: canvasNode() },
    });
  });

  /**
   * A cursor below the retained floor is answered with a status, not with a
   * silently shortened history: an empty page here would read as "nothing
   * changed" and leave the client permanently behind.
   */
  it("answers an unusable cursor with a status rather than an empty page", () => {
    check("canvas_event_snapshot_required", CanvasEventPageSchema, {
      status: CanvasCursorStatus.SNAPSHOT_REQUIRED,
      nextCursor: 0n,
      minCursor: beyondDouble,
      highWatermark: maxUint64,
    });
  });

  it("records the ownership epoch and the verification it rests on", () => {
    check("canvas_ownership_switching", CanvasOwnershipSchema, {
      domain: "canvas",
      owner: CanvasOwnershipOwner.RUNTIME,
      epoch: beyondDouble,
      phase: CanvasOwnershipPhase.SWITCHING,
      importId: "0123456789abcdef0123456789abcdef",
      reasonCode: "ownership.switch.verified",
      updatedAtUnixMs: 1788557900000n,
      revision: 3n,
    });
    check("canvas_consistency_report", CanvasConsistencyReportSchema, {
      importId: "0123456789abcdef0123456789abcdef",
      exportId: "导出-1",
      manifestSha256: new Uint8Array(32).fill(2),
      checks: [
        { check: "nodes", expectedCount: 2n, actualCount: 2n, matched: true },
        {
          check: "assets",
          expectedCount: 1n,
          actualCount: 0n,
          matched: false,
          differences: ["asset-1"],
        },
      ],
      matched: false,
      entityCount: beyondDouble,
      verifiedAtUnixMs: 1788557900000n,
    });
  });

  it("hands write ownership over by naming both epochs", () => {
    check("worker_set_ownership", WorkerRequestSchema, {
      requestId: "ownership-1",
      hostId: "0123456789abcdef0123456789abcdef",
      action: {
        case: "setWriteOwnership",
        value: {
          domain: "canvas",
          owner: CanvasOwnershipOwner.HOST,
          epoch: beyondDouble,
          expectedEpoch: 9_007_199_254_740_992n,
          reasonCode: "ownership.switch.verified",
        },
      },
    });
    check("worker_write_ownership", WorkerResponseSchema, {
      requestId: "ownership-1",
      hostId: "0123456789abcdef0123456789abcdef",
      instanceId: "abcdef0123456789abcdef0123456789",
      result: {
        case: "writeOwnership",
        value: {
          domain: "canvas",
          owner: CanvasOwnershipOwner.HOST,
          epoch: beyondDouble,
          updatedAtUnixMs: 1788557900000n,
          reasonCode: "ownership.switch.verified",
        },
      },
    });
  });

  /**
   * A node whose size was never set and one explicitly stored at zero are
   * different documents. Losing the distinction silently resizes canvases the
   * next time they are read back.
   */
  it("distinguishes an absent node size from an explicit zero", () => {
    check("canvas_node_absent_size", CanvasNodeSchema, {
      nodeId: "node-裸",
      canvasId: "canvas-1",
      type: "sticky",
      position: { x: 0, y: 0 },
      revision: 1n,
    });
    const absent = create(CanvasNodeSchema, { nodeId: "n", canvasId: "c" });
    const zero = create(CanvasNodeSchema, {
      nodeId: "n",
      canvasId: "c",
      size: {},
      collapsed: false,
      expandedHeight: 0,
    });
    expect(toBinary(CanvasNodeSchema, absent)).not.toEqual(
      toBinary(CanvasNodeSchema, zero),
    );
    const back = fromBinary(
      CanvasNodeSchema,
      toBinary(CanvasNodeSchema, absent),
    );
    expect(back.size).toBeUndefined();
    expect(back.collapsed).toBeUndefined();
    expect(back.expandedHeight).toBeUndefined();
  });

  // Zero is reserved everywhere: a default-constructed message never claims to
  // be a real entity kind, edge kind, cursor status, owner or phase.
  it("reserves 0 in every canvas enumeration", () => {
    expect(CanvasEntityKind.UNSPECIFIED).toBe(0);
    expect(CanvasEdgeKind.UNSPECIFIED).toBe(0);
    expect(CanvasCursorStatus.UNSPECIFIED).toBe(0);
    expect(CanvasOwnershipOwner.UNSPECIFIED).toBe(0);
    expect(CanvasOwnershipPhase.UNSPECIFIED).toBe(0);
  });
});
