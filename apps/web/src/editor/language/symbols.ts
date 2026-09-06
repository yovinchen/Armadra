import { listLanguageClients, peekLanguageClient } from "./client";
import { languageIdFor } from "./language-ids";
import { pathOfUri, workspaceUri } from "./uri";

/**
 * 符号（语言服务设计 §1.1「符号」）。
 *
 * 快速打开的两个前缀：`@` 是**当前文档**的符号（`textDocument/documentSymbol`），
 * `#` 是**整个工作空间**的符号（`workspace/symbol`）。两者都只经已经开着的
 * 会话去问——没有会话就没有 server，也就没有符号，这时列表是空的而不是
 * 一个转不完的圈。
 *
 * `workspace/symbol` 是按 server 问的，而会话是按语言开的，所以工作空间
 * 符号会问遍当前开着的每一种语言并把答案合起来。这也是唯一诚实的做法：
 * 一个 Rust server 不知道 TypeScript 文件里有什么。
 */

/** LSP `SymbolKind`，1 起。界面只用它挑一个图标。 */
export type SymbolKind = number;

export interface SymbolEntry {
  name: string;
  /** 签名或类型这类补充说明；server 不给就没有。 */
  detail?: string;
  kind: SymbolKind;
  /** 工作空间相对路径。工作空间之外的符号不会进来。 */
  path: string;
  /** 0 起的行号，跳转时 +1。 */
  line: number;
  /** 它属于哪个类 / 命名空间；`workspace/symbol` 常给。 */
  container?: string;
}

/** 一次列表最多多少条。快速打开是一个列表，不是一份索引。 */
const MAX_SYMBOLS = 200;

/* ------------------------------- 当前文档 -------------------------------- */

/**
 * `@`：当前文档的符号。
 *
 * 「当前文档」= 传进来的那个编辑器节点的路径。快速打开在画布上打开，它自己
 * 没有焦点文档的概念，所以由调用方（`QuickOpen`）说清楚是哪一个。
 */
export async function documentSymbols(
  workspaceId: string,
  path: string,
): Promise<SymbolEntry[]> {
  const languageId = languageIdFor(path);
  if (!languageId) return [];
  const client = peekLanguageClient(workspaceId, languageId);
  if (!client?.lsp || client.status.state === "unsupported") return [];
  if (client.lsp.serverCapabilities?.documentSymbolProvider === false)
    return [];
  const uri = workspaceUri(path);
  const result = await client.lsp.request<unknown, unknown[] | null>(
    "textDocument/documentSymbol",
    { textDocument: { uri } },
  );
  const entries: SymbolEntry[] = [];
  flatten(result ?? [], path, undefined, entries);
  return entries.slice(0, MAX_SYMBOLS);
}

/**
 * `DocumentSymbol[]`（有层级，带 `selectionRange` 与 `children`）与
 * `SymbolInformation[]`（扁平，带 `location`）两种回答都要接住：规范允许
 * 任意一种，而 server 各选各的。
 */
function flatten(
  result: unknown[],
  path: string,
  container: string | undefined,
  into: SymbolEntry[],
): void {
  for (const entry of result) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name : "";
    if (!name) continue;
    const range = (value.selectionRange ?? value.range) as
      | { start?: { line?: number } }
      | undefined;
    const location = value.location as
      | { uri?: string; range?: { start?: { line?: number } } }
      | undefined;
    const line = range?.start?.line ?? location?.range?.start?.line ?? 0;
    const symbolPath = location?.uri ? pathOfUri(location.uri) : path;
    if (!symbolPath) continue;
    into.push({
      name,
      detail: typeof value.detail === "string" ? value.detail : undefined,
      kind: typeof value.kind === "number" ? value.kind : 0,
      path: symbolPath,
      line,
      container:
        typeof value.containerName === "string"
          ? value.containerName
          : container,
    });
    if (Array.isArray(value.children))
      flatten(value.children, path, name, into);
  }
}

/* ------------------------------ 工作空间 --------------------------------- */

/**
 * `#`：工作空间符号，问遍当前开着的每一种语言。
 *
 * 空查询直接返回空：`workspace/symbol` 对空串的行为各 server 不同，有的会
 * 把整个索引倒出来，而快速打开的第一次按键不该变成一次全仓库扫描。
 */
export async function workspaceSymbols(query: string): Promise<SymbolEntry[]> {
  if (!query) return [];
  const clients = listLanguageClients().filter(
    (client) =>
      client.lsp !== null &&
      client.status.state !== "unsupported" &&
      client.lsp.serverCapabilities?.workspaceSymbolProvider !== false,
  );
  const answers = await Promise.all(
    clients.map((client) =>
      client
        .lsp!.request<unknown, unknown[] | null>("workspace/symbol", { query })
        .catch(() => null),
    ),
  );
  const entries: SymbolEntry[] = [];
  for (const answer of answers) {
    if (!Array.isArray(answer)) continue;
    flatten(answer, "", undefined, entries);
  }
  // 同一个符号可能被两个 server 各报一次（一个文件同时是 JS 和 TS 的时候）。
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const key = `${entry.path}:${entry.line}:${entry.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SYMBOLS);
}

/* -------------------------------- 图标 ----------------------------------- */

/** 图标分组。26 种 `SymbolKind` 归成界面分得清的几类。 */
export type SymbolIcon =
  | "file"
  | "module"
  | "type"
  | "function"
  | "variable"
  | "field"
  | "other";

/**
 * `SymbolKind` → 图标分组。编号取自 LSP 规范，不是猜的：
 * 1 File, 2 Module, 3 Namespace, 4 Package, 5 Class, 6 Method, 7 Property,
 * 8 Field, 9 Constructor, 10 Enum, 11 Interface, 12 Function, 13 Variable,
 * 14 Constant, 15 String, 16 Number, 17 Boolean, 18 Array, 19 Object,
 * 20 Key, 21 Null, 22 EnumMember, 23 Struct, 24 Event, 25 Operator,
 * 26 TypeParameter.
 */
export function iconOf(kind: SymbolKind): SymbolIcon {
  switch (kind) {
    case 1:
      return "file";
    case 2:
    case 3:
    case 4:
      return "module";
    case 5:
    case 10:
    case 11:
    case 23:
    case 26:
      return "type";
    case 6:
    case 9:
    case 12:
      return "function";
    case 7:
    case 8:
    case 20:
    case 22:
      return "field";
    case 13:
    case 14:
      return "variable";
    default:
      return "other";
  }
}
