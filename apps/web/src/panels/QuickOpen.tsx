/**
 * 快速打开（⌘P，E01/M4；符号前缀见语言服务设计 §1.1「符号」）。
 *
 * 三种输入：
 *
 *  * 普通文本 → 文件。匹配在 Runtime 侧做：`GET …/file-index` 已经过权限
 *    校验、跳过 `.git` / `node_modules` / `target` 等目录并给出上限，所以
 *    cmdk 的本地过滤要关掉（`shouldFilter={false}`），否则会在一份已经截断
 *    的列表上再筛一次、把真正的匹配藏掉。结果不完整时列表底部明说。
 *  * `@` → 当前编辑器节点这一个文档的符号（`textDocument/documentSymbol`）。
 *  * `#` → 工作空间符号（`workspace/symbol`），问遍当前开着的每一种语言。
 *  * `路径:行:列` → 照文件名查，选中后打开到那个位置；`:行[:列]` 不查文件，
 *    直接跳当前编辑器（「跳转到行」命令就是带着 `:` 打开这里）。
 *
 * 输入为空时先列这台设备上最近打开过的文件（`files/recent-files`）。
 *
 * 两个符号前缀都只经**已经开着**的会话去问。没有开着的编辑器就没有会话，
 * 也就没有符号——那时列表是空的，而不是去把 server 拉起来：⌘P 打开的是一
 * 个列表，不该顺手启动一个进程。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Box,
  Braces,
  CornerDownRight,
  File as FileIcon,
  FileCode,
  Hash,
  History,
  Shapes,
  SquareFunction,
  Variable,
} from "lucide-react";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import {
  documentSymbols,
  iconOf,
  workspaceSymbols,
  type SymbolEntry,
  type SymbolIcon,
} from "@/editor/language/symbols";
import { openFileInEditor } from "@/files/open-editor";
import { parseLocationQuery, recentFiles } from "@/files/recent-files";
import { takeQuickOpenSeed } from "./quick-open-seed";
import { useCanvasStore } from "@/store/canvas-store";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/command";

/** 输入去抖：一次键入不该变成一次全工作区扫描。 */
const DEBOUNCE_MS = 150;

const SYMBOL_ICONS: Record<SymbolIcon, typeof FileIcon> = {
  file: FileIcon,
  module: Box,
  type: Shapes,
  function: SquareFunction,
  variable: Variable,
  field: Hash,
  other: Braces,
};

type Mode = "files" | "document" | "workspace";

