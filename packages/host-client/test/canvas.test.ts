import { describe, expect, it, vi } from "vitest";
import {
  create,
  toBinary,
  fromBinary,
  CanvasCursorStatus,
  CanvasEdgeKind,
  CanvasEntityKind,
  CanvasEventPageSchema,
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
  CanvasOwnershipResponseSchema,
  CanvasNodeSchema,
  CanvasSchema,
  CanvasSnapshotResponseSchema,
  DeleteCanvasRequestSchema,
  DeleteCanvasResponseSchema,
  DeleteCanvasWorkspaceResponseSchema,
  GetCanvasDocumentRequestSchema,
  GetCanvasDocumentResponseSchema,
  ListCanvasesResponseSchema,
  ListCanvasWorkspacesResponseSchema,
  PutCanvasWorkspaceRequestSchema,
  PutCanvasWorkspaceResponseSchema,
  SaveCanvasDocumentRequestSchema,
  SaveCanvasDocumentResponseSchema,
  SubscribeCanvasEventsRequestSchema,
  type Canvas,
  type CanvasNode,
} from "@armadra/protocol";
import {
  HostCanvasClient,
  HostCanvasError,
  classifyCanvasFailure,
} from "../src/canvas.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";
import { HostIdentityError } from "../src/identity.js";

const hostId = "1".repeat(32);
const workspaceId = "workspace-1";
const canvasId = "canvas-1";
/** 2^53 + 1: the first integer a JavaScript number cannot represent. */
const beyondDouble = 9_007_199_254_740_993n;
const maxUint64 = 18_446_744_073_709_551_615n;

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function transport(reply: (call: Sent) => Uint8Array | Promise<Uint8Array>) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return { session, calls };
}

function client(reply: (call: Sent) => Uint8Array | Promise<Uint8Array>) {
  const { session, calls } = transport(reply);
  return { api: new HostCanvasClient({ session, hostId, workspaceId }), calls };
}

function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    ...create(CanvasSchema, {
      canvasId,
      workspaceId,
      name: "默认画布",
      viewport: { x: -0.5, y: 12.25, zoom: 1.5 },
      revision: beyondDouble,
    }),
    ...overrides,
  };
}

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    ...create(CanvasNodeSchema, {
      nodeId: "node-终端",
      canvasId,
      type: "terminal",
      title: "构建",
      position: { x: -1024.5, y: 2048.25 },
      parentId: "node-frame",
      revision: 2n,
    }),
    ...overrides,
  };
}

function documentReply(overrides: Record<string, unknown> = {}) {
  return new Uint8Array(
    toBinary(
      GetCanvasDocumentResponseSchema,
      create(GetCanvasDocumentResponseSchema, {
        document: {
          canvas: canvas(),
          nodes: [node()],
          edges: [
            {
              edgeId: "edge-1",
              canvasId,
              sourceNodeId: "node-终端",
              targetNodeId: "node-frame",
              kind: CanvasEdgeKind.LINK,
              revision: 1n,
            },
          ],
          annotations: [
            {
              annotationId: "annotation-1",
              canvasId,
              nodeId: "node-终端",
              labels: ["构建"],
              note: "备注",
              revision: 1n,
            },
          ],
          eventSequence: beyondDouble,
          ...overrides,
        },
      }),
    ),
  );
}

function saveReply(operationId: string) {
  return new Uint8Array(
    toBinary(
      SaveCanvasDocumentResponseSchema,
      create(SaveCanvasDocumentResponseSchema, {
        document: { canvas: canvas(), nodes: [node()] },
        receipt: {
          operationId,
          transactionId: beyondDouble,
          firstSequence: beyondDouble,
          lastSequence: maxUint64,
          replayed: true,
          revisions: [
            {
              kind: CanvasEntityKind.CANVAS,
              entityId: canvasId,
              revision: 2n,
            },
          ],
        },
      }),
    ),
  );
}

function save(operationId = "canvas/workspace-1/canvas-1/7") {
  return {
    operationId,
    canvas: canvas(),
    expectedRevision: beyondDouble,
    nodes: [node()],
    edges: [],
    annotations: [],
  };
}

