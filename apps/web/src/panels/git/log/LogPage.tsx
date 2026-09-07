import { useCallback, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronLeft, PanelLeft, PanelRight, X } from "lucide-react";
import { toast } from "sonner";
import type { GitExpectedState, GitRepositoryAction } from "@armadra/shared";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { useCompactLayout } from "../../../platform/layout";
import { gitGateway } from "../../../git/gateway";
import { gitTarget } from "../../../git/target";
import { useCanvasStore } from "../../../store/canvas-store";
import { nodeDropPosition } from "@/canvas/placement";
import { Button } from "../../../ui/button";
import { IconButton } from "../../../ui/icon-button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../../ui/resizable";
import { ReadError } from "../forms";
import { Reflog } from "../Reflog";
import { RepositoryConfirmDialog } from "../RepositoryConfirmDialog";
import type { Confirmation } from "../operations";
import { invalidateGitQueries } from "../queries";
import { branchFromCommit, tagAtCommit } from "../actions/commit";
import { BranchTree } from "./BranchTree";
import { CommitDetails } from "./CommitDetails";
import { LogTable, UNCOMMITTED_KEY } from "./LogTable";
import { LogToolbar } from "./LogToolbar";
import { filterKey, logRequestFromPreferences } from "./filters";
import { gitLog, gitRefs } from "./log-client";
import { commitKey } from "./graph";
import { defaultExpanded, refKey, type BranchTreeNode } from "./build-tree";
import {
  BranchContextMenu,
  CommitContextMenu,
  NamePromptDialog,
  type MenuContext,
  type NamePrompt,
} from "./menus";
import type { LogCommit } from "./types";

/**
 * 日志页（Git 工具窗口设计 §2.2）：分支树 | 提交图表格 | 详情。
 *
 * 三件事在这里汇合，别处都不合适：
 *
 * - **一次读，三处用**。`GET …/git/refs` 一次给出所有仓库的分支树；
 *   `POST …/git/log` 按工具栏的条件在**服务端**筛选并合并多仓库的提交。
 * - **写仍然走老路**。右键菜单造出 `GitRepositoryAction`，这里接上已有的
 *   `RepositoryConfirmDialog` 与 `gitGateway.operate`——没有新的写路径，
 *   确认与串行都还是那一套。
 * - **手机是四级**（§2.1）：分支列表 → 提交列表 → 详情 → 文件差异。三栏在
 *   390px 里同时出现只会三栏都读不了。
 */

export interface LogPageProps {
  workspaceId: string;
}

