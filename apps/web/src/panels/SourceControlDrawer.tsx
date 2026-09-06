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
  ChevronLeft,
  ChevronRight,
  GitBranch,
  RotateCw,
  X,
} from "lucide-react";
import type {
  DiffScope,
  GitFileStatus,
  GitHunkScope,
  GitRestoreSource,
} from "@armadra/shared";

import { runtimeApi } from "../api/client";
import { gitGateway } from "../git/gateway";
import { gitTarget } from "../git/target";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { useCompactLayout } from "../platform/layout";
import { cn } from "../lib/cn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { ScrollArea } from "../ui/scroll-area";
import { SheetTitle } from "../ui/sheet";
import { WorkPanelSheet } from "./WorkPanelSheet";
import { ExecutionHostBadge } from "./ExecutionHostBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  ChangeSection,
  type ChangeActions,
  type ChangeEntry as Row,
} from "./git/ChangeList";
import { CommitComposer } from "./git/CommitComposer";
import {
  SourceControlDialogs,
  type RestoreTarget,
} from "./git/SourceControlDialogs";
import {
  GitRepositoryPanel,
  type RepositoryTab,
} from "./git/GitRepositoryPanel";
import {
  ALL_REPOSITORIES,
  RepositoryList,
  RepositorySwitcher,
  useRepositories,
  type RepositorySelection,
} from "./git/Repositories";
import { nodeDropPosition } from "@/canvas/placement";
import { ChangesHunks } from "./git/ChangesHunks";
import { invalidateGitQueries } from "./git/queries";
import { CommitMessageAssistant } from "./git/CommitMessageAssistant";

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

/**
 * 抽屉里的分区。桌面上是一排页签，手机上是第一级列表——同一批内容，
 * 460px 的页签在 390px 宽里挤成一团，点不准。
 */
export const SCM_SECTIONS = [
  "changes",
  "branches",
  "history",
  // 引用日志紧跟历史：它是同一个问题的另一半——历史说「现在有什么」，
  // reflog 说「刚才还有什么」。
  "reflog",
  "worktrees",
  "stashes",
  "tags",
  "remotes",
  "integration",
] as const;

