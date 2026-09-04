import {
  renderPlaintextFromRichText,
  type Editor,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import { ArrowDownToLine, ArrowUpToLine, Copy, Link2, RefreshCw, StickyNote, Trash2 } from "lucide-react";

import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { getEditor } from "../editor-context";
import { isWhiteboardShapeType } from "../tools";
import { isContentShape, refreshContentReferences } from "../content-links";
import { createContentReference, referenceTargets } from "../create-content-reference";

/**
 * 白板 shape 的右键菜单（§5「右键」那一行的第三种情况）。
 *
 * 节点走 `node-menu.tsx`、空白走 `AddMenuContent`，这里只管手绘 / 几何 /
 * 文字 / 图片 / 画框这些 tldraw 原生 shape：层级、复制、删除，
 * 外加「转成便签」——把一段白板文字变成 Agent 能读的便签节点。
 *
 * 颜色、粗细、填充不在这里：它们归样式面板（§12 第 2 条），
 * 一份样式两个入口只会互相打架。
 */

/** 右键命中的 shape 在选区里就作用于整个选区，否则只作用于它自己。 */
export function shapeMenuTargets(
  editor: Editor,
  shape: TLShape,
): TLShapeId[] {
  const selected = editor
    .getSelectedShapes()
    .filter((item) => isWhiteboardShapeType(item.type));
  if (selected.some((item) => item.id === shape.id)) {
    return selected.map((item) => item.id);
  }
  return [shape.id];
}

/** 文字 shape 才能转便签：其余 shape 没有可以变成 Markdown 的正文。 */
export function canConvertToSticky(shape: TLShape): boolean {
  return shape.type === "text";
}

/**
 * 文字 shape → 便签节点：内容原样搬过去，原 shape 删掉。
 *
 * 便签是 `nodes` 表里的一行（Agent 的 `sticky` 控制动词依赖它，§4.5），
 * 所以这里必须走 `store.addNode` 而不是再造一个 tldraw shape。
 */
export function convertTextToSticky(editor: Editor, shape: TLShape): void {
  if (!canConvertToSticky(shape)) return;
  const richText = (shape.props as { richText?: unknown }).richText;
  const content = richText
    ? renderPlaintextFromRichText(
        editor,
        richText as Parameters<typeof renderPlaintextFromRichText>[1],
      )
    : "";
  const bounds = editor.getShapePageBounds(shape.id);
  const store = useCanvasStore.getState();
  const id = store.addNode("sticky", {
    position: { x: bounds?.x ?? shape.x, y: bounds?.y ?? shape.y },
    data: { kind: "sticky", content },
  });
  if (!id) return;
  editor.deleteShapes([shape.id]);
}

export function ShapeMenuContent({ shape }: { shape: TLShape }) {
  const t = useT();
  const editor = getEditor();
  if (!editor) return null;

  const targets = shapeMenuTargets(editor, shape);
  const convertible = canConvertToSticky(shape);
  const agents = referenceTargets(editor);

  return (
    <>
      {isContentShape(shape) ? (
        <>
          <ContextMenuSub>
            <ContextMenuSubTrigger><Link2 />{t("shape.referenceAgent")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {agents.length === 0 ? <ContextMenuItem disabled>{t("shape.noAgents")}</ContextMenuItem> : agents.map((agent) => (
                <ContextMenuItem key={agent.id} onSelect={() => createContentReference(editor, shape.id, agent.id)}>
                  {(agent.props as { title?: string }).title || agent.id}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={refreshContentReferences}><RefreshCw />{t("shape.refreshReference")}</ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem onSelect={() => editor.bringToFront(targets)}>
        <ArrowUpToLine />
        {t("shape.bringToFront")}
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => editor.sendToBack(targets)}>
        <ArrowDownToLine />
        {t("shape.sendToBack")}
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => editor.duplicateShapes(targets, { x: 24, y: 24 })}>
        <Copy />
        {t("shape.duplicate")}
      </ContextMenuItem>

      {convertible ? (
        <ContextMenuItem onSelect={() => convertTextToSticky(editor, shape)}>
          <StickyNote />
          {t("shape.toSticky")}
        </ContextMenuItem>
      ) : null}

      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => editor.deleteShapes(targets)}
      >
        <Trash2 />
        {t("shape.delete")}
      </ContextMenuItem>
    </>
  );
}
