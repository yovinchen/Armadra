/**
 * 快速打开（⌘P，E01/M4）。
 *
 * 匹配在 Runtime 侧做：`GET …/file-index` 已经过权限校验、跳过
 * `.git` / `node_modules` / `target` 等目录并给出上限，所以 cmdk 的本地
 * 过滤要关掉（`shouldFilter={false}`），否则会在一份已经截断的列表上再筛
 * 一次、把真正的匹配藏掉。结果不完整时列表底部明说。
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { File as FileIcon } from "lucide-react";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { openFileInEditor } from "@/files/open-editor";
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

export function QuickOpen() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.quickOpen);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  const index = useQuery({
    queryKey: ["file-index", workspaceId, debounced],
    queryFn: () => runtimeApi.fileIndex(workspaceId!, debounced),
    enabled: open && Boolean(workspaceId),
    retry: false,
  });

  const entries = index.data?.entries ?? [];

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => setPanel("quickOpen", next)}
      title={t("quickOpen.title")}
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
          {index.isError ? t("quickOpen.failed") : t("quickOpen.empty")}
        </CommandEmpty>
        {entries.length > 0 && (
          <CommandGroup heading={t("quickOpen.title")}>
            {entries.map((entry) => (
              <CommandItem
                key={entry.path}
                value={entry.path}
                onSelect={() => {
                  setPanel("quickOpen", false);
                  openFileInEditor(entry.path);
                }}
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
        {index.data?.truncated && (
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