export function LogPage({ workspaceId }: LogPageProps) {
  const t = useT();
  const compact = useCompactLayout();
  const client = useQueryClient();
  const git = usePreferencesStore((state) => state.git);
  const set = usePreferencesStore((state) => state.setGitPreference);
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const addNode = useCanvasStore((state) => state.addNode);

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [commit, setCommit] = useState<LogCommit | null>(null);
  const [compareBase, setCompareBase] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<NamePrompt | null>(null);
  const [reflog, setReflog] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  /** 手机上的四级导航；桌面上永远停在 `tree`（三栏同时可见）。 */
  const [stage, setStage] = useState<"tree" | "commits" | "details" | "diff">(
    "commits",
  );

  const at = useCallback(
    (repository: string) => gitTarget(workspaceId, workspaceRoot, repository),
    [workspaceId, workspaceRoot],
  );

  const refs = useQuery({
    queryKey: ["git-refs", workspaceId],
    queryFn: ({ signal }) => gitRefs(workspaceId, signal),
    retry: false,
  });
  const repositories = useMemo(() => refs.data ?? [], [refs.data]);

  const key = filterKey(git);
  const log = useInfiniteQuery({
    queryKey: ["git-log", workspaceId, key],
    queryFn: ({ pageParam, signal }) =>
      gitLog(
        workspaceId,
        logRequestFromPreferences(git, {
          now: Date.now(),
          cursor: pageParam,
        }),
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const pages = log.data?.pages ?? [];
  const commits = useMemo(() => pages.flatMap((page) => page.commits), [pages]);
  /** 颜色序号由服务端定；翻页不会重排，所以取第一页那份就够。 */
  const colors = useMemo(
    () =>
      new Map(
        (pages[0]?.repositories ?? []).map((entry) => [
          entry.path,
          entry.color,
        ]),
      ),
    [pages],
  );

  /** 每个仓库的进行中状态：写动作的 state token、期望 HEAD 与空闲判定。 */
  const integrations = useQueries({
    queries: repositories.map((repository) => ({
      queryKey: [
        "git-repository-integration",
        workspaceId,
        repository.repositoryPath,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gitGateway.integration(at(repository.repositoryPath), signal),
      retry: false,
    })),
  });
  const snapshots = useMemo(
    () =>
      new Map(
        repositories.map((repository, index) => [
          repository.repositoryPath,
          integrations[index]?.data ?? null,
        ]),
      ),
    [repositories, integrations],
  );

  /** HEAD 有未提交变更的仓库；表格最上面那条虚线行按它出现。 */
  const uncommitted = useMemo(
    () =>
      repositories
        .filter((repository) => snapshots.get(repository.repositoryPath)?.dirty)
        .map((repository) => repository.repositoryPath),
    [repositories, snapshots],
  );

  /**
   * 「我的」= `git config user.email`。Runtime 目前没有单独交出这个值的读，
   * 所以取根仓库 reflog 最近一条的提交者邮箱——那条记录正是本机这个人写的。
   * 读不到就整项不出现，而不是猜一个。
   */
  const identity = useQuery({
    queryKey: ["git-log-identity", workspaceId],
    queryFn: ({ signal }) =>
      gitGateway.reflog(at("."), { reference: "HEAD", limit: 1 }, signal),
    retry: false,
  });
  const myEmail = identity.data?.entries[0]?.committerEmail ?? null;

  const invalidate = () => {
    invalidateGitQueries(client, workspaceId);
    void client.invalidateQueries({ queryKey: ["git-log", workspaceId] });
    void client.invalidateQueries({ queryKey: ["git-refs", workspaceId] });
  };

  const submit = useMutation({
    mutationFn: (input: {
      repository: string;
      action: GitRepositoryAction;
      expected: GitExpectedState;
    }) =>
      gitGateway.operate(
        at(input.repository),
        input.action,
        input.expected,
        `${input.repository}/${crypto.randomUUID()}`,
      ),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  /** 待确认的那一次写记着它属于哪个仓库；确认框本身只会复述一次动作。 */
  const [pendingRepository, setPendingRepository] = useState(".");

  const request = useCallback(
    (repository: string, action: GitRepositoryAction) => {
      const snapshot = snapshots.get(repository);
      setPendingRepository(repository);
      setAcknowledged(false);
      setConfirmation({
        action,
        expected: snapshot?.head ?? { headOid: null, branch: null },
      });
    },
    [snapshots],
  );

  const menu: MenuContext = {
    request,
    busy: submit.isPending,
    idle: (repository) => {
      const snapshot = snapshots.get(repository);
      return Boolean(
        snapshot && snapshot.kind === "none" && snapshot.conflicts.length === 0,
      );
    },
    stateToken: (repository) => snapshots.get(repository)?.stateToken ?? null,
    currentBranch: (repository) =>
      repositories.find((entry) => entry.repositoryPath === repository)?.head ??
      null,
    branches: (repository) =>
      repositories
        .find((entry) => entry.repositoryPath === repository)
        ?.branches.map((branch) => branch.name) ?? [],
    onCompare: setCompareBase,
    onReference: (entry) => {
      addNode("sticky", {
        title: entry.subject,
        position: nodeDropPosition("sticky"),
        data: {
          kind: "sticky",
          content: `${entry.repositoryPath} · ${entry.oid.slice(0, 12)}\n${entry.subject}`,
        },
      });
    },
    onReflog: setReflog,
    onPrompt: setPrompt,
    onToggleFavorite: (value) =>
      set(
        "favorites",
        git.favorites.includes(value)
          ? git.favorites.filter((item) => item !== value)
          : [...git.favorites, value],
      ),
  };

  const selectNode = (node: BranchTreeNode, additive: boolean) => {
    if (node.kind === "head") {
      set("selectedRefs", []);
      if (compact) setStage("commits");
      return;
    }
    if (!node.repositoryPath || !node.reference) return;
    const value = refKey(node.repositoryPath, node.reference);
    set(
      "selectedRefs",
      additive
        ? git.selectedRefs.includes(value)
          ? git.selectedRefs.filter((item) => item !== value)
          : [...git.selectedRefs, value]
        : [value],
    );
    if (compact) setStage("commits");
  };

  /**
   * 第一次打开时展开每个仓库根与它的「本地」组：一棵全收起来的树等于让人
   * 先点三下才看得到分支。用户收起过任何一个节点之后偏好里就有值了，那时候
   * 以偏好为准。
   */
  const expanded = useMemo(
    () =>
      git.expanded.length > 0 ? git.expanded : defaultExpanded(repositories),
    [git.expanded, repositories],
  );

  const references = useMemo(
    () =>
      repositories.flatMap((repository) =>
        repository.branches.map((branch) => ({
          key: refKey(repository.repositoryPath, branch.name),
          label:
            repositories.length > 1
              ? `${repository.name} · ${branch.name}`
              : branch.name,
        })),
      ),
    [repositories],
  );
  const authors = useMemo(() => {
    const seen = new Map<string, { name: string; email: string }>();
    for (const entry of commits) {
      if (!seen.has(entry.authorEmail))
        seen.set(entry.authorEmail, {
          name: entry.authorName,
          email: entry.authorEmail,
        });
    }
    return [...seen.values()];
  }, [commits]);

  const tree = (
    <BranchTree
      repositories={repositories}
      colors={colors}
      filter={filter}
      onFilterChange={setFilter}
      selected={git.selectedRefs}
      onSelect={selectNode}
      expanded={expanded}
      onToggleExpanded={(id) =>
        set(
          "expanded",
          expanded.includes(id)
            ? expanded.filter((item) => item !== id)
            : [...expanded, id],
        )
      }
      favorites={git.favorites}
      onToggleFavorite={menu.onToggleFavorite}
      renderNodeMenu={(node, row) => (
        <BranchContextMenu node={node} context={menu}>
          {row}
        </BranchContextMenu>
      )}
    />
  );

  const table = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <LogToolbar
        authors={authors}
        references={references}
        repositories={repositories.map((repository) => ({
          path: repository.repositoryPath,
          name: repository.name,
        }))}
        myEmail={myEmail}
      />
      {reflog !== null && (
        <section
          aria-label={t("gitLog.reflog.title")}
          className="max-h-64 shrink-0 overflow-auto border-b border-border"
        >
          <div className="flex items-center gap-1 px-2 pt-1">
            <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">
              {t("gitLog.reflog.title")}
            </h3>
            <IconButton
              label={t("gitLog.reflog.close")}
              onClick={() => setReflog(null)}
            >
              <X />
            </IconButton>
          </div>
          <Reflog
            workspaceId={workspaceId}
            repositoryKey={reflog}
            busy={submit.isPending}
            loadPage={(reference, cursor, signal) =>
              gitGateway.reflog(at(reflog), { reference, cursor }, signal)
            }
            loadState={(signal) => gitGateway.integration(at(reflog), signal)}
            request={(action) => request(reflog, action)}
          />
        </section>
      )}
      {log.error && (
        <ReadError error={log.error} retry={() => void log.refetch()} />
      )}
      {pages[0]?.truncated && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          {t("gitLog.table.truncated")}
        </p>
      )}
      <LogTable
        commits={commits}
        colors={colors}
        selected={selected}
        onSelect={(rowKey, entry) => {
          setSelected(rowKey);
          setCommit(entry);
          setCompareBase(null);
          if (compact && rowKey !== UNCOMMITTED_KEY) setStage("details");
        }}
        uncommitted={uncommitted}
        compact={git.compactRows}
        showHash={git.showHashColumn}
        narrow={compact}
        myEmail={git.highlightMine ? myEmail : null}
        hasMore={log.hasNextPage}
        loading={log.isFetching}
        onLoadMore={() => void log.fetchNextPage()}
        renderRowMenu={(entry, row) => (
          <CommitContextMenu commit={entry} context={menu}>
            {row}
          </CommitContextMenu>
        )}
      />
    </div>
  );

  const details = commit ? (
    <CommitDetails
      key={commitKey(commit)}
      workspaceId={workspaceId}
      target={at(commit.repositoryPath)}
      commit={commit}
      base={compareBase}
      onBaseChange={setCompareBase}
      onOpenFile={compact ? () => setStage("diff") : undefined}
    />
  ) : (
    <p className="p-3 text-xs text-muted-foreground">
      {t("gitLog.details.empty")}
    </p>
  );

  const dialogs = (
    <>
      <NamePromptDialog
        prompt={prompt}
        onClose={() => setPrompt(null)}
        onSubmit={(value, name) => {
          request(
            value.repositoryPath,
            value.kind === "branch"
              ? branchFromCommit(name, value.oid, false)
              : tagAtCommit(name, value.oid, null),
          );
          setPrompt(null);
        }}
      />
      <RepositoryConfirmDialog
        confirmation={confirmation}
        setConfirmation={setConfirmation}
        acknowledged={acknowledged}
        setAcknowledged={setAcknowledged}
        blocked={submit.isPending}
        repositoryPath={pendingRepository}
        submit={(input) =>
          submit.mutate({ ...input, repository: pendingRepository })
        }
      />
    </>
  );

  if (compact) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          {stage !== "commits" && (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-9 px-2"
              onClick={() =>
                setStage(
                  stage === "diff"
                    ? "details"
                    : stage === "details"
                      ? "commits"
                      : "commits",
                )
              }
            >
              <ChevronLeft aria-hidden />
              {t("gitLog.mobile.back")}
            </Button>
          )}
          {stage === "commits" && (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-9 px-2"
              onClick={() => setStage("tree")}
            >
              {t("gitLog.mobile.branches")}
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {t(`gitLog.mobile.${stage === "tree" ? "branches" : stage}`)}
          </span>
        </div>
        {stage === "tree" && tree}
        {stage === "commits" && table}
        {(stage === "details" || stage === "diff") && details}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 min-w-0 flex-1"
        onLayoutChanged={(layout) => {
          // `Layout` 按面板 id 索引，不是按位置——收起一栏之后位置就变了，
          // 但 id 不会。
          const left = layout.tree;
          const right = layout.details;
          if (typeof left === "number") set("treeWidth", Math.round(left));
          if (typeof right === "number") set("detailsWidth", Math.round(right));
        }}
      >
        {!git.treeCollapsed && (
          <>
            <ResizablePanel
              id="tree"
              defaultSize={`${git.treeWidth}`}
              minSize="10"
              maxSize="45"
              className="flex min-w-0 flex-col"
            >
              {tree}
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel
          id="commits"
          minSize="30"
          className="flex min-w-0 flex-col"
        >
          {table}
        </ResizablePanel>
        {!git.detailsCollapsed && (
          <>
            <ResizableHandle />
            <ResizablePanel
              id="details"
              defaultSize={`${git.detailsWidth}`}
              minSize="15"
              maxSize="55"
              className="flex min-w-0 flex-col"
            >
              {details}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-0.5">
        <IconButton
          label={t(
            git.treeCollapsed ? "gitLog.tree.expand" : "gitLog.tree.collapse",
          )}
          onClick={() => set("treeCollapsed", !git.treeCollapsed)}
        >
          <PanelLeft />
        </IconButton>
        <span className="flex-1" />
        <IconButton
          label={t(
            git.detailsCollapsed
              ? "gitLog.details.expand"
              : "gitLog.details.collapse",
          )}
          onClick={() => set("detailsCollapsed", !git.detailsCollapsed)}
        >
          <PanelRight />
        </IconButton>
      </div>
      {dialogs}
    </div>
  );
}