/** 当前文件名，给「最近」一栏的主标签用。 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function modeOf(query: string): Mode {
  if (query.startsWith("@")) return "document";
  if (query.startsWith("#")) return "workspace";
  return "files";
}

export function QuickOpen() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.quickOpen);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const selected = useCanvasStore((state) => state.selectedNodeIds);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [seedPath, setSeedPath] = useState<string | null>(null);

  /**
   * `@` 问的是哪一个文档：选中的编辑器节点，没有就画布上第一个。快速打开
   * 自己没有焦点文档的概念，所以这里说清楚，而不是让每个 server 各猜一个。
   */
  const currentPath = useMemo(() => {
    if (seedPath) return seedPath;
    const editors = (nodes ?? []).filter((node) => node.data.kind === "editor");
    const chosen =
      editors.find((node) => selected.includes(node.id)) ?? editors[0];
    return chosen?.data.kind === "editor" ? chosen.data.path : null;
  }, [nodes, selected, seedPath]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
      setSeedPath(null);
      return;
    }
    const seed = takeQuickOpenSeed();
    if (seed) {
      setQuery(seed.query);
      setDebounced(seed.query);
      setSeedPath(seed.path ?? null);
    }
  }, [open]);

  const mode = modeOf(debounced);
  /** `:` 开头：只跳行，不查文件。 */
  const lineMode = mode === "files" && debounced.startsWith(":");
  const location = mode === "files" ? parseLocationQuery(debounced) : null;
  const term =
    mode !== "files"
      ? debounced.slice(1)
      : location
        ? location.path
        : debounced;

  const index = useQuery({
    queryKey: ["file-index", workspaceId, term],
    queryFn: () => runtimeApi.fileIndex(workspaceId!, term),
    enabled: open && mode === "files" && !lineMode && Boolean(workspaceId),
    retry: false,
  });

  // 每次打开重新读一遍：别的编辑器节点刚打开的文件应该已经在里面。
  const recent = useMemo(
    () => (open && workspaceId ? recentFiles(workspaceId) : []),
    [open, workspaceId],
  );
  const showRecent =
    mode === "files" && debounced.trim() === "" && recent.length > 0;

  const openAt = (path: string) => {
    setPanel("quickOpen", false);
    if (location)
      openFileInEditor(path, { line: location.line, column: location.column });
    else openFileInEditor(path);
  };

  const symbols = useQuery({
    queryKey: ["language-symbols", workspaceId, mode, currentPath, term],
    queryFn: () =>
      mode === "document"
        ? documentSymbols(workspaceId!, currentPath!)
        : workspaceSymbols(term),
    enabled:
      open &&
      mode !== "files" &&
      Boolean(workspaceId) &&
      (mode === "workspace" || Boolean(currentPath)),
    retry: false,
  });

  const entries = lineMode ? [] : (index.data?.entries ?? []);
  // `@` 的结果在客户端过滤：documentSymbol 不接受查询词，整份符号表本来就
  // 一次取回。`#` 的过滤在 server 那边，这里不再筛一遍。
  const found = useMemo(() => {
    const all = symbols.data ?? [];
    if (mode !== "document" || !term) return all;
    const needle = term.toLowerCase();
    return all.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [symbols.data, mode, term]);

  const failed = mode === "files" ? index.isError : symbols.isError;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => setPanel("quickOpen", next)}
      title={t("quickOpen.title")}
      description={t("quickOpen.description")}
      shouldFilter={false}
      className="z-[var(--z-dialog)]"
    >
      <CommandInput
        placeholder={t("quickOpen.placeholder")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {failed
            ? t("quickOpen.failed")
            : (mode === "document" || lineMode) && !currentPath
              ? t("quickOpen.noDocument")
              : lineMode
                ? t("quickOpen.lineHint")
                : mode === "files"
                  ? t("quickOpen.empty")
                  : t("quickOpen.noSymbols")}
        </CommandEmpty>
        {lineMode && location && currentPath && (
          <CommandGroup heading={t("quickOpen.goToLine")}>
            <CommandItem
              value={`line:${location.line}:${location.column ?? ""}`}
              onSelect={() => openAt(currentPath)}
            >
              <CornerDownRight />
              <span className="min-w-0 flex-1 truncate">
                {location.column === undefined
                  ? t("quickOpen.lineTarget", { line: location.line })
                  : t("quickOpen.lineColumnTarget", {
                      line: location.line,
                      column: location.column,
                    })}
              </span>
              <CommandShortcut className="truncate">
                {currentPath}
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
        {showRecent && (
          <CommandGroup heading={t("quickOpen.recent")}>
            {recent.map((path) => (
              <CommandItem
                key={`recent:${path}`}
                value={`recent:${path}`}
                onSelect={() => openAt(path)}
              >
                <History />
                <span className="min-w-0 flex-1 truncate">
                  {baseName(path)}
                </span>
                <CommandShortcut className="truncate">{path}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {mode === "files" && entries.length > 0 && (
          <CommandGroup heading={t("quickOpen.title")}>
            {entries.map((entry) => (
              <CommandItem
                key={entry.path}
                value={entry.path}
                onSelect={() => openAt(entry.path)}
              >
                <FileIcon />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <CommandShortcut className="truncate">
                  {entry.path}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {mode !== "files" && found.length > 0 && (
          <CommandGroup
            heading={t(
              mode === "document"
                ? "quickOpen.documentSymbols"
                : "quickOpen.workspaceSymbols",
            )}
          >
            {found.map((entry, position) => (
              <SymbolRow
                key={`${entry.path}:${entry.line}:${entry.name}:${position}`}
                entry={entry}
                showPath={mode === "workspace"}
                onSelect={() => {
                  setPanel("quickOpen", false);
                  openFileInEditor(entry.path, { line: entry.line + 1 });
                }}
              />
            ))}
          </CommandGroup>
        )}
        {mode === "files" && index.data?.truncated && (
          <p
            role="status"
            className="px-3 py-1.5 text-[length:var(--text-caption)] text-muted-foreground"
          >
            {t("quickOpen.truncated")}
          </p>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function SymbolRow({
  entry,
  showPath,
  onSelect,
}: {
  entry: SymbolEntry;
  showPath: boolean;
  onSelect: () => void;
}) {
  const Icon = SYMBOL_ICONS[iconOf(entry.kind)] ?? FileCode;
  const trailing = showPath
    ? entry.path
    : (entry.container ?? entry.detail ?? "");
  return (
    <CommandItem
      value={`${entry.path}:${entry.line}:${entry.name}`}
      onSelect={onSelect}
    >
      <Icon />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {trailing && (
        <CommandShortcut className="truncate">{trailing}</CommandShortcut>
      )}
    </CommandItem>
  );
}
