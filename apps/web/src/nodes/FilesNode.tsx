import * as React from "react";
import type { FileEntry, GitFileStatus } from "@armadra/shared";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { NodeShell } from "./NodeShell";
import { NODE_META, type NodeBodyProps } from "./registry";
import { useWorkspaceFileDrag } from "../files/use-workspace-file-drag";
import { FileTypeIcon } from "./files/file-icons";
import { FilesBreadcrumb } from "./files/FilesBreadcrumb";
import { breadcrumbs, rootLabelFor, tailSizeFor } from "./files/breadcrumb";

/** 新开的编辑器节点放在文件节点右边这么远。 */
const SPAWN_GAP = 24;

const STATUS_COLOR: Record<GitFileStatus["status"], string> = {
  M: "var(--warn)",
  A: "var(--success)",
  D: "var(--danger)",
  R: "var(--brand)",
  "?": "var(--muted-foreground)",
};

/**
 * 文件管理器节点（§3.4）：面包屑 + 过滤框 + 列表。
 * 面包屑只显示工作空间根、一个 `…` 和最后两级（窄节点一级），见
 * [`breadcrumb`](./files/breadcrumb.ts)。
 * 单击文件夹进入，双击文件在右边开一个编辑器节点。
 *
 * Git 字母徽标取自 `gitStatus().files`（一次 porcelain 扫描）；
 * 不去要 diff——那要为每个文件跑一遍 `git diff`。
 */
export function FilesNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "files" ? node.data : undefined;
  const path = data?.path ?? ".";
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const workspaceName = useCanvasStore((state) => state.workspace?.name);
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const dragProps = useWorkspaceFileDrag(workspaceId);

  const [entries, setEntries] = React.useState<FileEntry[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [badges, setBadges] = React.useState<
    ReadonlyMap<string, GitFileStatus["status"]>
  >(new Map());

  React.useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setEntries(null);
    setFailed(false);
    runtimeApi
      .listFiles(workspaceId, path)
      .then((list) => {
        if (!cancelled) setEntries(list.entries);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    runtimeApi
      .gitStatus(workspaceId)
      .then((status) => {
        if (cancelled) return;
        setBadges(
          new Map(status.files.map((file) => [file.path, file.status])),
        );
      })
      // 不是 Git 仓库 / 读取失败时就不显示徽标，列表本身照常渲染。
      .catch(() => {
        if (!cancelled) setBadges(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [path, workspaceId]);

  function navigate(next: string) {
    useCanvasStore.getState().updateNodeData(id, { path: next });
  }

  function openEditor(entry: FileEntry) {
    const store = useCanvasStore.getState();
    const size = node.size ?? NODE_META.files.defaultSize;
    store.addNode("editor", {
      title: entry.name,
      data: { path: entry.path },
      position: {
        x: node.position.x + size.width + SPAWN_GAP,
        y: node.position.y,
      },
    });
  }

  const visible = React.useMemo(() => {
    if (!entries) return [];
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      : entries;
    return [...matched].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [entries, filter]);

  const crumbs = breadcrumbs(
    path,
    rootLabelFor(workspaceName, workspaceRoot, t("files.root")),
  );

  return (
    <NodeShell node={node} selected={selected}>
      <div className="flex h-full w-full flex-col">
        <FilesBreadcrumb
          crumbs={crumbs}
          tailSize={tailSizeFor(node.size?.width)}
          onNavigate={navigate}
        />

        <div className="shrink-0 p-1.5">
          <Input
            aria-label={t("files.filter")}
            placeholder={t("files.filter")}
            className="h-6 text-xs"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {failed && (
            <div className="p-1.5">
              <Badge variant="destructive">{t("files.failed")}</Badge>
            </div>
          )}
          {visible.map((entry) => {
            const badge = badges.get(entry.path);
            return (
              <Button
                key={entry.path}
                {...dragProps(entry)}
                variant="ghost"
                size="sm"
                className="h-6 w-full cursor-grab justify-start gap-1.5 rounded-none px-2 font-normal active:cursor-grabbing"
                onClick={() => {
                  if (entry.kind === "directory") navigate(entry.path);
                }}
                onDoubleClick={() => {
                  if (entry.kind === "file") openEditor(entry);
                }}
              >
                <FileTypeIcon path={entry.name} kind={entry.kind} />
                <span className="truncate text-[11px]">{entry.name}</span>
                {badge && (
                  <span
                    className="ml-auto shrink-0 font-mono text-[length:var(--text-caption)] font-bold"
                    style={{ color: STATUS_COLOR[badge] }}
                    title={t(`files.status.${badge}`)}
                  >
                    {badge}
                  </span>
                )}
              </Button>
            );
          })}
        </ScrollArea>
      </div>
    </NodeShell>
  );
}
