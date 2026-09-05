import {
  create,
  fromBinary,
  toBinary,
  CanvasCursorStatus,
  CanvasOwnershipResponseSchema,
  CanvasEventPageSchema,
  CanvasSnapshotResponseSchema,
  DeleteCanvasRequestSchema,
  DeleteCanvasResponseSchema,
  DeleteCanvasWorkspaceRequestSchema,
  DeleteCanvasWorkspaceResponseSchema,
  GetCanvasDocumentRequestSchema,
  GetCanvasDocumentResponseSchema,
  GetCanvasOwnershipRequestSchema,
  GetCanvasSnapshotRequestSchema,
  ListCanvasesRequestSchema,
  ListCanvasesResponseSchema,
  ListCanvasWorkspacesRequestSchema,
  ListCanvasWorkspacesResponseSchema,
  PutCanvasWorkspaceRequestSchema,
  PutCanvasWorkspaceResponseSchema,
  SaveCanvasDocumentRequestSchema,
  SaveCanvasDocumentResponseSchema,
  SubscribeCanvasEventsRequestSchema,
  type Canvas,
  type CanvasAnnotation,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasEventEnvelope,
  type CanvasNode,
  type CanvasOwnershipResponse,
  type CanvasSnapshotResponse,
  type CanvasWorkspace,
  type DeleteCanvasResponse,
  type DeleteCanvasWorkspaceResponse,
  type ListCanvasesResponse,
  type ListCanvasWorkspacesResponse,
  type PutCanvasWorkspaceResponse,
  type SaveCanvasDocumentResponse,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { HostIdentityError } from "./identity.js";

export type {
  Canvas,
  CanvasAnnotation,
  CanvasAssetRef,
  CanvasDocument,
  CanvasEdge,
  CanvasEventEnvelope,
  CanvasNode,
  CanvasOperationReceipt,
  CanvasOwnership,
  CanvasOwnershipResponse,
  CanvasSnapshotResponse,
  CanvasWorkspace,
} from "@armadra/protocol";
export {
  CanvasCursorStatus,
  CanvasEdgeKind,
  CanvasEntityKind,
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
} from "@armadra/protocol";

const SERVICE = "CanvasService";
const MAX_PAGE = 200;

/**
 * What went wrong, in terms a caller can act on. Deliberately not the HTTP
 * status: re-authenticating, reloading a revision and telling the user this
 * Host does not own the canvas are three different repairs.
 */
export type HostCanvasFailure =
  | "invalid"
  | "unauthenticated"
  | "permission"
  | "unsupported"
  | "notFound"
  | "conflict"
  | "response"
  | "cancelled"
  | "network";

/** Carries only stable metadata; never a response body, token or URL. */
export class HostCanvasError extends Error {
  readonly name = "HostCanvasError";
  constructor(
    readonly failure: HostCanvasFailure,
    /** A mutation that reached the Host but whose result was never read. */
    readonly outcomeUnknown = false,
    readonly httpStatus?: number,
    readonly hostCode?: string,
  ) {
    super(`Host canvas request failed (${failure}).`);
  }
}

export interface HostCanvasClientOptions {
  session: HostAuthenticatedTransport;
  /** This Host's id; it is also the only execution host a canvas may name. */
  hostId: string;
  workspaceId: string;
}

const idPattern = /^[0-9a-f]{32}$/;
const scopedId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/**
 * Operation ids are path-shaped (`canvas/<workspace>/<canvas>/<n>`) so a
 * replay is recognisable by a human reading a log, hence the extra `/`.
 */
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

function reject(failure: HostCanvasFailure): never {
  throw new HostCanvasError(failure);
}

/**
 * Maps a transport failure onto a repair. An UNKNOWN or unrecognised remote
 * code is never softened into "invalid": a mutation whose outcome was not read
 * stays flagged so the caller reloads instead of silently replaying with new
 * content, which the Host would answer as a CONFLICT.
 */
export function classifyCanvasFailure(error: unknown): HostCanvasError {
  if (error instanceof HostCanvasError) return error;
  if (!(error instanceof HostIdentityError))
    return new HostCanvasError("network");
  const { code, hostCode, httpStatus, outcomeUnknown } = error;
  const fail = (failure: HostCanvasFailure) =>
    new HostCanvasError(failure, outcomeUnknown, httpStatus, hostCode);
  if (code === "CANCELLED" || code === "TIMEOUT") return fail("cancelled");
  if (code === "INVALID_OPTIONS") return fail("invalid");
  if (
    code === "MALFORMED_RESPONSE" ||
    code === "RESPONSE_TOO_LARGE" ||
    code === "UNEXPECTED_CONTENT_TYPE"
  )
    return fail("response");
  if (code !== "REMOTE_ERROR") return fail("network");
  switch (hostCode) {
    case "UNAUTHENTICATED":
      return fail("unauthenticated");
    case "PERMISSION_DENIED":
      return fail("permission");
    case "UNSUPPORTED":
      return fail("unsupported");
    case "NOT_FOUND":
      return fail("notFound");
    case "CONFLICT":
      return fail("conflict");
    case "INVALID_ARGUMENT":
      return fail("invalid");
    default:
      return fail("network");
  }
}

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `canvas-${Date.now().toString(36)}-${counter}`;
}

