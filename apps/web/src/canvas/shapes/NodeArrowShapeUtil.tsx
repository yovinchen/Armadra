import {
  ArrowShapeUtil,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
} from "tldraw";

import { isNodeShape } from "./LinkArrow";
import { LinkShapeContent, type LinkVisualShape } from "./LinkShapeUtil";

/** The in-progress arrow and the committed link share exactly the same path. */
export function nodeArrowPreview(
  editor: Editor,
  shape: TLArrowShape,
): LinkVisualShape | null {
  const bindings = editor.getBindingsFromShape<TLArrowBinding>(
    shape.id,
    "arrow",
  );
  const start = bindings.find((binding) => binding.props.terminal === "start");
  const end = bindings.find((binding) => binding.props.terminal === "end");
  if (!start || !end || start.toId === end.toId) return null;
  if (
    !isNodeShape(editor.getShape(start.toId)) ||
    !isNodeShape(editor.getShape(end.toId))
  )
    return null;
  return { id: shape.id, props: { from: start.toId, to: end.toId } };
}

export class NodeArrowShapeUtil extends ArrowShapeUtil {
  override component(shape: TLArrowShape) {
    // The native util calls React hooks directly. Keep those calls in every
    // render, including the frame in which the second node becomes bound.
    const native = super.component(shape);
    const preview = nodeArrowPreview(this.editor, shape);
    if (!preview) return native;
    // Link geometry uses page coordinates. The temporary native arrow can be
    // translated, rotated or parented to a frame; cancel its full transform.
    const transform = this.editor
      .getShapePageTransform(shape)
      .clone()
      .invert()
      .toCssString();
    return <LinkShapeContent shape={preview} transform={transform} />;
  }
}