describe("HostCanvasClient", () => {
  it("scopes every request to this workspace and Host without carrying identity", async () => {
    const { api, calls } = client(() => documentReply());
    await api.getDocument(canvasId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.service).toBe("CanvasService");
    expect(calls[0]!.action).toBe("GetDocument");
    expect(calls[0]!.mutation).toBe(false);
    const request = fromBinary(GetCanvasDocumentRequestSchema, calls[0]!.body);
    expect(request.meta?.scope?.workspaceId).toBe(workspaceId);
    expect(request.meta?.scope?.hostId).toBe(hostId);
    expect(request.meta?.scope?.executionHostId).toBe(hostId);
    expect(request.meta?.requestId).toBeTruthy();
    expect(request.canvasId).toBe(canvasId);
  });

  it("lists workspaces and canvases as reads", async () => {
    const { api, calls } = client((call) =>
      call.action === "ListWorkspaces"
        ? new Uint8Array(
            toBinary(
              ListCanvasWorkspacesResponseSchema,
              create(ListCanvasWorkspacesResponseSchema, {
                workspaces: [
                  {
                    workspaceId,
                    name: "仓库",
                    rootPath: "/项目/仓库",
                    revision: 4n,
                  },
                ],
                nextId: "workspace-2",
                hasMore: true,
              }),
            ),
          )
        : new Uint8Array(
            toBinary(
              ListCanvasesResponseSchema,
              create(ListCanvasesResponseSchema, {
                canvases: [canvas()],
              }),
            ),
          ),
    );
    const workspaces = await api.listWorkspaces("", 10);
    expect(workspaces.workspaces[0]!.rootPath).toBe("/项目/仓库");
    expect(workspaces.nextId).toBe("workspace-2");
    const canvases = await api.listCanvases("", 10);
    expect(canvases.canvases[0]!.canvasId).toBe(canvasId);
    expect(calls.map((call) => [call.action, call.mutation])).toEqual([
      ["ListWorkspaces", false],
      ["ListCanvases", false],
    ]);
  });

  it("sends workspace and canvas writes as mutations bound to a revision", async () => {
    const { api, calls } = client((call) => {
      if (call.action === "PutWorkspace")
        return new Uint8Array(
          toBinary(
            PutCanvasWorkspaceResponseSchema,
            create(PutCanvasWorkspaceResponseSchema, {
              workspace: { workspaceId, name: "仓库", revision: 5n },
              receipt: { operationId: "canvas/workspace-1/put/1" },
            }),
          ),
        );
      if (call.action === "DeleteWorkspace")
        return new Uint8Array(
          toBinary(
            DeleteCanvasWorkspaceResponseSchema,
            create(DeleteCanvasWorkspaceResponseSchema, {
              workspaceId,
              receipt: { operationId: "canvas/workspace-1/rm/1" },
            }),
          ),
        );
      if (call.action === "DeleteCanvas")
        return new Uint8Array(
          toBinary(
            DeleteCanvasResponseSchema,
            create(DeleteCanvasResponseSchema, {
              canvasId,
              receipt: { operationId: "canvas/workspace-1/canvas-1/rm" },
            }),
          ),
        );
      return saveReply("canvas/workspace-1/canvas-1/7");
    });

    const put = await api.putWorkspace({
      operationId: "canvas/workspace-1/put/1",
      workspace: create(ListCanvasWorkspacesResponseSchema, {
        workspaces: [{ workspaceId, name: "仓库", revision: 4n }],
      }).workspaces[0]!,
      expectedRevision: 4n,
    });
    expect(put.workspace?.revision).toBe(5n);
    const putRequest = fromBinary(
      PutCanvasWorkspaceRequestSchema,
      calls[0]!.body,
    );
    expect(putRequest.expectedRevision).toBe(4n);
    expect(putRequest.meta?.idempotencyKey).toBe("canvas/workspace-1/put/1");

    await api.deleteWorkspace({
      operationId: "canvas/workspace-1/rm/1",
      workspaceId,
      expectedRevision: 5n,
    });
    const saved = await api.saveDocument(save());
    expect(saved.receipt?.replayed).toBe(true);
    const deleted = await api.deleteCanvas({
      operationId: "canvas/workspace-1/canvas-1/rm",
      canvasId,
      expectedRevision: 9n,
    });
    expect(deleted.canvasId).toBe(canvasId);
    const removeRequest = fromBinary(DeleteCanvasRequestSchema, calls[3]!.body);
    expect(removeRequest.expectedRevision).toBe(9n);
    expect(calls.map((call) => [call.action, call.mutation])).toEqual([
      ["PutWorkspace", true],
      ["DeleteWorkspace", true],
      ["SaveDocument", true],
      ["DeleteCanvas", true],
    ]);
  });

  it("sends the operation id the caller chose so a replay is recognised", async () => {
    const { api, calls } = client(() =>
      saveReply("canvas/workspace-1/canvas-1/7"),
    );
    const response = await api.saveDocument(save());
    const request = fromBinary(SaveCanvasDocumentRequestSchema, calls[0]!.body);
    expect(request.operationId).toBe("canvas/workspace-1/canvas-1/7");
    expect(request.expectedRevision).toBe(beyondDouble);
    // The Host answers a replay with the original receipt rather than writing
    // a second time; the flag is what tells the caller nothing new happened.
    expect(response.receipt?.replayed).toBe(true);
    expect(response.receipt?.operationId).toBe(request.operationId);
  });

  it("refuses a receipt that answers a different operation", async () => {
    const { api } = client(() => saveReply("canvas/workspace-1/canvas-1/9"));
    await expect(api.saveDocument(save())).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("refuses a save carrying a node that belongs to another canvas", async () => {
    const { api, calls } = client(() =>
      saveReply("canvas/workspace-1/canvas-1/7"),
    );
    const stray = save();
    stray.nodes = [{ ...stray.nodes[0]!, canvasId: "canvas-9" }];
    await expect(api.saveDocument(stray)).rejects.toMatchObject({
      failure: "invalid",
    });
    expect(calls).toHaveLength(0);
  });

  it("reads a snapshot and the sequence it is consistent with", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasSnapshotResponseSchema,
            create(CanvasSnapshotResponseSchema, {
              sequence: beyondDouble,
              canvases: [canvas()],
              nodes: [node()],
              nextId: "canvas-2",
              hasMore: true,
            }),
          ),
        ),
    );
    const snapshot = await api.getSnapshot("", 10);
    expect(snapshot.sequence).toBe(beyondDouble);
    expect(snapshot.nextId).toBe("canvas-2");
  });

  it("reads the ownership record that decides who may write", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasOwnershipResponseSchema,
            create(CanvasOwnershipResponseSchema, {
              ownership: {
                domain: "canvas",
                owner: CanvasOwnershipOwner.HOST,
                epoch: beyondDouble,
                phase: CanvasOwnershipPhase.SETTLED,
                reasonCode: "ownership.switch.verified",
                revision: 3n,
              },
            }),
          ),
        ),
    );
    const ownership = await api.getOwnership();
    expect(ownership.ownership?.owner).toBe(CanvasOwnershipOwner.HOST);
    expect(ownership.ownership?.epoch).toBe(beyondDouble);
  });

  it("refuses an ownership record that names no epoch", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasOwnershipResponseSchema,
            create(CanvasOwnershipResponseSchema, {
              ownership: { domain: "canvas", epoch: 0n },
            }),
          ),
        ),
    );
    await expect(api.getOwnership()).rejects.toMatchObject({
      failure: "response",
    });
  });

  /* ------------------------------ event cursor ---------------------------- */

  it("hands back an ordered page and the cursor to continue from", async () => {
    const { api, calls } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasEventPageSchema,
            create(CanvasEventPageSchema, {
              status: CanvasCursorStatus.OK,
              events: [
                {
                  sequence: beyondDouble,
                  kind: CanvasEntityKind.NODE,
                  entityId: "node-终端",
                  workspaceId,
                  revision: 2n,
                },
              ],
              nextCursor: beyondDouble,
              minCursor: 1n,
              highWatermark: beyondDouble,
            }),
          ),
        ),
    );
    const feed = await api.subscribeEvents(1n, 10);
    expect(feed.status).toBe("ok");
    if (feed.status !== "ok") throw new Error("unreachable");
    expect(feed.events[0]!.sequence).toBe(beyondDouble);
    expect(feed.nextCursor).toBe(beyondDouble);
    const request = fromBinary(
      SubscribeCanvasEventsRequestSchema,
      calls[0]!.body,
    );
    expect(request.afterSequence).toBe(1n);
  });

  it("surfaces SNAPSHOT_REQUIRED as its own result, not an empty page", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasEventPageSchema,
            create(CanvasEventPageSchema, {
              status: CanvasCursorStatus.SNAPSHOT_REQUIRED,
              minCursor: beyondDouble,
              highWatermark: maxUint64,
            }),
          ),
        ),
    );
    const feed = await api.subscribeEvents(1n, 10);
    expect(feed).toEqual({
      status: "snapshotRequired",
      minCursor: beyondDouble,
      highWatermark: maxUint64,
    });
  });

  it("surfaces CURSOR_AHEAD instead of rewinding to the watermark", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasEventPageSchema,
            create(CanvasEventPageSchema, {
              status: CanvasCursorStatus.CURSOR_AHEAD,
              minCursor: 1n,
              highWatermark: 2n,
            }),
          ),
        ),
    );
    const feed = await api.subscribeEvents(beyondDouble, 10);
    expect(feed).toEqual({
      status: "cursorAhead",
      minCursor: 1n,
      highWatermark: 2n,
    });
  });

  it("refuses an unspecified cursor status rather than applying it as OK", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(CanvasEventPageSchema, create(CanvasEventPageSchema, {})),
        ),
    );
    await expect(api.subscribeEvents(0n, 10)).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("refuses an event page that repeats or rewinds a sequence", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            CanvasEventPageSchema,
            create(CanvasEventPageSchema, {
              status: CanvasCursorStatus.OK,
              events: [
                { sequence: 5n, entityId: "node-1" },
                { sequence: 5n, entityId: "node-2" },
              ],
              nextCursor: 5n,
            }),
          ),
        ),
    );
    await expect(api.subscribeEvents(4n, 10)).rejects.toMatchObject({
      failure: "response",
    });
  });

  /* -------------------------------- guards -------------------------------- */

  it("rejects a page longer than the limit it asked for", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ListCanvasesResponseSchema,
            create(ListCanvasesResponseSchema, {
              canvases: [canvas(), canvas({ canvasId: "canvas-2" })],
            }),
          ),
        ),
    );
    await expect(api.listCanvases("", 1)).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("rejects a hasMore page that hands back the cursor it was given", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ListCanvasesResponseSchema,
            create(ListCanvasesResponseSchema, {
              canvases: [canvas()],
              nextId: "canvas-cursor",
              hasMore: true,
            }),
          ),
        ),
    );
    await expect(api.listCanvases("canvas-cursor", 10)).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("rejects a document that answers about a different canvas", async () => {
    const { api } = client(() =>
      documentReply({ canvas: canvas({ canvasId: "canvas-9" }) }),
    );
    await expect(api.getDocument(canvasId)).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("rejects a document holding a node from another canvas", async () => {
    const { api } = client(() =>
      documentReply({ nodes: [node({ canvasId: "canvas-9" })] }),
    );
    await expect(api.getDocument(canvasId)).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("rejects a document whose canvas row never decoded", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            GetCanvasDocumentResponseSchema,
            create(GetCanvasDocumentResponseSchema, {}),
          ),
        ),
    );
    await expect(api.getDocument(canvasId)).rejects.toBeInstanceOf(
      HostCanvasError,
    );
  });

  it("refuses a deletion that does not name the revision it read", async () => {
    const { api, calls } = client(() => new Uint8Array());
    await expect(
      api.deleteCanvas({
        operationId: "canvas/workspace-1/canvas-1/rm",
        canvasId,
        expectedRevision: 0n,
      }),
    ).rejects.toMatchObject({ failure: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses construction against an id that is not this Host", () => {
    const { session } = transport(() => new Uint8Array());
    expect(
      () => new HostCanvasClient({ session, hostId: "nope", workspaceId }),
    ).toThrow(HostCanvasError);
  });

  /* ------------------------------- 64-bit ---------------------------------- */

  it("keeps revisions, epochs and sequences exact at 2^53+1 and 2^64-1", async () => {
    const { api, calls } = client(() =>
      documentReply({
        canvas: canvas({ revision: maxUint64 }),
        nodes: [node({ revision: beyondDouble })],
        eventSequence: maxUint64,
      }),
    );
    const document = await api.getDocument(canvasId);
    expect(document.canvas!.revision).toBe(maxUint64);
    expect(document.nodes[0]!.revision).toBe(beyondDouble);
    expect(document.eventSequence).toBe(maxUint64);
    // Routing either value through Number lands on a neighbour, which is why
    // nothing between the wire and the caller is allowed to do it.
    expect(BigInt(Number(document.canvas!.revision))).not.toBe(maxUint64);
    expect(BigInt(Number(document.nodes[0]!.revision))).toBe(
      9_007_199_254_740_992n,
    );
    expect(calls).toHaveLength(1);
  });

  it("sends a 2^64-1 expected revision on the wire unchanged", async () => {
    const { api, calls } = client(() =>
      saveReply("canvas/workspace-1/canvas-1/7"),
    );
    const input = save();
    input.expectedRevision = maxUint64;
    await api.saveDocument(input);
    expect(
      fromBinary(SaveCanvasDocumentRequestSchema, calls[0]!.body)
        .expectedRevision,
    ).toBe(maxUint64);
  });

  /* ----------------------------- unknown outcome --------------------------- */

  it("flags a mutation whose result was never read as outcomeUnknown", async () => {
    const session: HostAuthenticatedTransport = {
      send: vi.fn().mockRejectedValue(new HostIdentityError("TIMEOUT", true)),
    };
    const api = new HostCanvasClient({ session, hostId, workspaceId });
    const failure = await api.saveDocument(save()).catch((error) => error);
    expect(failure).toBeInstanceOf(HostCanvasError);
    expect(failure.outcomeUnknown).toBe(true);
    expect(failure.failure).toBe("cancelled");
  });

  it("flags an undecodable mutation reply as an unknown outcome too", async () => {
    const { api } = client(() => new Uint8Array([0xff, 0xff, 0xff]));
    const failure = await api.saveDocument(save()).catch((error) => error);
    expect(failure.failure).toBe("response");
    expect(failure.outcomeUnknown).toBe(true);
  });

  it("does not flag a read whose reply was undecodable", async () => {
    const { api } = client(() => new Uint8Array([0xff, 0xff, 0xff]));
    const failure = await api.getDocument(canvasId).catch((error) => error);
    expect(failure.failure).toBe("response");
    expect(failure.outcomeUnknown).toBe(false);
  });
});

