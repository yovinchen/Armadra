// The comparison layer of the canvas ownership end-to-end check.
//
// Both sides of a migration describe the same canvas in their own vocabulary:
// the Runtime's camelCase JSON board and the Host's typed protobuf document.
// This module reduces each of them to one shape and hashes it, so a step can
// assert "the canvas survived" with a digest rather than with the absence of an
// exception. Nothing here talks to a process, so it is the part of the script
// that can be read on its own.
import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Object keys in one order, so two structurally equal payloads hash alike. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

/**
 * Exactly the facts a migration has to preserve: identity, geometry, frame
 * nesting, annotations, the opaque per-type payload, the link endpoints and the
 * whiteboard's digest. Timestamps and sort order are deliberately absent — they
 * are represented differently on the two sides, and comparing their spelling
 * would fail on a migration that lost nothing.
 */
export function canonical(shape) {
  return stable({
    canvas: shape.name,
    whiteboard: sha256(shape.whiteboard),
    nodes: [...shape.nodes]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((value) => ({
        id: value.id,
        type: value.type,
        title: value.title,
        color: value.color,
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        parentId: value.parentId,
        labels: value.labels,
        note: value.note,
        data: value.data,
      })),
    edges: [...shape.edges]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((value) => ({
        id: value.id,
        source: value.source,
        target: value.target,
        kind: value.kind,
      })),
  });
}

export const digestOf = (shape) => sha256(JSON.stringify(canonical(shape)));

/** A refusal the client mapped, spelled out so a failing step names the repair. */
export const refusal = (value) =>
  value?.error
    ? ` refused=${value.error.failure}/${value.error.hostCode || "-"} HTTP ${value.error.httpStatus}`
    : "";

/** The Runtime's camelCase board document, reduced to the canonical shape. */
export function runtimeShape(document) {
  return {
    name: document.board.name,
    whiteboard: document.board.whiteboard ?? "",
    nodes: document.nodes.map((value) => ({
      id: value.id,
      type: value.type,
      title: value.title,
      color: value.color,
      x: value.position.x,
      y: value.position.y,
      width: value.size?.width ?? null,
      height: value.size?.height ?? null,
      parentId: value.parentId ?? "",
      labels: value.labels ?? [],
      note: value.note ?? "",
      data: stable(value.data),
    })),
    edges: document.edges.map((value) => ({
      id: value.id,
      source: value.source,
      target: value.target,
      kind: value.kind,
    })),
  };
}

export const text = (bytes) =>
  new TextDecoder().decode(Uint8Array.from(bytes ?? new Uint8Array()));

/**
 * The Host's typed document, reduced to the same shape. Labels and the note
 * live in their own annotation object there, and the payload travels as opaque
 * bytes, so both are folded back before the digest is taken; if the projection
 * dropped an annotation or re-encoded a payload the two digests stop matching.
 */
export function hostShape(document) {
  const annotations = new Map(
    document.annotations.map((value) => [value.nodeId, value]),
  );
  return {
    name: document.canvas.name,
    whiteboard: document.canvas.whiteboard
      ? text(document.canvas.whiteboard.snapshot)
      : "",
    nodes: document.nodes.map((value) => ({
      id: value.nodeId,
      type: value.type,
      title: value.title,
      color: value.color,
      x: value.position?.x ?? 0,
      y: value.position?.y ?? 0,
      width: value.size?.width ?? null,
      height: value.size?.height ?? null,
      parentId: value.parentId ?? "",
      labels: annotations.get(value.nodeId)?.labels ?? [],
      note: annotations.get(value.nodeId)?.note ?? "",
      data: stable(JSON.parse(text(value.dataJson))),
    })),
    edges: document.edges.map((value) => ({
      id: value.edgeId,
      source: value.sourceNodeId,
      target: value.targetNodeId,
      // 1 is CANVAS_EDGE_KIND_LINK; spelled as the Runtime spells it so the
      // two canonical documents can be compared byte for byte.
      kind: value.kind === 1 ? "link" : `kind-${value.kind}`,
    })),
  };
}
