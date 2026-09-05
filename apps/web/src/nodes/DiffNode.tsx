import * as React from "react";
import type { DiffScope, GitFileDiff } from "@armadra/shared";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
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

  React.useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setFailed(false);
    const paths = pathKey ? pathKey.split("\n") : undefined;
    runtimeApi
      .gitDiff(workspaceId, { scope, paths })
      .then((diff) => {
        if (!cancelled) setFiles(diff.files);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, pathKey, scope, workspaceId]);

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
        label={t("diff.refresh")}
        onClick={() => setNonce((value) => value + 1)}
      >
        <RefreshCw />
      </IconButton>
    </>
  );

  return (
    <NodeShell node={node} selected={selected} headerActions={headerActions}>
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
}: {
  file: GitFileDiff;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
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
          {file.previewable ? (
            <PatchBody patch={file.patch} />
          ) : (
            <div className="px-2 py-1">
              <Badge variant="outline">{t("diff.binary")}</Badge>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 逐行着色的 unified patch。行本身不可交互，所以用 `<div>` 而不是列表控件。 */
function PatchBody({ patch }: { patch: string }) {
  const lines = React.useMemo(() => patch.split("\n"), [patch]);
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-[1.45]">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "px-2 whitespace-pre",
            line.startsWith("@@")
              ? "bg-[var(--brand-soft)] text-[var(--brand-text)]"
              : line.startsWith("+") && !line.startsWith("+++")
                ? "bg-[var(--success-soft)] text-[var(--success)]"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                  : "text-muted-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
