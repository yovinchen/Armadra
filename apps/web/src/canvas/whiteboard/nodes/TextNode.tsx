import * as React from "react";
import type { Node, NodeProps } from "@xyflow/react";

import { colorHex, fontSize } from "../palette";
import { useCanvasScheme } from "../scheme";
import { updateItem } from "../store";
import type { TextItem } from "../model";
import { ItemFrame } from "./ItemFrame";
import { InlineText } from "./InlineText";

/**
 * 文字（React Flow 计划 F24，归属 whiteboard）。
 *
 * 纯文本，不是富文本（§1.3 的差异）：换行保留，没有加粗 / 列表 / 链接，
 * 字体是应用字体栈。宽度用户拖，高度由内容算——所以 `NodeResizer` 只给
 * 横向把手（`widthOnly`）。
 *
 * 高度回写用 `ResizeObserver` 量真实排版结果，而不是按字符数估：中英文
 * 混排、不同字号、不同换行位置估出来的高度总会差一行，差一行就意味着
 * 选中框和内容对不齐。
 */

export type TextFlowNode = Node<TextItem, "wb.text">;

/** 空文字对象的高度：一行的高度，免得刚建出来是个 0 高的看不见的东西。 */
const MIN_TEXT_HEIGHT = 24;

export function TextNode({
  id,
  data,
  selected = false,
}: NodeProps<TextFlowNode>) {
  const scheme = useCanvasScheme();
  const box = React.useRef<HTMLDivElement>(null);

  // 内容或宽度变了就把高度写回文档。写回不进历史：它是排版的结果，
  // 不是用户的一次编辑，⌘Z 不该在「文字」与「文字 + 高度」之间来回跳。
  React.useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const height = Math.max(MIN_TEXT_HEIGHT, Math.ceil(element.scrollHeight));
      if (Math.abs(height - data.h) < 1) return;
      updateItem(id, { h: height }, { history: "ignore" });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [data.h, data.style.size, data.text, data.w, id]);

  return (
    <ItemFrame item={data} selected={selected} widthOnly>
      <div
        ref={box}
        style={{
          width: "100%",
          minHeight: MIN_TEXT_HEIGHT,
          position: "relative",
        }}
      >
        {/* 撑开高度的那一份：编辑时藏起来，但仍然参与排版，
            所以输入到第三行时框会跟着长高。 */}
        <div
          style={{
            visibility: "hidden",
            padding: 4,
            fontSize: fontSize(data.style.size),
            lineHeight: 1.35,
            fontFamily: "var(--font-ui)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data.text || " "}
        </div>
        <InlineText
          itemId={id}
          text={data.text}
          field="text"
          color={colorHex(data.style.color, scheme)}
          fontSize={fontSize(data.style.size)}
          align={
            data.style.align === "middle"
              ? "center"
              : data.style.align === "end"
                ? "right"
                : "left"
          }
          autoEdit={data.text.length === 0}
        />
      </div>
    </ItemFrame>
  );
}

export default React.memo(TextNode);
