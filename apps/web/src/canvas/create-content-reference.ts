import { createBindingId, createShapeId, type Editor, type TLShape, type TLShapeId } from "tldraw";
import { toast } from "sonner";
import { t } from "@/app/preferences-store";
import { contentArrowEnds, isContentShape, isNodeShapeRecord, MAX_LINKS } from "./content-links";

export function referenceTargets(editor: Editor): TLShape[] {
  return editor.getCurrentPageShapes().filter((shape) => {
    if (shape.type !== "armadra") return false;
    const props = shape.props as { nodeType?: string; data?: { agent?: { id?: string } } };
    return props.nodeType === "terminal" && Boolean(props.data?.agent?.id);
  });
}

/** Count unique readable native objects and node peers, including arrows still
 * being drawn before the regular link conversion runs. */
export function referenceCountForNode(editor: Editor, nodeId: TLShapeId): number {
  const peers = new Set<string>();
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type === "link") {
      const { from, to } = shape.props as { from: string; to: string };
      if (from === nodeId) peers.add(to);
      if (to === nodeId) peers.add(from);
    } else if (shape.type === "arrow") {
      const bindings = editor.getBindingsFromShape(shape.id, "arrow");
      const content = contentArrowEnds(shape.id, bindings, (id) => editor.getShape(id));
      if (content && `shape:${content.nodeId}` === nodeId) peers.add(content.shapeId);
      if (!content && bindings.some((binding) => binding.toId === nodeId)) {
        for (const binding of bindings) {
          if (binding.toId !== nodeId && isNodeShapeRecord(editor.getShape(binding.toId))) peers.add(binding.toId);
        }
      }
    }
  }
  return peers.size;
}

/** Create a normal persisted native arrow with real bindings, in one undo step. */
export function createContentReference(editor: Editor, sourceId: TLShapeId, targetId: TLShapeId): TLShapeId | null {
  const source = editor.getShape(sourceId);
  if (!isContentShape(source) || !referenceTargets(editor).some((target) => target.id === targetId)) return null;
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "arrow") continue;
    const ends = contentArrowEnds(shape.id, editor.getBindingsFromShape(shape.id, "arrow"), (id) => editor.getShape(id));
    if (ends?.shapeId === sourceId && `shape:${ends.nodeId}` === targetId) {
      editor.select(shape.id);
      return shape.id;
    }
  }
  if (referenceCountForNode(editor, targetId) >= MAX_LINKS) {
    toast.error(t("shape.referenceLimit", { limit: MAX_LINKS }));
    return null;
  }
  const from = editor.getShapePageBounds(sourceId);
  const to = editor.getShapePageBounds(targetId);
  if (!from || !to) return null;
  const right = to.center.x >= from.center.x;
  const arrowId = createShapeId();
  editor.markHistoryStoppingPoint("reference whiteboard content");
  editor.run(() => {
    editor.createShape({
      id: arrowId, type: "arrow", parentId: editor.getCurrentPageId(), x: 0, y: 0,
      props: { start: { x: right ? from.maxX : from.minX, y: from.center.y },
        end: { x: right ? to.minX : to.maxX, y: to.center.y },
        color: "grey", arrowheadStart: "none", arrowheadEnd: "arrow" },
      meta: { armadra: { contentId: crypto.randomUUID(), styled: true } },
    });
    for (const [terminal, toId, x] of [["start", sourceId, right ? 1 : 0], ["end", targetId, right ? 0 : 1]] as const) {
      editor.createBinding({ id: createBindingId(), type: "arrow", fromId: arrowId, toId,
        props: { terminal, normalizedAnchor: { x, y: 0.5 }, isExact: true, isPrecise: true } });
    }
    editor.select(arrowId);
  });
  return arrowId;
}
