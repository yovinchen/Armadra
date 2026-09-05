import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { runtimeApi } from "@/api/client";
import { cn } from "@/lib/cn";
import { ScrollArea } from "@/ui/scroll-area";

/**
 * Markdown 预览（编辑器设计 §4：不执行脚本，HTML 经清理）。
 *
 * `react-markdown` 默认就不渲染裸 HTML——这里刻意不装 `rehype-raw`，所以
 * 文档里的 `<script>` / `<img onerror>` 只会以文本出现。另外两条：
 *
 *  * 图片的相对路径经 Runtime 的文件读取接口取，不让页面直接摸文件系统，
 *    也不让一份 Markdown 把绝对路径变成外部请求；
 *  * 链接一律 `noreferrer`，且只放行 http/https 与文档内锚点——`javascript:`
 *    在这里就是一段没用的文本。
 */
export function MarkdownPreview({
  source,
  workspaceId,
  path,
  bordered,
}: {
  source: string;
  workspaceId: string | undefined;
  path: string;
  bordered: boolean;
}) {
  const directory = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : "";

  const resolve = React.useCallback(
    (source: string | undefined): string | undefined => {
      if (!source || !workspaceId) return undefined;
      if (/^(https?:|data:)/i.test(source)) return source;
      // `/a.png` 在工作区里就是根下的 a.png；`../` 交给 Runtime 拒绝。
      const relative = source.replace(/^\/+/, "");
      const joined =
        source.startsWith("/") || !directory
          ? relative
          : `${directory}/${relative}`;
      return runtimeApi.fileDownloadUrl(workspaceId, joined);
    },
    [directory, workspaceId],
  );

  return (
    <ScrollArea
      className={cn(
        "min-w-0 flex-1 bg-[var(--surface-sunken)]",
        bordered && "border-l border-[var(--border)]",
      )}
    >
      <div className="sticky-markdown p-3 text-[12.5px] leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt }) => (
              <img
                src={resolve(typeof src === "string" ? src : undefined)}
                alt={alt ?? ""}
              />
            ),
            a: ({ href, children }) => (
              <a
                href={
                  typeof href === "string" && /^(https?:|#)/i.test(href)
                    ? href
                    : undefined
                }
                target="_blank"
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ),
          }}
        >
          {source}
        </Markdown>
      </div>
    </ScrollArea>
  );
}
