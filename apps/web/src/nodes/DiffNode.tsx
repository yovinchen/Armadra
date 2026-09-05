import * as React from "react";
import type { DiffScope, GitFileDiff } from "@armadra/shared";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  RefreshCw,
  Rows3,
} from "lucide-react";

import { cn } from "@/lib/cn";
import {
  countMatches,
  rowMatches,
  sideBySideRows,
  type SideBySideRow,
} from "@/lib/side-by-side";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";
import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/app/preferences-store";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/**
 * 变更节点（§3.4）：只读。接受 / 回滚在源码控制抽屉里，节点上不放，
 * 免得同一个破坏性动作有两个入口。
 *
 * `data.scope` 决定看索引的哪一侧（工作区 / 已暂存），`data.paths` 非空时
 * 只看这几个文件——抽屉里点「打开差异」就是这么开的。
 */
export function DiffNode({ node, selected }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "diff" ? node.data : undefined;
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const scope: DiffScope = data?.scope ?? "worktree";
  // 依赖数组要的是稳定值，节点数据里的数组每次读都是新引用。
  const pathKey = (data?.paths ?? []).join("\n");

  const [files, setFiles] = React.useState<GitFileDiff[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const [nonce, setNonce] = React.useState(0);
  const [sideBySide, setSideBySide] = React.useState(false);
  // 忽略空白只影响展示：节点是只读的，这里看到的补丁不会被暂存或应用。
  const [ignoreWhitespace, setIgnoreWhitespace] = React.useState(false);
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setFailed(false);
    const paths = pathKey ? pathKey.split("\n") : undefined;
    runtimeApi
      .gitDiff(workspaceId, { scope, paths, ignoreWhitespace })
      .then((diff) => {
        if (!cancelled) setFiles(diff.files);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, pathKey, scope, workspaceId, ignoreWhitespace]);

  function toggle(path: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const headerActions = (
    <>
      <Badge variant="ghost" className="shrink-0">
        {scope === "staged" ? t("diff.staged") : t("diff.worktree")}
      </Badge>
      <IconButton
        label={t(sideBySide ? "diff.unified" : "diff.sideBySide")}
        aria-pressed={sideBySide}
        onClick={() => setSideBySide((value) => !value)}
      >
        {sideBySide ? <Rows3 /> : <Columns2 />}
      </IconButton>
      <IconButton
        label={t("diff.refresh")}
        onClick={() => setNonce((value) => value + 1)}
      >
        <RefreshCw />
      </IconButton>
    </>
  );

  return (
    <NodeShell node={node} selected={selected} headerActions={headerActions}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("diff.search")}
          aria-label={t("diff.search")}
          className="h-7 min-w-32 flex-1 text-[11px]"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--brand)]"
            checked={ignoreWhitespace}
            onChange={(event) => setIgnoreWhitespace(event.target.checked)}
          />
          {t("diff.ignoreWhitespace")}
        </label>
      </div>
      <ScrollArea className="h-full w-full">
        {failed && (
          <div className="p-2">
            <Badge variant="destructive">{t("diff.failed")}</Badge>
          </div>
        )}
        {!failed && files && files.length === 0 && (
          <div className="p-2">
            <Badge variant="outline">{t("diff.clean")}</Badge>
          </div>
        )}
        {files?.map((file) => (
          <DiffFileRow
            key={file.path}
            file={file}
            open={open.has(file.path)}
            onToggle={() => toggle(file.path)}
            sideBySide={sideBySide}
            search={search}
            ignoreWhitespace={ignoreWhitespace}
          />
        ))}
      </ScrollArea>
    </NodeShell>
  );
}

const STATUS_COLOR: Record<GitFileDiff["status"], string> = {
  M: "var(--warn)",
  A: "var(--success)",
  D: "var(--danger)",
  R: "var(--brand)",
  "?": "var(--muted-foreground)",
};

