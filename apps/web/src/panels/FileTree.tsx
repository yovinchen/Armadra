/**
 * 项目文件树（§3.6）。
 *
 * 目录懒加载：每展开一层发一次 `listFiles`。Git 徽标来自 `gitStatus`
 * 的 `files`（一次 porcelain 扫描，不用去算 diff），15s 刷新一次；
 * 点文件开 editor 节点，目录右键可开文件管理器节点。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  Image as ImageIcon,
  RotateCw,
} from "lucide-react";
import type { FileEntry, GitFileStatus } from "@armadra/shared";

type DiffFileStatus = GitFileStatus["status"];

import { runtimeApi } from "../api/client";
import { cn } from "../lib/cn";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { IconButton } from "../ui/icon-button";
import { currentViewportCenter } from "./viewport";
import { useWorkspaceFileDrag } from "../files/use-workspace-file-drag";

/** 从不值得浏览的目录，Runtime 也已经隐藏了一部分。 */
const IGNORED = new Set([".git", "node_modules", "target", "dist"]);
const GIT_REFETCH_MS = 15_000;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

type BadgeMap = Map<string, DiffFileStatus>;

const STATUS_COLOR: Record<DiffFileStatus, string> = {
  M: "var(--warn)",
  A: "var(--success)",
  D: "var(--danger)",
  R: "var(--brand)",
  "?": "var(--muted-foreground)",
};

export function FileTree() {
  const workspace = useCanvasStore((state) => state.workspace);

  const status = useQuery({
    queryKey: ["git-status", workspace?.id],
    queryFn: () => runtimeApi.gitStatus(workspace!.id),
    enabled: Boolean(workspace),
    refetchInterval: GIT_REFETCH_MS,
    retry: false,
  });

  const badges = useMemo<BadgeMap>(() => {
    const map: BadgeMap = new Map();
    for (const file of status.data?.files ?? [])
      map.set(file.path, file.status);
    return map;
  }, [status.data]);

  const t = useT();
  if (!workspace) return null;

  return (
    <div
      className="flex flex-col py-1 text-[13px]"
      role="tree"
      aria-label={t("explorer.tree")}
    >
      <Directory
        workspaceId={workspace.id}
        path="."
        depth={0}
        badges={badges}
      />
    </div>
  );
}

function Directory({
  workspaceId,
  path,
  depth,
  badges,
}: {
  workspaceId: string;
  path: string;
  depth: number;
  badges: BadgeMap;
}) {
  const t = useT();
  const files = useQuery({
    queryKey: ["files", workspaceId, path],
    queryFn: () => runtimeApi.listFiles(workspaceId, path),
    retry: false,
  });

  const entries = useMemo(
    () =>
      (files.data?.entries ?? [])
        .filter((entry) => !IGNORED.has(entry.name))
        .sort(compareEntries),
    [files.data],
  );

  return (
    <>
      {files.isPending && (
        <p
          className="px-2 py-1 text-xs text-muted-foreground"
          style={indent(depth)}
        >
          {t("explorer.loading")}
        </p>
      )}
      {files.isError && (
        <div
          className="flex items-center gap-1 px-2 py-1 text-xs text-destructive"
          role="alert"
          style={indent(depth)}
        >
          <span className="truncate">{files.error.message}</span>
          <IconButton
            label={t("explorer.retry")}
            onClick={() => void files.refetch()}
          >
            <RotateCw />
          </IconButton>
        </div>
      )}
      {files.isSuccess && entries.length === 0 && (
        <p
          className="px-2 py-1 text-xs text-muted-foreground"
          style={indent(depth)}
        >
          {t("explorer.empty")}
        </p>
      )}
      {entries.map((entry) => (
        <Row
          key={entry.path}
          workspaceId={workspaceId}
          entry={entry}
          depth={depth}
          badges={badges}
        />
      ))}
      {files.data?.truncated && (
        <p
          className="px-2 py-1 text-xs text-muted-foreground"
          role="status"
          style={indent(depth)}
        >
          {t("explorer.truncated")}
        </p>
      )}
    </>
  );
}

function Row({
  workspaceId,
  entry,
  depth,
  badges,
}: {
  workspaceId: string;
  entry: FileEntry;
  depth: number;
  badges: BadgeMap;
}) {
  const t = useT();
  const addNode = useCanvasStore((state) => state.addNode);
  const [open, setOpen] = useState(false);
  const dragProps = useWorkspaceFileDrag(workspaceId);

  const directory = entry.kind === "directory";
  const image = !directory && IMAGE_EXTENSIONS.test(entry.name);
  const badge = badges.get(entry.path);

  const activate = () => {
    if (directory) {
      setOpen((value) => !value);
      return;
    }
    addNode("editor", {
      title: entry.name,
      position: currentViewportCenter(),
      data: { kind: "editor", path: entry.path, readonly: entry.readonly },
    });
  };

  const row = (
    <Button
      {...dragProps(entry)}
      variant="ghost"
      size="sm"
      role="treeitem"
      aria-expanded={directory ? open : undefined}
      aria-label={
        directory
          ? t("explorer.browse", { name: entry.name })
          : t("explorer.open", { name: entry.name })
      }
      title={entry.path}
      style={indent(depth)}
      className={cn(
        "h-7 w-full cursor-grab justify-start gap-1.5 rounded-md pr-2 font-normal active:cursor-grabbing",
        badge && "text-foreground",
      )}
      onClick={activate}
    >
      {directory ? (
        open ? (
          <ChevronDown className="text-muted-foreground" />
        ) : (
          <ChevronRight className="text-muted-foreground" />
        )
      ) : image ? (
        <ImageIcon className="text-muted-foreground" />
      ) : (
        <FileIcon className="text-muted-foreground" />
      )}
      {directory && <Folder className="text-muted-foreground" />}
      <span className="truncate">{entry.name}</span>
      {badge && (
        <Badge
          variant="ghost"
          className="ml-auto h-4 px-1 font-mono text-[length:var(--text-caption)]"
          style={{ color: STATUS_COLOR[badge] }}
          title={t(`explorer.status.${badge}`)}
        >
          {badge}
        </Badge>
      )}
    </Button>
  );

  return (
    <>
      {directory ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() =>
                addNode("files", {
                  title: entry.name,
                  position: currentViewportCenter(),
                  data: { kind: "files", path: entry.path },
                })
              }
            >
              <Folder />
              {t("explorer.newFilesNode")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {directory && open && (
        <Directory
          workspaceId={workspaceId}
          path={entry.path}
          depth={depth + 1}
          badges={badges}
        />
      )}
    </>
  );
}

/** 每层 12px，叠在行自身的 8px 内边距上。 */
function indent(depth: number) {
  return { paddingLeft: `${8 + depth * 12}px` };
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}
