/**
 * 侧栏搜索的纯逻辑（§27）。
 *
 * 搜索面板的范围是**当前工作空间的所有画布**：画布名、节点标题、便签正文。
 * 这里只做「文本 → 命中列表」，取数据（每块板的文档）与渲染都在
 * `SidebarSearch.tsx`，好让排序与摘取规则能被单测按数据覆盖。
 *
 * 历史对话不在这里：它由 Runtime 的对话索引接口自己检索（`meta/conversations`），
 * 前端不重复实现一份匹配规则。
 */
import type { CanvasNode } from "@armadra/shared";

/** 一块板的可搜索内容。`nodes` 允许为空——文档还没取到时就是这样。 */
export interface SearchBoard {
  id: string;
  name: string;
  nodes: readonly CanvasNode[];
}

export type SearchHitKind = "board" | "node";

export interface SearchHit {
  kind: SearchHitKind;
  /** 画布命中给画布 id，节点命中给节点 id。 */
  id: string;
  boardId: string;
  boardName: string;
  title: string;
  /** 命中的是便签正文时，正文里那一段上下文。 */
  snippet?: string;
}

/** 一次最多列这么多条，超过靠继续输入收窄。 */
export const SEARCH_LIMIT = 40;
/** 便签摘要的长度，超出两端加省略号。 */
export const SNIPPET_LENGTH = 72;

/** 便签正文；其余节点类型没有正文，返回空串。 */
export function stickyContent(node: CanvasNode): string {
  return node.data.kind === "sticky" ? node.data.content : "";
}

/**
 * 正文里围绕命中位置截一段。没命中（空查询）时截开头。
 * 只压缩空白，不改标点——中文正文里换行本身就是断句。
 */
export function snippetAround(
  text: string,
  query: string,
  length: number = SNIPPET_LENGTH,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const at = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (flat.length <= length) return flat;
  if (at < 0) return `${flat.slice(0, length)}…`;
  const start = Math.max(0, at - Math.floor(length / 3));
  const end = Math.min(flat.length, start + length);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * 画布 + 节点 → 命中列表。
 *
 * 顺序即优先级：画布名 → 节点标题 → 便签正文。空查询时不筛，直接按同样的
 * 顺序列出来（面板刚打开时不该是一片空白）。
 */
export function searchBoards(
  boards: readonly SearchBoard[],
  query: string,
  limit: number = SEARCH_LIMIT,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  const boardHits: SearchHit[] = [];
  const titleHits: SearchHit[] = [];
  const contentHits: SearchHit[] = [];

  for (const board of boards) {
    if (!needle || includes(board.name, needle)) {
      boardHits.push({
        kind: "board",
        id: board.id,
        boardId: board.id,
        boardName: board.name,
        title: board.name,
      });
    }
    for (const node of board.nodes) {
      const content = stickyContent(node);
      const byTitle = !needle || includes(node.title, needle);
      const byContent = Boolean(needle) && includes(content, needle);
      if (!byTitle && !byContent) continue;
      const hit: SearchHit = {
        kind: "node",
        id: node.id,
        boardId: board.id,
        boardName: board.name,
        title: node.title,
        ...(content ? { snippet: snippetAround(content, needle) } : {}),
      };
      (byTitle ? titleHits : contentHits).push(hit);
    }
  }

  return [...boardHits, ...titleHits, ...contentHits].slice(0, limit);
}
