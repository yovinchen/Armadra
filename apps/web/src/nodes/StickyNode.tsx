import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Textarea } from "@/ui/textarea";
import { Button } from "@/ui/button";
import { NodeLabelChips } from "@/meta/NodeMeta";
import { openNodeAnnotation } from "@/meta/annotations";
import { formatRelativeTime } from "@/lib/format";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/app/preferences-store";
import type { NodeBodyProps } from "./registry";

/**
 * 便签（§3.4）。使用中性节点表面；平时渲染 Markdown，
 * 点击切成 textarea，失焦提交。底部只有一行相对时间——没有字数、没有提示。
 */
export function StickyNode({ id, node }: NodeBodyProps) {
  const t = useT();
  const content = node.data.kind === "sticky" ? node.data.content : "";
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(content);

  React.useEffect(() => {
    if (!editing) setDraft(content);
  }, [content, editing]);

  function commit(value: string) {
    setEditing(false);
    if (value !== content) {
      useCanvasStore.getState().updateNodeData(id, { content: value });
    }
  }

  return (
    <div
      data-slot="sticky-node"
      className="flex h-full w-full flex-col bg-[var(--card)]"
    >
      {editing ? (
        <Textarea
          autoFocus
          aria-label={t("node.sticky")}
          placeholder={t("sticky.placeholder")}
          className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent text-xs leading-relaxed focus-visible:ring-0"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(content);
              setEditing(false);
            }
          }}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label={t("node.sticky")}
          className="sticky-markdown min-h-0 flex-1 cursor-text overflow-auto px-2.5 py-2 text-xs leading-relaxed"
          onClick={() => {
            setDraft(content);
            setEditing(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setDraft(content);
              setEditing(true);
            }
          }}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      )}
      {/* 标签（§17）：便签把它画在自己正文的底栏里——节点头部不许多出一行。 */}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-1.5 text-[length:var(--text-caption)] text-muted-foreground">
        <NodeLabelChips node={node} />
        <Button
          variant="ghost"
          size="xs"
          className="h-[16px] px-1 text-[length:var(--text-caption)] font-normal"
          onClick={() => openNodeAnnotation(id, "labels")}
        >
          {t("meta.labels")}
        </Button>
        <span className="ml-auto shrink-0">
          {formatRelativeTime(node.updatedAt)}
        </span>
      </div>
    </div>
  );
}
