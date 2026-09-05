/**
 * 源码控制抽屉（§3.6，⌘⇧G）。
 *
 * 460px 右侧抽屉：分支 + 变更列表 + 逐文件 暂存 / 取消暂存 / 打开差异 /
 * 回滚，底部提交框（⌘⏎ 由壳发 `armadra:scm-commit` 事件触发）。
 *
 * 列表来自 `gitStatus().files`：一个文件既可能在「已暂存」也可能在
 * 「变更」里（`XY` 两列都非空，例如暂存后又改了一次），两边都渲染一行，
 * 各自打开对应 scope 的差异。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileDiff,
  ListFilter,
  GitBranch,
  Minus,
  Plus,
  RotateCw,
  Undo2,
  X,
} from "lucide-react";
import type { DiffScope, GitFileStatus, GitHunkScope } from "@armadra/shared";

type DiffFileStatus = GitFileStatus["status"];

import { runtimeApi } from "../api/client";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  GitRepositoryPanel,
  type RepositoryTab,
} from "./git/GitRepositoryPanel";
import { currentViewportCenter } from "./viewport";
import { ChangesHunks } from "./git/ChangesHunks";

const STATUS_COLOR: Record<DiffFileStatus, string> = {
  M: "var(--warn)",
  A: "var(--success)",
  D: "var(--danger)",
  R: "var(--brand)",
  "?": "var(--muted-foreground)",
};

/** 提交框的 ⌘⏎：壳的快捷键处理器发这个窗口事件，抽屉自己听。 */
export const SCM_COMMIT_EVENT = "armadra:scm-commit";

/**
 * `X` 列非空 → 已暂存，`Y` 列非空 → 工作区还有改动。两者都真时文件同时
 * 出现在两个分区，这正是 Git 的语义（暂存后又改了一次）。
 */
export function partitionChanges(files: readonly GitFileStatus[]): {
  staged: GitFileStatus[];
  changes: GitFileStatus[];
} {
  return {
    staged: files.filter((file) => file.staged),
    changes: files.filter((file) => file.unstaged),
  };
}

