import * as React from "react";
import { MessageSquare, Sparkles, X } from "lucide-react";
import type { CanvasNode } from "@ai-coding-canvas/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import {
  canSuggestTitle,
  onNodeAnnotation,
  openNodeAnnotation,
  suggestNodeTitle,
  type NodeAnnotationKind,
} from "./annotations";
import { MAX_LABELS, nodeLabels, nodeNote } from "./model";

/**
 * 节点的标注（计划书 §17「头部补齐」）：✦ AI 命名、评论、标签。
 *
 * **不占节点里的任何高度**。终端节点的头部必须永远是一行 34px、下面直接是
 * xterm：多出一条标签行会改变节点体高度，xterm 会跟着重新 fit，画面来回跳。
 * 所以三个入口都不在节点体里：
 *
 *  - 终端：AI 命名 / 评论在头部已有的「更多」下拉里；标签走右键菜单「标签…」。
 *  - 便签：标签 chip 画在便签自己的正文里（`StickyNode`），评论走头部图标钮。
 *  - 其它类型：头部一个「评论」图标钮。
 *
 * 编辑面板一律是 Dialog（Radix портal 到 body），无论开合都不改变节点尺寸。
 */

/* ------------------------------ 头部图标钮 ------------------------------- */

/**
 * 非终端节点头部右侧的标注按钮。只有图标钮，不改变头部高度；
 * 终端节点不用它（它的两项在 `TerminalNode` 的「更多」下拉里）。
 */
export function NodeMetaActions({ node }: { node: CanvasNode }) {
  const t = useT();
  const hasNote = nodeNote(node).length > 0;

  return (
    <>
      {canSuggestTitle(node) && (
        <IconButton
          className="nodrag"
          label={t("meta.suggestTitle")}
          onClick={() => void suggestNodeTitle(node.id)}
        >
          <Sparkles />
        </IconButton>
      )}
      <IconButton
        className="nodrag relative"
        label={t("meta.note")}
        onClick={() => openNodeAnnotation(node.id, "note")}
      >
        <MessageSquare />
        {hasNote && (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--brand)]"
          />
        )}
      </IconButton>
    </>
  );
}

/* -------------------------------- 编辑面板 -------------------------------- */

/**
 * 标注面板的宿主。每个节点外壳挂一份，只在事件指向自己时才渲染 Dialog；
 * Dialog 走 portal，开合都不影响节点布局。
 */
export function NodeAnnotationHost({ node }: { node: CanvasNode }) {
  const [kind, setKind] = React.useState<NodeAnnotationKind | null>(null);

  React.useEffect(() => onNodeAnnotation(node.id, setKind), [node.id]);

  if (!kind) return null;
  return (
    <NodeAnnotationDialog
      node={node}
      kind={kind}
      onClose={() => setKind(null)}
    />
  );
}

function NodeAnnotationDialog({
  node,
  kind,
  onClose,
}: {
  node: CanvasNode;
  kind: NodeAnnotationKind;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="z-[var(--z-dialog)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {kind === "note" ? t("meta.note") : t("meta.labels")}
          </DialogTitle>
        </DialogHeader>
        {kind === "note" ? (
          <NoteEditor node={node} onDone={onClose} />
        ) : (
          <LabelEditor node={node} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NoteEditor({
  node,
  onDone,
}: {
  node: CanvasNode;
  onDone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState(nodeNote(node));

  function commit() {
    useCanvasStore.getState().setNodeNote(node.id, draft);
    onDone();
  }

  return (
    <>
      <Textarea
        autoFocus
        aria-label={t("meta.note")}
        placeholder={t("meta.notePlaceholder")}
        className="min-h-[120px] resize-none text-xs"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      <DialogFooter>
        <Button size="sm" onClick={commit}>
          {t("dialog.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

function LabelEditor({
  node,
  onDone,
}: {
  node: CanvasNode;
  onDone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState("");
  const labels = nodeLabels(node);

  function add(value: string) {
    const label = value.trim();
    setDraft("");
    if (!label) return;
    useCanvasStore.getState().setNodeLabels(node.id, [...labels, label]);
  }

  return (
    <>
      <NodeLabelChips node={node} removable />
      <Input
        autoFocus
        aria-label={t("meta.labelAdd")}
        placeholder={t("meta.labelPlaceholder")}
        disabled={labels.length >= MAX_LABELS}
        className="h-8 text-xs"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") add(draft);
        }}
      />
      <DialogFooter>
        <Button size="sm" onClick={onDone}>
          {t("dialog.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * 标签 chip 组。便签正文里直接用它（只读时不显示 ×），
 * 标签面板里用 `removable` 版本。
 */
export function NodeLabelChips({
  node,
  removable,
  className,
}: {
  node: CanvasNode;
  removable?: boolean;
  className?: string;
}) {
  const t = useT();
  const labels = nodeLabels(node);
  if (labels.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {labels.map((label) => (
        <Badge
          key={label}
          variant="ghost"
          className="group/label h-[16px] gap-0.5 px-1 text-[length:var(--text-caption)]"
        >
          {label}
          {removable && (
            <IconButton
              className="nodrag size-[12px]"
              label={t("meta.labelRemove", { label })}
              onClick={() =>
                useCanvasStore.getState().setNodeLabels(
                  node.id,
                  labels.filter((item) => item !== label),
                )
              }
            >
              <X />
            </IconButton>
          )}
        </Badge>
      ))}
    </div>
  );
}
