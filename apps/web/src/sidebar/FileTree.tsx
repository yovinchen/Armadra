/**
 * Project file tree (plan §1.2 “项目文件树（可拖、Git M/A 徽标）”).
 *
 * Folders expand lazily — one `listFiles` query per open directory — and every
 * row is a drag source for the canvas (`canvas/dnd/payload.ts`). Git status
 * badges come from `gitDiff`, refreshed every 15 s.
 */
import { useMemo, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DiffFileStatus, FileEntry } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import {
  fileNodeData,
  isImagePath,
  guessMimeType,
  setDragPayload,
  clearDragPayload,
  type DragPayload,
} from "../canvas/dnd/payload";

/** Never worth browsing; the runtime already hides some of these. */
const IGNORED = new Set([".git", "node_modules", "target", "dist"]);

const GIT_REFETCH_MS = 15_000;

type BadgeMap = Map<string, DiffFileStatus>;

export function FileTree() {
  const workspace = useCanvasStore((state) => state.workspace);

  const diff = useQuery({
    queryKey: ["git-diff", workspace?.id],
    queryFn: () => runtimeApi.gitDiff(workspace!.id),
    enabled: Boolean(workspace),
    refetchInterval: GIT_REFETCH_MS,
    retry: false,
  });

  const badges = useMemo<BadgeMap>(() => {
    const map: BadgeMap = new Map();
    for (const file of diff.data?.files ?? []) map.set(file.path, file.status);
    return map;
  }, [diff.data]);

  if (!workspace) return null;

  return (
    <div className="file-tree" role="tree" aria-label="项目文件">
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
  const { t } = usePreferences();
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
        <p className="panel-state" style={indent(depth)}>
          {t("explorer.loading")}
        </p>
      )}
      {files.isError && (
        <div
          className="panel-state panel-state--error"
          role="alert"
          style={indent(depth)}
        >
          <p>{files.error.message}</p>
          <button
            type="button"
            className="secondary-action"
            onClick={() => void files.refetch()}
          >
            {t("explorer.retry")}
          </button>
        </div>
      )}
      {files.isSuccess && entries.length === 0 && (
        <p className="panel-state" style={indent(depth)}>
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
        <p className="panel-state" role="status" style={indent(depth)}>
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
  const { t } = usePreferences();
  const addNode = useCanvasStore((state) => state.addNode);
  const [open, setOpen] = useState(false);

  const directory = entry.kind === "directory";
  const image = !directory && isImagePath(entry.name);
  const badge = badges.get(entry.path);
  const glyph = directory ? (open ? "▾" : "▸") : image ? "▣" : "▤";

  const payload: DragPayload = directory
    ? { kind: "folder", path: entry.path, name: entry.name }
    : image
      ? {
          kind: "image",
          path: entry.path,
          name: entry.name,
          mimeType: guessMimeType(entry.name),
        }
      : {
          kind: "file",
          path: entry.path,
          name: entry.name,
          size: entry.size,
          mimeType: guessMimeType(entry.name),
        };

  const activate = () => {
    if (directory) {
      setOpen((value) => !value);
      return;
    }
    // Keeps the A3 behaviour: clicking a file drops it on the board.
    addNode(
      fileNodeData({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        mimeType: guessMimeType(entry.name),
        readonly: entry.readonly,
      }),
    );
  };

  return (
    <>
      <div
        className={`file-row${badge ? " file-row--changed" : ""}`}
        role="treeitem"
        tabIndex={0}
        aria-expanded={directory ? open : undefined}
        aria-label={
          directory
            ? t("explorer.browse", { name: entry.name })
            : t("explorer.add", { name: entry.name })
        }
        title={entry.path}
        draggable
        style={indent(depth)}
        onDragStart={(event: DragEvent<HTMLDivElement>) =>
          setDragPayload(event, payload)
        }
        onDragEnd={() => clearDragPayload()}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        }}
      >
        <span className="file-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="file-name">{entry.name}</span>
        {badge && (
          <span
            className="file-badge"
            data-status={badge}
            title={t(`explorer.status.${badge}`)}
          >
            {badge}
          </span>
        )}
      </div>
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

/** 12px per level, on top of the 8px row padding (template.html). */
function indent(depth: number) {
  return { paddingLeft: `${8 + depth * 12}px` };
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}