function DiffFileRow({
  file,
  open,
  onToggle,
  sideBySide,
  search,
  ignoreWhitespace,
}: {
  file: GitFileDiff;
  open: boolean;
  onToggle: () => void;
  sideBySide: boolean;
  search: string;
  ignoreWhitespace: boolean;
}) {
  const t = useT();
  const rows = React.useMemo(
    () => (open && sideBySide ? sideBySideRows(file.patch) : []),
    [open, sideBySide, file.patch],
  );
  const matches = React.useMemo(
    () => (open ? countMatches(sideBySideRows(file.patch), search) : 0),
    [open, file.patch, search],
  );
  // 忽略空白时，只差空白的文件仍然列在这里（它确实变了），但补丁是空的。
  const whitespaceOnly =
    ignoreWhitespace &&
    file.previewable &&
    file.status !== "?" &&
    file.patch === "";
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-full justify-start gap-1.5 rounded-none px-1.5 font-normal"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        <span
          aria-hidden
          className="w-3 shrink-0 text-center font-mono text-[length:var(--text-caption)] font-bold"
          style={{ color: STATUS_COLOR[file.status] }}
        >
          {file.status}
        </span>
        <span className="truncate font-mono text-[11px]">{file.path}</span>
        <span className="ml-auto shrink-0 font-mono text-[length:var(--text-caption)] text-[var(--success)]">
          +{file.additions}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--text-caption)] text-[var(--danger)]">
          −{file.deletions}
        </span>
      </Button>
      {open && (
        <div className="bg-[var(--surface-sunken)] py-1">
          {search.trim() && (
            <p className="px-2 pb-1 text-[length:var(--text-caption)] text-muted-foreground">
              {t("diff.matches", { count: matches })}
            </p>
          )}
          {!file.previewable ? (
            <div className="px-2 py-1">
              <Badge variant="outline">{t("diff.binary")}</Badge>
            </div>
          ) : whitespaceOnly ? (
            <div className="px-2 py-1">
              <Badge variant="outline">{t("diff.whitespaceOnly")}</Badge>
            </div>
          ) : sideBySide ? (
            <SideBySideBody rows={rows} search={search} />
          ) : (
            <PatchBody patch={file.patch} search={search} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 逐行着色的 unified patch。行本身不可交互，所以用 `<div>` 而不是列表控件。
 * 编辑器的「比较」（E01/M4）复用同一套着色，磁盘版与草稿不另起一套样式。
 */
export function PatchBody({
  patch,
  search = "",
}: {
  patch: string;
  search?: string;
}) {
  const lines = React.useMemo(() => patch.split("\n"), [patch]);
  const needle = search.trim().toLowerCase();
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-[1.45]">
      {lines.map((line, index) => (
        <div
          key={index}
          data-match={
            needle && line.toLowerCase().includes(needle) ? "true" : undefined
          }
          className={cn(
            "px-2 whitespace-pre",
            line.startsWith("@@")
              ? "bg-[var(--brand-soft)] text-[var(--brand-text)]"
              : line.startsWith("+") && !line.startsWith("+++")
                ? "bg-[var(--success-soft)] text-[var(--success)]"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                  : "text-muted-foreground",
            needle &&
              line.toLowerCase().includes(needle) &&
              "outline outline-1 -outline-offset-1 outline-[var(--brand)]",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * 并排视图。左右两列都来自同一份 Git patch（见 `lib/side-by-side`），
 * 这里只负责排版和着色，不重新计算差异，也不猜没有对应行的那一侧。
 */
function SideBySideBody({
  rows,
  search,
}: {
  rows: readonly SideBySideRow[];
  search: string;
}) {
  const needle = search.trim().toLowerCase();
  return (
    <div className="overflow-x-auto font-mono text-[11px] leading-[1.45]">
      {rows.map((row, index) => {
        const highlighted = rowMatches(row, needle);
        return (
          <div
            key={index}
            data-match={highlighted ? "true" : undefined}
            className={cn(
              "grid grid-cols-2 gap-px",
              highlighted &&
                "outline outline-1 -outline-offset-1 outline-[var(--brand)]",
            )}
          >
            {(["left", "right"] as const).map((side) => {
              const cell = row[side];
              const changed = row.kind === "change";
              return (
                <div
                  key={side}
                  className={cn(
                    "flex min-w-0 gap-2 px-2 whitespace-pre",
                    row.kind === "hunk"
                      ? "bg-[var(--brand-soft)] text-[var(--brand-text)]"
                      : row.kind === "meta"
                        ? "text-muted-foreground"
                        : !cell
                          ? "bg-[var(--surface-sunken)]"
                          : changed && side === "left"
                            ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                            : changed
                              ? "bg-[var(--success-soft)] text-[var(--success)]"
                              : "text-muted-foreground",
                  )}
                >
                  <span
                    aria-hidden
                    className="w-8 shrink-0 text-right text-[length:var(--text-caption)] text-muted-foreground"
                  >
                    {cell?.number ?? ""}
                  </span>
                  <span className="min-w-0">{cell?.text || " "}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