function page(
  after: string,
  limit: number,
): { afterId: string; limit: number } {
  if (
    typeof after !== "string" ||
    after.length > 200 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE
  )
    reject("invalid");
  return { afterId: after, limit };
}

/**
 * A page of business events, or the reason there is none to hand over.
 *
 * The two failure shapes are separate results rather than an empty page,
 * because they need opposite repairs: `snapshotRequired` means the cursor fell
 * below the retained floor and the caller has to re-seed from a snapshot;
 * `cursorAhead` means the caller has applied sequences this Host has never
 * issued — a restored database or a different Host — and rewinding to the
 * watermark would silently discard work.
 */
export type CanvasEventFeed =
  | {
      status: "ok";
      events: CanvasEventEnvelope[];
      nextCursor: bigint;
      minCursor: bigint;
      highWatermark: bigint;
      hasMore: boolean;
    }
  | { status: "snapshotRequired"; minCursor: bigint; highWatermark: bigint }
  | { status: "cursorAhead"; minCursor: bigint; highWatermark: bigint };

export interface SaveCanvasDocumentInput {
  /**
   * Caller-chosen and stable for one logical save. Replaying it with the same
   * content returns the original receipt with `replayed: true` and writes
   * nothing; reusing it with different content is a CONFLICT, never a second
   * write. A retry after an unknown outcome must therefore reuse the id it
   * already sent rather than mint a new one.
   */
  operationId: string;
  canvas: Canvas;
  /** The revision the caller read. 0 states "this canvas never existed". */
  expectedRevision: bigint;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  annotations: CanvasAnnotation[];
}

/**
 * Typed access to the Host's authenticated canvas surface (H01).
 *
 * Every call is scoped to one workspace and this Host; the session supplies the
 * principal, so nothing here carries identity. Responses are validated before
 * they reach the UI: a canvas rendered from a half-decoded document would be
 * claiming the Host said something it did not, and a save issued against a
 * document that was never fully read would destroy the part that was dropped.
 *
 * 64-bit values (revisions, epochs, sequences, timestamps) stay `bigint` from
 * the wire to the caller. Routing them through `Number` or `JSON` would round
 * every revision above 2^53 onto its neighbour, which is exactly the value
 * range a CAS check depends on.
 */
