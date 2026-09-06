/**
 * 项目文件树（§3.6）。
 *
 * 目录懒加载：每展开一层发一次 `listFiles`。Git 徽标来自 `gitStatus`
 * 的 `files`（一次 porcelain 扫描，不用去算 diff），15s 刷新一次；
 * 点文件开 editor 节点，目录右键可开文件管理器节点。
 *
 * 文件操作（E01/M4）：右键菜单里新建 / 重命名 / 移动 / 删除到回收站，
 * 把文件拖到目录行上也是移动。全部受工作区 write 权限约束——没有写权限时
 * 这些项直接不出现，而不是点了才报错。删除永远只到工作区回收站。
 */
import { useMemo, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  RotateCw,
  Trash2,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { IconButton } from "../ui/icon-button";
import { nodeDropPosition } from "@/canvas/placement";
import { FileEntryDialog } from "./FileEntryDialog";
import { useWorkspaceFileDrag } from "../files/use-workspace-file-drag";
import {
  joinPath,
  parentOf,
  useFileActions,
  type FileActions,
} from "../files/use-file-actions";
import {
  hasWorkspaceFileDrag,
  readWorkspaceFileDrag,
} from "../files/workspace-drag";

/**
 * 从不值得浏览的目录，Runtime 也已经隐藏了一部分。
 *
 * `.armadra` 是我们自己的目录（导入、资产、回收站）：删除一个文件之后它
 * 会出现在树里，但那些字节的入口是各自的界面，不是文件树。
 */
const IGNORED = new Set([".git", ".armadra", "node_modules", "target", "dist"]);
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

/** 一次待确认的操作：新建 / 重命名 / 删除。 */
type PendingAction =
  | { kind: "create-file" | "create-folder"; parent: string }
  | { kind: "rename"; path: string; name: string }
  | { kind: "delete"; path: string; name: string };

export function FileTree() {
  const workspace = useCanvasStore((state) => state.workspace);
  const writable = workspace?.permissions.write === true;
  const actions = useFileActions(workspace?.id);
  const [pending, setPending] = useState<PendingAction | null>(null);

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
    <div className="flex flex-col py-1 text-[13px]">
      {writable && (
        <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1">
          <IconButton
            label={t("fileOps.newFile")}
            onClick={() => setPending({ kind: "create-file", parent: "." })}
          >
            <FilePlus />
          </IconButton>
          <IconButton
            label={t("fileOps.newFolder")}
            onClick={() => setPending({ kind: "create-folder", parent: "." })}
          >
            <FolderPlus />
          </IconButton>
        </div>
      )}
      <div role="tree" aria-label={t("explorer.tree")}>
        <Directory
          workspaceId={workspace.id}
          path="."
          depth={0}
          badges={badges}
          writable={writable}
          actions={actions}
          onAction={setPending}
        />
      </div>

      <FileEntryDialog
        open={
          pending?.kind === "create-file" || pending?.kind === "create-folder"
        }
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t(
          pending?.kind === "create-folder"
            ? "fileOps.newFolderTitle"
            : "fileOps.newFileTitle",
          { parent: pending && "parent" in pending ? pending.parent : "." },
        )}
        placeholder={t("fileOps.namePlaceholder")}
        confirmLabel={t("dialog.create")}
        onConfirm={(name) => {
          if (!pending || !("parent" in pending)) return;
          actions.createEntry(
            pending.parent,
            name,
            pending.kind === "create-folder" ? "directory" : "file",
          );
          setPending(null);
        }}
      />

      <FileEntryDialog
        open={pending?.kind === "rename"}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t("fileOps.renameTitle", {
          name: pending?.kind === "rename" ? pending.name : "",
        })}
        // 初值是完整路径，所以「改名」和「移动到别处」是同一个输入框。
        initialValue={pending?.kind === "rename" ? pending.path : ""}
        placeholder={t("fileOps.pathPlaceholder")}
        confirmLabel={t("dialog.confirm")}
        onConfirm={(next) => {
          if (pending?.kind !== "rename") return;
          actions.renameEntry(pending.path, next);
          setPending(null);
        }}
      />

      <AlertDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("fileOps.deleteTitle", {
                name: pending?.kind === "delete" ? pending.name : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("fileOps.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending?.kind !== "delete") return;
                actions.trashEntry(pending.path, pending.name);
                setPending(null);
              }}
            >
              {t("fileOps.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface TreeProps {
  workspaceId: string;
  path: string;
  depth: number;
  badges: BadgeMap;
  writable: boolean;
  actions: FileActions;
  onAction: (action: PendingAction) => void;
}

function Directory({
  workspaceId,
  path,
  depth,
  badges,
  writable,
  actions,
  onAction,
}: TreeProps) {
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
          writable={writable}
          actions={actions}
          onAction={onAction}
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
  writable,
  actions,
  onAction,
}: Omit<TreeProps, "path"> & { entry: FileEntry }) {
  const t = useT();
  const addNode = useCanvasStore((state) => state.addNode);
  const [open, setOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
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
      position: nodeDropPosition("editor"),
      data: { kind: "editor", path: entry.path, readonly: entry.readonly },
    });
  };

  /**
   * 把一次内部拖拽落到这个目录上就是移动。同一个工作区、同一个 Runtime 才
   * 接受——跨工作区的路径在这边没有意义，Runtime 也会拒绝；落回自己或自己
   * 的父目录都是无操作。
   */
  const acceptDrop = (event: DragEvent<HTMLElement>) => {
    setDropping(false);
    if (!directory || !writable || !hasWorkspaceFileDrag(event.dataTransfer))
      return;
    event.preventDefault();
    event.stopPropagation();
    let drag;
    try {
      drag = readWorkspaceFileDrag(event.dataTransfer);
    } catch {
      return;
    }
    if (drag.workspaceId !== workspaceId) return;
    for (const moved of drag.entries) {
      if (moved.path === entry.path || parentOf(moved.path) === entry.path)
        continue;
      actions.renameEntry(moved.path, joinPath(entry.path, moved.name));
    }
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
        dropping && "bg-[var(--hover)] ring-1 ring-[var(--brand)]",
      )}
      onClick={activate}
      onDragOver={(event) => {
        if (
          !directory ||
          !writable ||
          !hasWorkspaceFileDrag(event.dataTransfer)
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={acceptDrop}
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
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          {directory && (
            <ContextMenuItem
              onSelect={() =>
                addNode("files", {
                  title: entry.name,
                  position: nodeDropPosition("files"),
                  data: { kind: "files", path: entry.path },
                })
              }
            >
              <Folder />
              {t("explorer.newFilesNode")}
            </ContextMenuItem>
          )}
          {writable && directory && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() =>
                  onAction({ kind: "create-file", parent: entry.path })
                }
              >
                <FilePlus />
                {t("fileOps.newFile")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  onAction({ kind: "create-folder", parent: entry.path })
                }
              >
                <FolderPlus />
                {t("fileOps.newFolder")}
              </ContextMenuItem>
            </>
          )}
          {writable && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() =>
                  onAction({
                    kind: "rename",
                    path: entry.path,
                    name: entry.name,
                  })
                }
              >
                <Pencil />
                {t("fileOps.rename")}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() =>
                  onAction({
                    kind: "delete",
                    path: entry.path,
                    name: entry.name,
                  })
                }
              >
                <Trash2 />
                {t("fileOps.delete")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {directory && open && (
        <Directory
          workspaceId={workspaceId}
          path={entry.path}
          depth={depth + 1}
          badges={badges}
          writable={writable}
          actions={actions}
          onAction={onAction}
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