describe("classifyCanvasFailure", () => {
  const cases: [string, HostIdentityError, string][] = [
    [
      "an expired session",
      new HostIdentityError("REMOTE_ERROR", false, 401, "UNAUTHENTICATED"),
      "unauthenticated",
    ],
    [
      "a scope the device does not hold",
      new HostIdentityError("REMOTE_ERROR", false, 403, "PERMISSION_DENIED"),
      "permission",
    ],
    [
      "a Host that has not assembled the canvas surface",
      new HostIdentityError("REMOTE_ERROR", false, 501, "UNSUPPORTED"),
      "unsupported",
    ],
    [
      "a canvas that moved on",
      new HostIdentityError("REMOTE_ERROR", false, 409, "CONFLICT"),
      "conflict",
    ],
    [
      "a canvas that is gone",
      new HostIdentityError("REMOTE_ERROR", false, 404, "NOT_FOUND"),
      "notFound",
    ],
    [
      "a request the Host rejected",
      new HostIdentityError("REMOTE_ERROR", false, 400, "INVALID_ARGUMENT"),
      "invalid",
    ],
    [
      "an undecodable body",
      new HostIdentityError("MALFORMED_RESPONSE", false, 200),
      "response",
    ],
    [
      "a body past the frame limit",
      new HostIdentityError("RESPONSE_TOO_LARGE", false, 200),
      "response",
    ],
    ["a dropped connection", new HostIdentityError("NETWORK_ERROR"), "network"],
    ["an aborted call", new HostIdentityError("CANCELLED"), "cancelled"],
    [
      "misconfigured options",
      new HostIdentityError("INVALID_OPTIONS"),
      "invalid",
    ],
  ];
  for (const [name, error, failure] of cases) {
    it(`maps ${name} to ${failure}`, () => {
      expect(classifyCanvasFailure(error).failure).toBe(failure);
    });
  }

  it("never softens an unknown remote code into a client mistake", () => {
    const classified = classifyCanvasFailure(
      new HostIdentityError("REMOTE_ERROR", true, 500, "UNKNOWN_OUTCOME"),
    );
    expect(classified.failure).toBe("network");
    expect(classified.outcomeUnknown).toBe(true);
  });

  it("treats a foreign error as a transport failure, not a Host answer", () => {
    const classified = classifyCanvasFailure(new Error("boom"));
    expect(classified.failure).toBe("network");
    expect(classified.hostCode).toBeUndefined();
  });

  it("passes an already-classified failure through unchanged", () => {
    const original = new HostCanvasError("conflict");
    expect(classifyCanvasFailure(original)).toBe(original);
  });

  it("classifies a transport rejection raised inside a call", async () => {
    const session: HostAuthenticatedTransport = {
      send: vi
        .fn()
        .mockRejectedValue(
          new HostIdentityError("REMOTE_ERROR", false, 501, "UNSUPPORTED"),
        ),
    };
    const api = new HostCanvasClient({ session, hostId, workspaceId });
    await expect(api.listCanvases()).rejects.toMatchObject({
      failure: "unsupported",
    });
  });
});