export function SourceControlDrawer() {
  const mode = useCanvasStore((state) => state.panels.scm);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const queryClient = useQueryClient();
  const t = useT();

  const [message, setMessage] = useState("");
  const [revertPath, setRevertPath] = useState<string | null>(null);
  const [tab, setTab] = useState<"changes" | RepositoryTab>("changes");
  const [hunk, setHunk] = useState<{
    workspaceId: string;
    file: string;
    scope: GitHunkScope;
  } | null>(null);

  const workspaceId = workspace?.id ?? null;
  const open = mode === "drawer";

  const status = useQuery({
    queryKey: ["git-status", workspaceId],
    queryFn: () => runtimeApi.gitStatus(workspaceId!),
    enabled: open && Boolean(workspaceId),
    retry: false,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["git-status", workspaceId],
    });
    void queryClient.invalidateQueries({ queryKey: ["git-diff", workspaceId] });
  };
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : t("scm.failed"));

  const stage = useMutation({
    mutationFn: (path: string) => runtimeApi.gitStage(workspaceId!, [path]),
    onSuccess: invalidate,
    onError: fail,
  });
  const unstage = useMutation({
    mutationFn: (path: string) => runtimeApi.gitUnstage(workspaceId!, [path]),
    onSuccess: invalidate,
    onError: fail,
  });
  const revert = useMutation({
    mutationFn: (path: string) => runtimeApi.gitRevert(workspaceId!, [path]),
    onSuccess: invalidate,
    onError: fail,
  });
  const commit = useMutation({
    mutationFn: (text: string) => runtimeApi.gitCommit(workspaceId!, text),
    onSuccess: (result) => {
      setMessage("");
      invalidate();
      toast.success(t("scm.committed", { commit: result.commit.slice(0, 7) }));
    },
    onError: fail,
  });

  const files = useMemo<GitFileStatus[]>(
    () => status.data?.files ?? [],
    [status.data],
  );
  const { staged, changes } = useMemo(() => partitionChanges(files), [files]);

  const canCommit = message.trim().length > 0 && !commit.isPending;
  useEffect(() => {
    if (!open || tab !== "changes") return;
    const submit = () => {
      if (message.trim().length > 0 && !commit.isPending) {
        commit.mutate(message.trim());
      }
    };
    window.addEventListener(SCM_COMMIT_EVENT, submit);
    return () => window.removeEventListener(SCM_COMMIT_EVENT, submit);
  }, [open, tab, message, commit]);

  const openDiff = (path: string, scope: DiffScope) => {
    if (!workspace) return;
    addNode("diff", {
      title: path,
      position: currentViewportCenter(),
      data: {
        kind: "diff",
        repoPath: workspace.rootPath,
        scope,
        paths: [path],
      },
    });
    setPanel("scm", "closed");
  };

  const row = (file: GitFileStatus, scope: DiffScope) => (
    <div
      key={`${scope}:${file.path}`}
      className="group flex h-8 items-center gap-2 rounded-md px-2 hover:bg-muted"
    >
      <Badge
        variant="ghost"
        className="h-4 w-4 shrink-0 justify-center p-0 font-mono text-[length:var(--text-caption)]"
        style={{ color: STATUS_COLOR[file.status] }}
        title={t(`explorer.status.${file.status}`)}
      >
        {file.status}
      </Badge>
      <span className="flex-1 truncate text-[13px]" title={file.path}>
        {file.path}
      </span>
      <div className="flex items-center gap-0.5">
        <IconButton
          label={t("gitHunk.title")}
          onClick={() =>
            workspaceId && setHunk({ workspaceId, file: file.path, scope })
          }
        >
          <ListFilter />
        </IconButton>
        <IconButton
          label={t("scm.diff")}
          onClick={() => openDiff(file.path, scope)}
        >
          <FileDiff />
        </IconButton>
        {scope === "staged" ? (
          <IconButton
            label={t("scm.unstage")}
            onClick={() => unstage.mutate(file.path)}
          >
            <Minus />
          </IconButton>
        ) : (
          <>
            <IconButton
              label={t("scm.stage")}
              onClick={() => stage.mutate(file.path)}
            >
              <Plus />
            </IconButton>
            <IconButton
              label={t("scm.revert")}
              onClick={() => setRevertPath(file.path)}
            >
              <Undo2 />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );

  const section = (label: string, rows: GitFileStatus[], scope: DiffScope) =>
    rows.length === 0 ? null : (
      <section className="px-2 py-1">
        <h3 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
          {label}
          <span className="ml-1 tabular-nums">{rows.length}</span>
        </h3>
        {rows.map((file) => row(file, scope))}
      </section>
    );

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) setPanel("scm", "closed");
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          className="max-w-full gap-0 p-0 data-[side=right]:w-[min(100vw,var(--scm-w))] data-[side=right]:sm:max-w-none"
        >
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
            <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
              {t("scm.title")}
            </SheetTitle>
            {status.data?.branch && (
              <Badge
                variant="outline"
                className="ml-2 max-w-[35%] gap-1 truncate font-mono"
              >
                <GitBranch />
                {status.data.branch}
              </Badge>
            )}
            {Boolean(status.data?.ahead) && (
              <Badge variant="ghost" className="tabular-nums">
                ↑{status.data?.ahead}
              </Badge>
            )}
            {Boolean(status.data?.behind) && (
              <Badge variant="ghost" className="tabular-nums">
                ↓{status.data?.behind}
              </Badge>
            )}
            <div className="flex-1" />
            <IconButton
              label={t("scm.refresh")}
              onClick={() => void status.refetch()}
            >
              <RotateCw />
            </IconButton>
            <IconButton
              label={t("scm.close")}
              onClick={() => setPanel("scm", "closed")}
            >
              <X />
            </IconButton>
          </div>

          <Tabs
            value={tab}
            onValueChange={(value) =>
              setTab(value as "changes" | RepositoryTab)
            }
            className="min-h-0 min-w-0 flex-1 gap-0"
          >
            <TabsList
              className="h-10 w-full shrink-0 rounded-none border-b border-border"
              variant="line"
            >
              {(["changes", "branches", "history", "worktrees"] as const).map(
                (value) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="min-w-0 text-xs"
                  >
                    {t(`gitRepo.${value}`)}
                  </TabsTrigger>
                ),
              )}
            </TabsList>
            <TabsContent
              value="changes"
              className="mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden"
            >
              <ScrollArea className="min-h-0 flex-1">
                {hunk && hunk.workspaceId === workspaceId && (
                  <section className="border-b border-border p-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setHunk(null)}
                    >
                      {t("gitHunk.close")}
                    </Button>
                    <ChangesHunks
                      key={`${hunk.workspaceId}:${hunk.scope}:${hunk.file}`}
                      {...hunk}
                      load={runtimeApi.gitHunks}
                      apply={runtimeApi.gitApplyHunk}
                      onChanged={(id) => {
                        void queryClient.invalidateQueries({
                          queryKey: ["git-status", id],
                        });
                        void queryClient.invalidateQueries({
                          queryKey: ["git-diff", id],
                        });
                      }}
                    />
                  </section>
                )}
                {status.isPending ? (
                  <p role="status" className="px-4 py-3 text-xs">
                    {t("gitRepo.loading")}
                  </p>
                ) : status.error ? (
                  <p
                    role="alert"
                    className="break-words px-4 py-3 text-xs text-destructive"
                  >
                    {status.error.message}
                  </p>
                ) : status.data?.repository === false ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    {t("scm.noRepository")}
                  </p>
                ) : files.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    {t("scm.clean")}
                  </p>
                ) : (
                  <>
                    {section(t("scm.staged"), staged, "staged")}
                    {section(t("scm.changes"), changes, "worktree")}
                  </>
                )}
              </ScrollArea>

              <div className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={t("scm.message")}
                  aria-label={t("scm.message")}
                  className="min-h-[64px] resize-none"
                />
                <Button
                  className="self-end"
                  size="sm"
                  disabled={!canCommit}
                  onClick={() => commit.mutate(message.trim())}
                >
                  {t("scm.commit")}
                </Button>
              </div>
            </TabsContent>
            {(["branches", "history", "worktrees"] as const).map((value) => (
              <TabsContent
                key={value}
                value={value}
                className="mt-0 flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden"
              >
                {workspaceId && tab === value && (
                  <GitRepositoryPanel
                    key={workspaceId}
                    workspaceId={workspaceId}
                    tab={value}
                  />
                )}
              </TabsContent>
            ))}
          </Tabs>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={revertPath !== null}
        onOpenChange={(next) => {
          if (!next) setRevertPath(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("scm.revertTitle", { path: revertPath ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("scm.revertDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("scm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revertPath) revert.mutate(revertPath);
                setRevertPath(null);
              }}
            >
              {t("scm.revert")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
