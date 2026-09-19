/**
 * 「这段文本是 Mermaid 吗」（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §4.3）。
 *
 * 这是**唯一**一个进首屏的 mermaid 文件：`use-clipboard.paste()` 每次粘贴
 * 都要问它，所以它不许 import 任何重依赖（mermaid 本体 2.7 MB，dagre
 * 200 kB，两者都只出现在懒加载的对话框那条链上）。
 *
 * 判据只有一条：剥掉注释与指令块之后，首个非空行以某个图种关键字开头。
 * 这必然有误判（一段以 `graph` 开头的散文），所以命中之后走的是「打开
 * 对话框让用户确认」而不是直接落地（设计 D8）。
 */

/**
 * 图种关键字。顺序无关；`stateDiagram-v2` 这种带后缀的靠 `\b` 之外的
 * 可选组匹配，不能只写 `stateDiagram` 然后指望 `\b` 在 `-` 前断开——
 * `-` 本来就是非单词字符，`stateDiagram-v2` 会被 `stateDiagram\b` 命中，
 * 这里写全只是为了让这张表可读。
 */
export const MERMAID_KEYWORDS = [
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "journey",
  "gitGraph",
  "quadrantChart",
  "requirementDiagram",
  "C4Context",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
] as const;

const KEYWORD_PATTERN = new RegExp(
  `^(?:${MERMAID_KEYWORDS.map((word) => word.replace(/[-]/g, "\\-")).join("|")})(?![A-Za-z0-9])`,
);

/**
 * Markdown 的 mermaid 代码围栏（从文档里连着反引号一起复制出来的那种）。
 *
 * 反引号写成 `\x60`：`i18n.test.ts` 的注释剥离器不认识正则字面量，字面的
 * 反引号会被它当成模板串的开头，后面整段注释就不再算注释了。
 */
const FENCE = /^\x60{3,}\s*mermaid\b/i;

/**
 * 正文的首个有意义的行。
 *
 * 跳过空行、`%%` 注释、`%%{ … }%%` 指令块（`%%{init: {...}}%%` 常常是
 * 第一行），以及 Markdown 的 ```mermaid 围栏。
 */
export function firstMeaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (FENCE.test(line)) continue;
    // `%%{init: …}%%` 与 `%% 注释` 都以 `%%` 开头，一起跳过。
    if (line.startsWith("%%")) continue;
    return line;
  }
  return "";
}

/**
 * 前缀匹配。`false` 一定不是 Mermaid，`true` 只是「值得问一句」。
 *
 * 长度上限是防呆：把一整个日志文件粘进来时不该弹导入框，而 Mermaid 图
 * 正文超过 200 kB 的情况不存在。
 */
export const MAX_MERMAID_TEXT = 200_000;

export function looksLikeMermaid(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.length > MAX_MERMAID_TEXT) return false;
  return KEYWORD_PATTERN.test(firstMeaningfulLine(text));
}

/**
 * `.mmd` / `.mermaid` 文件名。
 *
 * 扩展名是唯一判据：这两种扩展名的 MIME 在所有系统上都是空串或
 * `text/plain`，`routeFile` 看 MIME 分不出它们。
 */
export const MERMAID_EXTENSIONS: ReadonlySet<string> = new Set([
  "mmd",
  "mermaid",
]);

export function isMermaidFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 && MERMAID_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}
