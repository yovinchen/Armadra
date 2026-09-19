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

  /**
   * **一次编辑一次提交，不按键提交。**
   *
   * 正文只住在 `draft` 里，失焦（或下面的卸载兜底）才写进文档。实测连续输入
   * 100 个字符期间 `commit()` 跑 0 次、`PUT …/document` 发 0 次、撤销栈只长
   * 一条（`docs/status/canvas-performance-baseline.md`）。这里**不加防抖**：
   * 300 ms 的防抖在同一段输入里会变成八次提交，比现在更差。
   */
  function commit(value: string) {
    setEditing(false);
    if (value !== content) {
      useCanvasStore.getState().updateNodeData(id, { content: value });
    }
  }

  /**
   * 还在编辑时节点被卸下来（切画布、进焦点页、节点被裁掉）不会走 `onBlur`，
   * 那一段字就没了。用 ref 捎一份最新的草稿，卸载时补交一次。
   */
  const pending = React.useRef({ editing, draft, content });
  pending.current = { editing, draft, content };
  React.useEffect(
    () => () => {
      const last = pending.current;
      if (!last.editing || last.draft === last.content) return;
      useCanvasStore.getState().updateNodeData(id, { content: last.draft });
    },
    [id],
  );

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
          className="sticky-markdown min-h-0 flex-1 cursor-text overflow-auto px-2 py-1.5 text-xs leading-relaxed"
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
      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1 text-[length:var(--text-caption)] text-muted-foreground">
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