export class HostCanvasClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

  constructor(options: HostCanvasClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "") ||
      !scopedId.test(options.workspaceId ?? "")
    )
      reject("invalid");
    this.#session = options.session;
    this.#hostId = options.hostId;
    this.#workspaceId = options.workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }
  get hostId(): string {
    return this.#hostId;
  }

  #meta(operationId = "") {
    return {
      requestId: requestId(),
      scope: {
        hostId: this.#hostId,
        workspaceId: this.#workspaceId,
        executionHostId: this.#hostId,
      },
      // The Host deduplicates on the operation id; naming it here too lets the
      // generic request log show the same key without decoding the body.
      idempotencyKey: operationId,
    };
  }

  async #call<T>(
    action: string,
    body: Uint8Array,
    mutation: boolean,
    decode: (wire: Uint8Array) => T,
  ): Promise<T> {
    let wire: Uint8Array;
    try {
      wire = await this.#session.send(SERVICE, action, body, mutation);
    } catch (error) {
      throw classifyCanvasFailure(error);
    }
    try {
      return decode(wire);
    } catch (error) {
      if (error instanceof HostCanvasError) throw error;
      throw new HostCanvasError("response", mutation);
    }
  }

  /* ------------------------------ workspaces ----------------------------- */

  async listWorkspaces(
    afterId = "",
    limit = 50,
  ): Promise<ListCanvasWorkspacesResponse> {
    const bounds = page(afterId, limit);
    const request = create(ListCanvasWorkspacesRequestSchema, {
      meta: this.#meta(),
      ...bounds,
    });
    return this.#call(
      "ListWorkspaces",
      toBinary(ListCanvasWorkspacesRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListCanvasWorkspacesResponseSchema, wire);
        if (value.workspaces.length > bounds.limit) reject("response");
        for (const workspace of value.workspaces) this.#workspace(workspace);
        this.#cursor(value.hasMore, value.nextId, afterId);
        return value;
      },
    );
  }

  async putWorkspace(input: {
    operationId: string;
    workspace: CanvasWorkspace;
    expectedRevision: bigint;
  }): Promise<PutCanvasWorkspaceResponse> {
    if (
      !operationIdPattern.test(input?.operationId ?? "") ||
      !input.workspace ||
      !scopedId.test(input.workspace.workspaceId ?? "") ||
      !revisionOf(input.expectedRevision)
    )
      reject("invalid");
    const request = create(PutCanvasWorkspaceRequestSchema, {
      meta: this.#meta(input.operationId),
      operationId: input.operationId,
      workspace: input.workspace,
      expectedRevision: input.expectedRevision,
    });
    const wanted = input.workspace.workspaceId;
    return this.#call(
      "PutWorkspace",
      toBinary(PutCanvasWorkspaceRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(PutCanvasWorkspaceResponseSchema, wire);
        if (!value.workspace || value.workspace.workspaceId !== wanted)
          reject("response");
        this.#workspace(value.workspace);
        this.#receipt(value.receipt?.operationId, input.operationId);
        return value;
      },
    );
  }

  async deleteWorkspace(input: {
    operationId: string;
    workspaceId: string;
    expectedRevision: bigint;
  }): Promise<DeleteCanvasWorkspaceResponse> {
    if (
      !operationIdPattern.test(input?.operationId ?? "") ||
      !scopedId.test(input.workspaceId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      // A deletion leaves a revisioned tombstone, so it must name the revision
      // it read; expected 0 would mean "never created" and delete nothing.
      input.expectedRevision <= 0n
    )
      reject("invalid");
    const request = create(DeleteCanvasWorkspaceRequestSchema, {
      meta: this.#meta(input.operationId),
      operationId: input.operationId,
      workspaceId: input.workspaceId,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "DeleteWorkspace",
      toBinary(DeleteCanvasWorkspaceRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(DeleteCanvasWorkspaceResponseSchema, wire);
        if (value.workspaceId !== input.workspaceId) reject("response");
        this.#receipt(value.receipt?.operationId, input.operationId);
        return value;
      },
    );
  }

  /* -------------------------------- canvases ----------------------------- */

  async listCanvases(afterId = "", limit = 50): Promise<ListCanvasesResponse> {
    const bounds = page(afterId, limit);
    const request = create(ListCanvasesRequestSchema, {
      meta: this.#meta(),
      ...bounds,
    });
    return this.#call(
      "ListCanvases",
      toBinary(ListCanvasesRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListCanvasesResponseSchema, wire);
        if (value.canvases.length > bounds.limit) reject("response");
        for (const canvas of value.canvases) this.#canvas(canvas);
        this.#cursor(value.hasMore, value.nextId, afterId);
        return value;
      },
    );
  }

  /** Reads one canvas whole: its row, nodes, edges and annotations. */
  async getDocument(canvasId: string): Promise<CanvasDocument> {
    if (!scopedId.test(canvasId ?? "")) reject("invalid");
    const request = create(GetCanvasDocumentRequestSchema, {
      meta: this.#meta(),
      canvasId,
    });
    return this.#call(
      "GetDocument",
      toBinary(GetCanvasDocumentRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(GetCanvasDocumentResponseSchema, wire);
        return this.#document(value.document, canvasId);
      },
    );
  }

  /**
   * Writes one canvas in one transaction. See `SaveCanvasDocumentInput` for
   * why the operation id is the caller's and must survive a retry unchanged.
   */
  async saveDocument(
    input: SaveCanvasDocumentInput,
  ): Promise<SaveCanvasDocumentResponse> {
    if (
      !operationIdPattern.test(input?.operationId ?? "") ||
      !input.canvas ||
      !scopedId.test(input.canvas.canvasId ?? "") ||
      !revisionOf(input.expectedRevision) ||
      !Array.isArray(input.nodes) ||
      !Array.isArray(input.edges) ||
      !Array.isArray(input.annotations)
    )
      reject("invalid");
    const canvasId = input.canvas.canvasId;
    // A child that names another canvas would be written into this one's
    // transaction and become unreachable from the canvas it belongs to.
    for (const node of input.nodes)
      if (node.canvasId !== canvasId) reject("invalid");
    for (const edge of input.edges)
      if (edge.canvasId !== canvasId) reject("invalid");
    for (const annotation of input.annotations)
      if (annotation.canvasId !== canvasId) reject("invalid");
    const request = create(SaveCanvasDocumentRequestSchema, {
      meta: this.#meta(input.operationId),
      operationId: input.operationId,
      canvas: input.canvas,
      expectedRevision: input.expectedRevision,
      nodes: input.nodes,
      edges: input.edges,
      annotations: input.annotations,
    });
    return this.#call(
      "SaveDocument",
      toBinary(SaveCanvasDocumentRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(SaveCanvasDocumentResponseSchema, wire);
        this.#document(value.document, canvasId);
        this.#receipt(value.receipt?.operationId, input.operationId);
        return value;
      },
    );
  }

  async deleteCanvas(input: {
    operationId: string;
    canvasId: string;
    expectedRevision: bigint;
  }): Promise<DeleteCanvasResponse> {
    if (
      !operationIdPattern.test(input?.operationId ?? "") ||
      !scopedId.test(input.canvasId ?? "") ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      reject("invalid");
    const request = create(DeleteCanvasRequestSchema, {
      meta: this.#meta(input.operationId),
      operationId: input.operationId,
      canvasId: input.canvasId,
      expectedRevision: input.expectedRevision,
    });
    return this.#call(
      "DeleteCanvas",
      toBinary(DeleteCanvasRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(DeleteCanvasResponseSchema, wire);
        if (value.canvasId !== input.canvasId) reject("response");
        this.#receipt(value.receipt?.operationId, input.operationId);
        return value;
      },
    );
  }

  /* --------------------------------- events ------------------------------ */

  /** `afterSequence` is exclusive: the last sequence already applied. */
  async subscribeEvents(
    afterSequence: bigint,
    limit = 200,
  ): Promise<CanvasEventFeed> {
    if (
      typeof afterSequence !== "bigint" ||
      afterSequence < 0n ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE
    )
      reject("invalid");
    const request = create(SubscribeCanvasEventsRequestSchema, {
      meta: this.#meta(),
      afterSequence,
      limit,
    });
    return this.#call(
      "SubscribeEvents",
      toBinary(SubscribeCanvasEventsRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(CanvasEventPageSchema, wire);
        const common = {
          minCursor: value.minCursor,
          highWatermark: value.highWatermark,
        };
        if (value.status === CanvasCursorStatus.SNAPSHOT_REQUIRED)
          return { status: "snapshotRequired" as const, ...common };
        if (value.status === CanvasCursorStatus.CURSOR_AHEAD)
          return { status: "cursorAhead" as const, ...common };
        // An unspecified or unknown status is not "probably fine": treating it
        // as OK would apply an empty page and advance the cursor past events
        // this client never saw.
        if (value.status !== CanvasCursorStatus.OK) reject("response");
        if (value.events.length > limit) reject("response");
        let previous = afterSequence;
        for (const event of value.events) {
          // The stream is one durable sequence; out-of-order or repeated
          // sequences mean the page cannot be applied as a prefix.
          if (event.sequence <= previous || !event.entityId) reject("response");
          previous = event.sequence;
        }
        if (value.nextCursor < previous) reject("response");
        if (value.hasMore && value.nextCursor <= afterSequence)
          reject("response");
        return {
          status: "ok" as const,
          events: value.events,
          nextCursor: value.nextCursor,
          hasMore: value.hasMore,
          ...common,
        };
      },
    );
  }

  /** A paged re-seed plus the sequence the pages are consistent with. */
  async getSnapshot(
    afterId = "",
    limit = 200,
  ): Promise<CanvasSnapshotResponse> {
    const bounds = page(afterId, limit);
    const request = create(GetCanvasSnapshotRequestSchema, {
      meta: this.#meta(),
      ...bounds,
    });
    return this.#call(
      "GetSnapshot",
      toBinary(GetCanvasSnapshotRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(CanvasSnapshotResponseSchema, wire);
        const rows =
          value.workspaces.length +
          value.canvases.length +
          value.nodes.length +
          value.edges.length +
          value.annotations.length;
        if (rows > bounds.limit) reject("response");
        for (const workspace of value.workspaces) this.#workspace(workspace);
        for (const canvas of value.canvases) this.#canvas(canvas);
        this.#cursor(value.hasMore, value.nextId, afterId);
        return value;
      },
    );
  }

  /* ------------------------------- ownership ----------------------------- */

  /**
   * Which process may write the canvas domain, and under which epoch. Read
   * before a write is routed; there is no dual-write mode to fall back on.
   */
  async getOwnership(): Promise<CanvasOwnershipResponse> {
    const request = create(GetCanvasOwnershipRequestSchema, {
      meta: this.#meta(),
    });
    return this.#call(
      "GetOwnership",
      toBinary(GetCanvasOwnershipRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(CanvasOwnershipResponseSchema, wire);
        const ownership = value.ownership;
        // An ownership record with no domain or a zero epoch names no owner at
        // all; acting on it would pick a writer by accident.
        if (
          !ownership ||
          ownership.domain !== "canvas" ||
          ownership.epoch <= 0n
        )
          reject("response");
        return value;
      },
    );
  }

  /* ------------------------------- validation ---------------------------- */

  #cursor(hasMore: boolean, nextId: string, afterId: string): void {
    // A "there is more" page that hands back the cursor it was given (or none)
    // would make the caller loop forever on the same rows.
    if (hasMore && (!nextId || nextId === afterId)) reject("response");
  }

  #receipt(operationId: string | undefined, expected: string): void {
    if (operationId !== expected) reject("response");
  }

  #workspace(workspace: CanvasWorkspace): CanvasWorkspace {
    if (!workspace.workspaceId || workspace.revision <= 0n) reject("response");
    return workspace;
  }

  #canvas(canvas: Canvas): Canvas {
    if (
      !canvas.canvasId ||
      canvas.workspaceId !== this.#workspaceId ||
      canvas.revision <= 0n
    )
      reject("response");
    return canvas;
  }

  /** A document missing its canvas row, or holding a stray child, is not a
   * document: saving it back would drop whatever failed to decode. */
  #document(
    document: CanvasDocument | undefined,
    canvasId: string,
  ): CanvasDocument {
    if (!document?.canvas || document.canvas.canvasId !== canvasId)
      reject("response");
    this.#canvas(document.canvas);
    for (const node of document.nodes)
      if (!node.nodeId || node.canvasId !== canvasId) reject("response");
    for (const edge of document.edges)
      if (!edge.edgeId || edge.canvasId !== canvasId) reject("response");
    for (const annotation of document.annotations)
      if (!annotation.annotationId || annotation.canvasId !== canvasId)
        reject("response");
    return document;
  }
}

/** Expected revision 0 is legitimate ("never created"); a negative one is not. */
function revisionOf(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}
