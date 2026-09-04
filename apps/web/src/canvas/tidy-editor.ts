import type {
  Editor,
  TLArrowBinding,
  TLShape,
  TLShapeId,
  TLShapePartial,
} from "tldraw";

import { boundingBox, type Box } from "./geometry";
import { tidy, ROW_GAP, type TidyLink, type TidyOptions } from "./tidy";
import { isLinkShape } from "./shapes/link-shape";

interface LayoutItem {
  shape: TLShape;
  bounds: Box;
}

function finiteBounds(bounds: Box | undefined): bounds is Box {
  return (
    !!bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
}

function visible(editor: Editor, shape: TLShape): boolean {
  if (editor.isShapeHidden(shape)) return false;
  let current: TLShape | undefined = shape;
  const visited = new Set<TLShapeId>();
  while (current && !visited.has(current.id)) {
    if (current.opacity === 0) return false;
    visited.add(current.id);
    current = editor.getShape(current.parentId as TLShapeId);
  }
  return true;
}

function connector(editor: Editor, shape: TLShape): boolean {
  return (
    isLinkShape(shape) ||
    (shape.type === "arrow" &&
      editor.getBindingsFromShape(shape.id, "arrow").length > 0)
  );
}

/** A frame or native group moves once, carrying its descendants unchanged. */
function rootOf(
  id: TLShapeId,
  shapes: Map<TLShapeId, TLShape>,
  pageId: string,
): TLShapeId | undefined {
  const visited = new Set<TLShapeId>();
  let shape = shapes.get(id);
  while (shape && !visited.has(shape.id)) {
    if (shape.parentId === pageId) return shape.id;
    visited.add(shape.id);
    shape = shapes.get(shape.parentId as TLShapeId);
  }
  return undefined;
}

function overlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Keep locked objects where they are. Move the packed block below an obstacle
 * only when it intersects, preserving the existing scene origin otherwise.
 * The candidate moves monotonically down; each obstacle is crossed at most once.
 */
function clearObstacles(packed: Box, obstacles: Box[]): Box {
  let candidate = { ...packed };
  for (let pass = 0; pass < obstacles.length; pass += 1) {
    const hits = obstacles.filter((obstacle) => overlap(candidate, obstacle));
    if (hits.length === 0) break;
    candidate = {
      ...candidate,
      y: Math.max(...hits.map((hit) => hit.y + hit.height)) + ROW_GAP,
    };
  }
  return candidate;
}

/**
 * Global tidy works from the editor, not the partial CanvasNode projection.
 * Selection and viewport culling do not restrict this command. Hidden shapes
 * are ignored, locked roots remain fixed, and bound connectors follow endpoints.
 */
export function editorTidyUpdates(
  editor: Editor,
  options: TidyOptions = {},
): TLShapePartial[] {
  if (editor.getIsReadonly()) return [];
  const shapes = editor.getCurrentPageShapes();
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const pageId = editor.getCurrentPageId();
  const roots = shapes.filter(
    (shape) =>
      shape.parentId === pageId &&
      visible(editor, shape) &&
      !connector(editor, shape),
  );
  const movable: LayoutItem[] = [];
  const fixed: Box[] = [];
  for (const shape of roots) {
    const bounds = editor.getShapePageBounds(shape.id);
    if (!finiteBounds(bounds)) continue;
    if (
      editor.isShapeOrAncestorLocked(shape) ||
      !editor
        .getShapeUtil(shape)
        .canBeLaidOut(shape, { type: "pack", shapes: roots })
    ) {
      fixed.push(bounds);
    } else {
      movable.push({ shape, bounds });
    }
  }
  if (movable.length === 0) return [];
  // Reading order, not z-index: bringing an object to front must not reshuffle it.
  movable.sort(
    (a, b) =>
      a.bounds.y - b.bounds.y ||
      a.bounds.x - b.bounds.x ||
      a.shape.id.localeCompare(b.shape.id),
  );
  const links: TidyLink[] = [];
  const addLink = (from: TLShapeId, to: TLShapeId) => {
    const source = rootOf(from, byId, pageId);
    const target = rootOf(to, byId, pageId);
    if (source && target && source !== target) links.push({ source, target });
  };
  for (const shape of shapes) {
    if (!visible(editor, shape)) continue;
    if (isLinkShape(shape)) {
      addLink(shape.props.from as TLShapeId, shape.props.to as TLShapeId);
    } else if (shape.type === "arrow") {
      const bindings = editor.getBindingsFromShape<TLArrowBinding>(
        shape.id,
        "arrow",
      );
      const start = bindings.find(
        (binding) => binding.props.terminal === "start",
      );
      const end = bindings.find((binding) => binding.props.terminal === "end");
      if (start && end) addLink(start.toId, end.toId);
    }
  }
  const boxes = movable.map(({ shape, bounds }) => ({
    id: shape.id,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  }));
  const positions = tidy(boxes, links, options);
  const previous = boundingBox(movable.map((item) => item.bounds))!;
  const packed = boundingBox(
    boxes.map((box) => ({
      ...positions[box.id]!,
      width: box.width,
      height: box.height,
    })),
  )!;
  const origin = clearObstacles(
    { ...packed, x: previous.x, y: previous.y },
    fixed,
  );
  return movable.flatMap(({ shape, bounds }) => {
    const position = positions[shape.id]!;
    // Bounds are page-space AABBs. A rotated/freehand shape's origin need not
    // equal its bounds origin, so translate by the delta instead of replacing it.
    const x = shape.x + origin.x + position.x - bounds.x;
    const y = shape.y + origin.y + position.y - bounds.y;
    return Math.abs(x - shape.x) < 1e-8 && Math.abs(y - shape.y) < 1e-8
      ? []
      : [{ id: shape.id, type: shape.type, x, y }];
  });
}

export function arrangeEditorShapes(
  editor: Editor,
  options: TidyOptions = {},
): void {
  const updates = editorTidyUpdates(editor, options);
  if (updates.length === 0) return;
  editor.markHistoryStoppingPoint("arrange canvas");
  editor.run(() => editor.updateShapes(updates));
}

/** Fit what is actually visible, including native content and clipped frames. */
export function visiblePageBounds(editor: Editor): Box | null {
  const boxes: Box[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (!visible(editor, shape)) continue;
    const bounds = editor.getShapeMaskedPageBounds(shape.id);
    if (finiteBounds(bounds)) boxes.push(bounds);
  }
  return boundingBox(boxes);
}
