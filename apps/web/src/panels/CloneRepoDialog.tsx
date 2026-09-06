import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import type { WorkspaceSummary } from "@armadra/shared";
import { toast } from "sonner";
import { runtimeApi } from "../api/client";
import { isTauri, pickDirectory } from "../platform";
import { useT } from "../app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Progress } from "@/ui/progress";

/** `git clone --progress` 每 500ms 至少写一行，比这更快地问没有意义。 */
const POLL_MS = 500;

/**
 * 从 `Receiving objects:  45% (12/34)` 这类行里取百分比。
 *
 * 取**最后**一个百分号：`Resolving deltas:  10% (1/10)` 只有一个，
 * 而 `Receiving objects: 100% (34/34), 12.00 KiB | 6.00 MiB/s` 里的
 * 速率不含 `%`，所以直接扫全行是安全的。
 */
export function cloneProgress(lines: readonly string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const matches = [...(lines[index] ?? "").matchAll(/(\d{1,3})%/g)];
    const last = matches[matches.length - 1];
    if (last) return Math.min(100, Number(last[1]));
  }
  return null;
}

export interface CloneRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned?: (workspace: WorkspaceSummary) => void;
}

/**
 * 克隆仓库（§20，2026-09-05 精简）：地址 + 父目录，没有别的。
 * 目录名与工作空间名都由 Runtime 从仓库地址推出来。
 *
 * Runtime 立刻返回 `jobId`，进度靠轮询——克隆完成之前还没有工作空间，
 * 也就没有工作空间事件流可用。完成时 Runtime 顺手建好工作空间并回给我们。
 */
export function CloneRepoDialog({
  open,
  onOpenChange,
  onCloned,
}: CloneRepoDialogProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);

  useEffect(() => {
    jobRef.current = jobId;
  }, [jobId]);

  useEffect(() => {
    if (open) {
      setUrl("");
      setParent("");
      setJobId(null);
      setFailure(null);
    }
  }, [open]);

  const start = useMutation({
    mutationFn: () =>
      runtimeApi.cloneRepository({
        url: url.trim(),
        parent: parent.trim(),
      }),
    onSuccess: (started) => {
      setFailure(null);
      setJobId(started.jobId);
    },
    onError: (cause: Error) => setFailure(cause.message),
  });

  const status = useQuery({
    queryKey: ["git-clone", jobId],
    queryFn: () => runtimeApi.gitCloneStatus(jobId as string),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data?.state === "running" || query.state.data === undefined
        ? POLL_MS
        : false,
    retry: false,
    gcTime: 0,
  });

  const finished = status.data?.workspace;
  useEffect(() => {
    if (!finished) return;
    setJobId(null);
    void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    onOpenChange(false);
    onCloned?.({ ...finished, boards: [] } as WorkspaceSummary);
  }, [finished, onCloned, onOpenChange, queryClient]);

  const errored = status.data?.state === "error" ? status.data : null;
  useEffect(() => {
    if (!errored) return;
    setJobId(null);
    setFailure(
      errored.error ?? errored.lines[errored.lines.length - 1] ?? null,
    );
  }, [errored]);

  useEffect(() => {
    if (status.error) {
      setJobId(null);
      setFailure((status.error as Error).message);
    }
  }, [status.error]);

  function stop() {
    const running = jobRef.current;
    if (running) void runtimeApi.cancelClone(running).catch(() => undefined);
    setJobId(null);
  }

  // 对话框被关掉（Esc / 点外面 / 取消）时不留后台任务。
  useEffect(() => {
    if (open) return;
    const running = jobRef.current;
    if (running) {
      void runtimeApi.cancelClone(running).catch(() => undefined);
      jobRef.current = null;
    }
  }, [open]);

  const lines = status.data?.lines ?? [];
  const lastLine = lines[lines.length - 1] ?? "";
  const percent = cloneProgress(lines);
  const running = jobId !== null;
  const ready = url.trim().length > 0 && parent.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{t("launcher.clone")}</DialogTitle>
        </DialogHeader>

        {/* 分组卡片：标签左 / 控件右（§24.2「分组表单」） */}
        <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-3 rounded-[var(--r-card)] border border-border bg-[var(--card)] p-4">
          <label className="text-muted-foreground" htmlFor="clone-url">
            {t("clone.url")}
          </label>
          <Input
            id="clone-url"
            value={url}
            disabled={running}
            onChange={(event) => setUrl(event.target.value)}
          />

          <label className="text-muted-foreground" htmlFor="clone-parent">
            {t("folder.parent")}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id="clone-parent"
              value={parent}
              disabled={running}
              onChange={(event) => setParent(event.target.value)}
            />
            {isTauri() && (
              <Button
                variant="outline"
                size="icon"
                disabled={running}
                aria-label={t("folder.choose")}
                onClick={() => {
                  void pickDirectory().then((picked) => {
                    if (picked) setParent(picked);
                  });
                }}
              >
                <FolderOpen />
              </Button>
            )}
          </div>
        </div>

        {running && (
          <div className="flex flex-col gap-1.5">
            <Progress
              value={percent ?? 0}
              aria-label={t("clone.progress")}
              className={percent === null ? "animate-pulse" : undefined}
            />
            <span className="truncate font-mono text-[length:var(--text-caption)] text-muted-foreground">
              {lastLine}
            </span>
          </div>
        )}

        {failure && (
          <Badge variant="destructive" className="max-w-full justify-start">
            <span className="truncate">{failure}</span>
          </Badge>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              stop();
              onOpenChange(false);
            }}
          >
            {t("dialog.cancel")}
          </Button>
          <Button
            disabled={!ready || running || start.isPending}
            onClick={() => start.mutate()}
          >
            {t("clone.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