export function SourceControlDrawer() {
  const mode = useCanvasStore((state) => state.panels.scm);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const queryClient = useQueryClient();
  const t = useT();

  const [message, setMessage] = useState("");
  const [restore, setRestore] = useState<RestoreTarget | null>(null);
  const [confirmInit, setConfirmInit] = useState(false);
  const [amend, setAmend] = useState(false);
  const [acknowledgePublished, setAcknowledgePublished] = useState(false);
  const [tab, setTab] = useState<"changes" | RepositoryTab>("changes");
  // 选中的仓库（roadmap §4.1）。`"."` 是工作空间根，`ALL_REPOSITORIES` 只在
  // Changes 页有效，而且是只读聚合——提交永远作用于一个明确的仓库。
  const [selection, setSelection] = useState<RepositorySelection>(".");
  const [hunk, setHunk] = useState<{
    workspaceId: string;
    file: string;
    scope: GitHunkScope;
  } | null>(null);
  /**
   * 手机上的三级导航：分区列表 → 分区详情 → 单个文件的差异。
   * `drilled` 记的是有没有从第一级点进去；`hunk` 本身就是第三级。
   */
  const compact = useCompactLayout();
  const [drilled, setDrilled] = useState(false);

  const workspaceId = workspace?.id ?? null;
  const open = mode === "drawer";
  // Reopening starts at the list again: a phone drawer that reopens three
  // levels deep is a drawer whose back button leads somewhere unexpected.
  useEffect(() => {
    if (!open) {
      setDrilled(false);
      setHunk(null);
    }
  }, [open]);

  const repositories = useRepositories(open ? workspaceId : null);
  const records = repositories.data?.repositories ?? [];
  const aggregate = selection === ALL_REPOSITORIES;
  // 聚合视图只在 Changes 页存在；切到别的页时落回一个明确仓库，否则那些页
  // 会不知道自己在读哪个仓库。
  const repositoryPath = aggregate ? "." : selection;
  // 读和写走同一条归属判定。切到 Host 之后直连 Runtime 的读读的是「那台
  // Runtime 眼里的仓库」，而暂存排在 Host 的队列上——同一个抽屉里两半数据
  // 来自两侧，正是「暂存了却看不到」这类报告的来源。
  const target = gitTarget(
    workspaceId ?? "",
    workspace?.rootPath,
    repositoryPath,
  );
  const status = useQuery({
    queryKey: ["git-status", workspaceId, repositoryPath],
    queryFn: ({ signal }) => gitGateway.status(target, {}, signal),
    enabled: open && Boolean(workspaceId) && !aggregate,
    retry: false,
  });
  /**
   * 「全部仓库」：逐个仓库读状态再拼起来。这是只读视图——每一行都记住自己
   * 来自哪个仓库，暂存 / 还原按钮因此仍然打到正确的仓库上，但提交按钮在这
   * 个视图里是关掉的。
   */
  const everything = useQuery({
    queryKey: [
      "git-status-all",
      workspaceId,
      records.map((record) => record.repositoryPath).join(","),
    ],
    queryFn: async ({ signal }) => {
      // 一次请求读完所有检出。原来是每个仓库一次往返，十二个仓库就是十二
      // 次；更糟的是那十二个答案被当成一份列表渲染，而它们是十二个不同时刻
      // 观察到的。读不出来的仓库带着自己的失败回来，不会把其余的一起清空。
      const answer = await gitGateway.statusBatch(
        target,
        records.map((record) => record.repositoryPath),
        {},
        signal,
      );
      const named = new Map(
        records.map((record) => [record.repositoryPath, record.name]),
      );
      return answer.repositories.flatMap((entry) =>
        (entry.status?.files ?? []).map((file) => ({
          ...file,
          repositoryPath: entry.path,
          repositoryName: named.get(entry.path) ?? entry.path,
        })),
      );
    },
    enabled: open && Boolean(workspaceId) && aggregate && records.length > 0,
    retry: false,
  });
  /** 聚合视图里每一行都记着自己来自哪个仓库，写就打到那个仓库上。 */
  const at = (repository: string) =>
    gitTarget(workspaceId ?? "", workspace?.rootPath, repository);
  const invalidate = () => invalidateGitQueries(queryClient, workspaceId);
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : t("scm.failed"));

  const stage = useMutation({
    mutationFn: (input: { path: string; repository?: string }) =>
      gitGateway.stage(
        at(input.repository ?? repositoryPath),
        [input.path],
        `stage/${input.repository ?? repositoryPath}/${crypto.randomUUID()}`,
      ),
    onSuccess: invalidate,
    onError: fail,
  });
  const unstage = useMutation({
    mutationFn: (input: { path: string; repository?: string }) =>
      gitGateway.unstage(
        at(input.repository ?? repositoryPath),
        [input.path],
        `unstage/${input.repository ?? repositoryPath}/${crypto.randomUUID()}`,
      ),
    onSuccess: invalidate,
    onError: fail,
  });
  const revert = useMutation({
    mutationFn: (input: {
      path: string;
      source: GitRestoreSource;
      repository?: string;
    }) =>
      gitGateway.revert(
        at(input.repository ?? repositoryPath),
        [input.path],
        input.source,
        `revert/${input.repository ?? repositoryPath}/${crypto.randomUUID()}`,
      ),
    onSuccess: invalidate,
    onError: fail,
  });
  // The commit an amend would rewrite. Read separately from status so the
  // composer can name the exact subject and OID it is about to replace.
  const headCommit = useQuery({
    queryKey: ["git-head-commit", workspaceId, repositoryPath],
    queryFn: ({ signal }) =>
      runtimeApi.gitHeadCommit(workspaceId!, signal, repositoryPath),
    enabled:
      open &&
      Boolean(workspaceId) &&
      !aggregate &&
      status.data?.repository === true,
    retry: false,
  });
  const head = headCommit.data ?? null;
  const amendable = Boolean(head) && !head!.truncated;
  const amendPayload =
    amend && head
      ? { expectedHead: head.oid, allowPublished: acknowledgePublished }
      : undefined;
  const commit = useMutation({
    mutationFn: (text: string) =>
      gitGateway.commit(
        target,
        text,
        `commit/${repositoryPath}/${crypto.randomUUID()}`,
        undefined,
        amendPayload,
      ),
    onSuccess: (result) => {
      setMessage("");
      setAmend(false);
      setAcknowledgePublished(false);
      invalidate();
      toast.success(t("scm.committed", { commit: result.commit.slice(0, 7) }));
    },
    onError: fail,
  });
  // Creating a repository is never implied by another action: the button only
  // appears once a read reported no repository, and it still asks first.
  const init = useMutation({
    mutationFn: () => gitGateway.init(target, `init/${crypto.randomUUID()}`),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        t("scm.initialized", { branch: result.branch ?? result.path }),
      );
    },
    onError: fail,
  });

  const files = useMemo<Row[]>(
    () => (aggregate ? (everything.data ?? []) : (status.data?.files ?? [])),
    [aggregate, everything.data, status.data],
  );
  const { staged, changes } = useMemo(() => partitionChanges(files), [files]);

  // Rewriting a published commit needs its own acknowledgement, so it gates
  // the button as well as the request body.
  const amendBlocked =
    amend &&
    (!head || head.truncated || (head.published && !acknowledgePublished));
  // 聚合视图里没有「当前仓库」可言，所以那里不提交：一次请求只作用于一个
  // 明确的仓库，跨仓库一次提交是刻意不做的。
  const canCommit =
    message.trim().length > 0 &&
    !commit.isPending &&
    !amendBlocked &&
    !aggregate;
  useEffect(() => {
    if (!open || tab !== "changes") return;
    const submit = () => {
      if (canCommit) commit.mutate(message.trim());
    };
    window.addEventListener(SCM_COMMIT_EVENT, submit);
    return () => window.removeEventListener(SCM_COMMIT_EVENT, submit);
  }, [open, tab, message, commit, canCommit]);
  // Starting from the stored message keeps an amend from silently dropping
  // the body of the commit it replaces.
  const toggleAmend = (next: boolean) => {
    setAmend(next);
    setAcknowledgePublished(false);
    if (next && head && !head.truncated && message.trim().length === 0)
      setMessage(head.message);
  };

  const openDiff = (path: string, scope: DiffScope, repository: string) => {
    if (!workspace) return;
    addNode("diff", {
      title: path,
      position: nodeDropPosition("diff"),
      data: {
        kind: "diff",
        // 路径是相对被选中的仓库的，diff 节点也必须开在那个仓库上。
        repoPath:
          repository === "."
            ? workspace.rootPath
            : `${workspace.rootPath.replace(/[\\/]+$/, "")}/${repository}`,
        scope,
        paths: [path],
      },
    });
    setPanel("scm", "closed");
  };

  const changeActions: ChangeActions = {
    repositoryPath,
    onHunk: (path, scope) => {
      if (!workspaceId) return;
      setTab("changes");
      setDrilled(true);
      setHunk({ workspaceId, file: path, scope });
    },
    onDiff: openDiff,
    onStage: stage.mutate,
    onUnstage: unstage.mutate,
    onRestore: setRestore,
  };

  const section = (label: string, rows: Row[], scope: DiffScope) => (
    <ChangeSection
      label={label}
      rows={rows}
      scope={scope}
      actions={changeActions}
    />
  );

  return (
    <>
      <WorkPanelSheet
        panel="scm"
        open={open}
        onClose={() => setPanel("scm", "closed")}
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
            {t("scm.title")}
          </SheetTitle>
          <ExecutionHostBadge />
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
          <IconButton label={t("scm.refresh")} onClick={invalidate}>
            <RotateCw />
          </IconButton>
          <IconButton
            label={t("scm.close")}
            onClick={() => setPanel("scm", "closed")}
          >
            <X />
          </IconButton>
        </div>

        {records.length > 1 && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
            <RepositorySwitcher
              repositories={records}
              value={selection}
              allowAll={tab === "changes"}
              pending={repositories.isPending}
              onChange={setSelection}
            />
          </div>
        )}
        {compact && !drilled && (
          <nav
            aria-label={t("scm.sections")}
            data-slot="scm-sections"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {SCM_SECTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className="flex min-h-12 w-full items-center gap-2 border-b border-border/60 px-4 text-left text-[13px] hover:bg-muted"
                onClick={() => {
                  setTab(value);
                  setDrilled(true);
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {t(`gitRepo.${value}`)}
                </span>
                {value === "changes" && files.length > 0 && (
                  <Badge variant="ghost" className="tabular-nums">
                    {files.length}
                  </Badge>
                )}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </nav>
        )}
        {compact && drilled && (
          <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border px-2">
            <Button
              size="sm"
              variant="ghost"
              className="min-h-10 shrink-0 px-2"
              onClick={() => (hunk ? setHunk(null) : setDrilled(false))}
            >
              <ChevronLeft aria-hidden />
              <span>{t("scm.back")}</span>
            </Button>
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {hunk ? hunk.file : t(`gitRepo.${tab}`)}
            </span>
          </div>
        )}
        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = value as "changes" | RepositoryTab;
            setTab(next);
            // 只有 Changes 有聚合视图；离开时落回一个明确的仓库。
            if (next !== "changes" && selection === ALL_REPOSITORIES)
              setSelection(".");
          }}
          className={cn(
            "min-h-0 min-w-0 flex-1 gap-0",
            compact && !drilled && "hidden",
          )}
        >
          <TabsList
            className={cn(
              "h-10 w-full shrink-0 rounded-none border-b border-border",
              compact && "hidden",
            )}
            variant="line"
          >
            {SCM_SECTIONS.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="min-w-0 text-xs"
              >
                {t(`gitRepo.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent
            value="changes"
            className="mt-0 flex min-h-0 flex-col data-[state=inactive]:hidden"
          >
            <ScrollArea className="min-h-0 flex-1">
              {workspaceId && status.data?.repository && (
                <details className="m-3 rounded-md border border-border p-2 text-xs">
                  <summary className="cursor-pointer">
                    {t("gitMessage.title")}
                  </summary>
                  <CommitMessageAssistant
                    workspaceId={workspaceId}
                    message={message}
                    onFill={setMessage}
                    providers={runtimeApi.gitMessageProviders}
                    source={runtimeApi.gitMessageSource}
                    generate={runtimeApi.gitMessageGenerate}
                  />
                </details>
              )}
              {hunk && hunk.workspaceId === workspaceId && (
                <section className="border-b border-border p-3">
                  {!compact && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setHunk(null)}
                    >
                      {t("gitHunk.close")}
                    </Button>
                  )}
                  <ChangesHunks
                    key={`${hunk.workspaceId}:${hunk.scope}:${hunk.file}`}
                    {...hunk}
                    load={runtimeApi.gitHunks}
                    apply={runtimeApi.gitApplyHunk}
                    onChanged={(id) => {
                      invalidateGitQueries(queryClient, id);
                    }}
                  />
                </section>
              )}
              {/* 多仓库时左侧按仓库分组，点一行就切换到那个仓库。 */}
              {records.length > 1 && (
                <div className="border-b border-border p-2">
                  <RepositoryList
                    repositories={records}
                    value={selection}
                    allowAll
                    onChange={setSelection}
                  />
                </div>
              )}
              {aggregate ? (
                everything.isPending ? (
                  <p role="status" className="px-4 py-3 text-xs">
                    {t("gitRepo.loading")}
                  </p>
                ) : everything.error ? (
                  <p
                    role="alert"
                    className="break-words px-4 py-3 text-xs text-destructive"
                  >
                    {everything.error.message}
                  </p>
                ) : files.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    {t("scm.clean")}
                  </p>
                ) : (
                  <>
                    <p className="px-4 pt-3 text-xs text-muted-foreground">
                      {t("gitRepo.aggregateReadOnly")}
                    </p>
                    {section(t("scm.staged"), staged, "staged")}
                    {section(t("scm.changes"), changes, "worktree")}
                  </>
                )
              ) : compact && hunk ? null : status.isPending ? (
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
                <div className="space-y-2 px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    {t("scm.noRepository")}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={init.isPending}
                    onClick={() => setConfirmInit(true)}
                  >
                    {t("scm.init")}
                  </Button>
                </div>
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

            <CommitComposer
              message={message}
              setMessage={setMessage}
              head={head}
              amend={amend}
              amendable={amendable}
              toggleAmend={toggleAmend}
              acknowledgePublished={acknowledgePublished}
              setAcknowledgePublished={setAcknowledgePublished}
              canCommit={canCommit}
              commit={commit.mutate}
              compact={compact}
              hunkOpen={Boolean(hunk)}
            />
          </TabsContent>
          {(
            [
              "branches",
              "history",
              "reflog",
              "worktrees",
              "stashes",
              "tags",
              "remotes",
              "integration",
            ] as const
          ).map((value) => (
            <TabsContent
              key={value}
              value={value}
              className="mt-0 flex min-h-0 min-w-0 flex-col data-[state=inactive]:hidden"
            >
              {workspaceId && tab === value && (
                <GitRepositoryPanel
                  key={`${workspaceId}:${repositoryPath}`}
                  workspaceId={workspaceId}
                  tab={value}
                  repositoryPath={repositoryPath}
                />
              )}
            </TabsContent>
          ))}
        </Tabs>
      </WorkPanelSheet>

      <SourceControlDialogs
        confirmInit={confirmInit}
        setConfirmInit={setConfirmInit}
        init={init.mutate}
        restore={restore}
        setRestore={setRestore}
        revert={revert.mutate}
      />
    </>
  );
}
