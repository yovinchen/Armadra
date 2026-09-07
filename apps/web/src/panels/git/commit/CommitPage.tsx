/**
 * Git 工具窗口的**提交页**（Git 工具窗口设计 §2.3）。
 *
 * 三块：进行中的整合横幅、按仓库分组的变更树（勾选即暂存）、底部的消息与两个
 * 提交按钮。跨仓库勾选时按仓库各提交一次、用同一条信息——设计 §4 明说不做跨
 * 仓库的一次提交，所以这里的进度是一个仓库一行的结果，而不是一个转圈。
 */
import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ListTree,
  Rows3,
  RotateCw,
  Undo2,
} from "lucide-react";
import type { GitRestoreSource } from "@armadra/shared";
import { runtimeApi } from "../../../api/client";
import { gitGateway } from "../../../git/gateway";
import { gitTarget, useGitTarget } from "../../../git/target";
import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { useCompactLayout } from "../../../platform/layout";
import { openMergeView } from "../../../editor/merge/conflict";
import { Button } from "../../../ui/button";
import { IconButton } from "../../../ui/icon-button";
import { ScrollArea } from "../../../ui/scroll-area";
import { ReadError } from "../forms";
import { invalidateGitQueries } from "../queries";
import { useRepositories } from "../Repositories";
import { RepositoryConfirmDialog } from "../RepositoryConfirmDialog";
import {
  SourceControlDialogs,
  type RestoreTarget,
} from "../SourceControlDialogs";
import { integrationInProgress } from "../actions/integration";
import {
  buildChangeTree,
  insideRepository,
  type ChangeFileNode,
  type RepositoryChangeGroup,
} from "./build-change-tree";
import { ChangeDiff } from "./ChangeDiff";
import { ChangeTree } from "./ChangeTree";
import { CommitMessage, type CommitOutcome } from "./CommitMessage";
import { OperationBanner } from "./OperationBanner";
import { StashDialog, UnstashDialog } from "./StashDialogs";
import {
  rememberMessage,
  storedChangeLayout,
  storedMessages,
  writeChangeLayout,
} from "./preferences";
import { useRepositoryWrites } from "./use-repository-writes";
import { useStaging } from "./use-staging";

const stagedCount = (group: RepositoryChangeGroup) =>
  group.sections.find((section) => section.group === "staged")?.count ?? 0;

export function CommitPage({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useQueryClient();
  const compact = useCompactLayout();
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const [layout, setLayout] = useState(storedChangeLayout);
  const [selected, setSelected] = useState<ChangeFileNode | null>(null);
  const [drilled, setDrilled] = useState(false);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState(() => storedMessages(workspaceId));
  const [amend, setAmend] = useState(false);
  const [acknowledgePublished, setAcknowledgePublished] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [unstashOpen, setUnstashOpen] = useState(false);
  const [restore, setRestore] = useState<RestoreTarget | null>(null);
  const [outcomes, setOutcomes] = useState<CommitOutcome[]>([]);
  const [committing, setCommitting] = useState(false);

  const repositories = useRepositories(workspaceId);
  const records = repositories.data?.repositories ?? [];
  const paths = records.map((record) => record.repositoryPath);
  const rootTarget = useGitTarget(workspaceId, ".");
  const at = (repositoryPath: string) =>
    gitTarget(workspaceId, workspaceRoot, repositoryPath);
  const statusKey = ["git-status-all", workspaceId, paths.join(",")];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) =>
      gitGateway.statusBatch(rootTarget, paths, {}, signal),
    enabled: paths.length > 0,
    retry: false,
  });
  // 冲突不在 `git status` 里：porcelain 把 `UU` 归一化成 `M`，只有整合快照说得
  // 出哪些路径还没解决，所以每个检出各读一次。
  const integrations = useQueries({
    queries: records.map((record) => ({
      queryKey: [
        "git-repository-integration",
        workspaceId,
        record.repositoryPath,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gitGateway.integration(at(record.repositoryPath), signal),
      retry: false,
    })),
  });
  const writes = useRepositoryWrites(workspaceId);
  const staging = useStaging(workspaceId, statusKey);

  const groups = buildChangeTree(
    records.map((record, index) => ({
      repositoryPath: record.repositoryPath,
      name: record.name,
      files:
        status.data?.repositories.find(
          (entry) => entry.path === record.repositoryPath,
        )?.status?.files ?? [],
      conflicts:
        integrations[index]?.data?.conflicts.map((file) => file.path) ?? [],
      // 嵌套的检出在父仓库眼里是一个未跟踪目录。它自己在树上已经有一组，
      // 在父仓库里再出现一次，勾上就等于把整个子仓库加进父仓库的索引。
      nested: records.flatMap((other) => {
        const relative = insideRepository(
          record.repositoryPath,
          other.repositoryPath,
        );
        return relative === null ? [] : [relative];
      }),
    })),
    { layout },
  );
  const showRepositories = records.length > 1;
  const banners = records.flatMap((record, index) => {
    const state = integrations[index]?.data;
    return integrationInProgress(state)
      ? [{ repositoryPath: record.repositoryPath, name: record.name, state }]
      : [];
  });
  const staged = groups.filter((group) => stagedCount(group) > 0);
  // 修补只在**一个**仓库上提供：`--amend` 绑的是那个仓库读到的 HEAD，四个仓库
  // 就是四个不同的 HEAD，一个开关代表不了它们。
  const amendTarget =
    staged.length === 1
      ? staged[0]
      : staged.length === 0 && groups.length === 1
        ? groups[0]
        : null;
  const head = useQuery({
    queryKey: ["git-head-commit", workspaceId, amendTarget?.repositoryPath],
    queryFn: ({ signal }) =>
      runtimeApi.gitHeadCommit(
        workspaceId,
        signal,
        amendTarget!.repositoryPath,
      ),
    enabled: Boolean(amendTarget),
    retry: false,
  });
  const targets =
    staged.length > 0 ? staged : amend && amendTarget ? [amendTarget] : [];
  const busy = writes.busy || committing;

  const refresh = () => {
    invalidateGitQueries(client, workspaceId);
    setOutcomes([]);
  };
  const toggleLayout = () => {
    const next = layout === "tree" ? "flat" : "tree";
    setLayout(next);
    writeChangeLayout(next);
  };
  const select = (node: ChangeFileNode) => {
    setSelected(node);
    if (compact) setDrilled(true);
  };
  const resolve = (node: ChangeFileNode) => {
    // 三方合并读的是工作空间根仓库的索引（`editor/merge/conflict.ts`），别的
    // 检出没有入口可走，说清楚好过打开一个空的合并视图。
    if (node.repositoryPath !== ".") {
      toast.error(t("gitCommit.mergeRootOnly"));
      return;
    }
    void openMergeView(workspaceId, node.path);
  };
  const push = async (repositoryPath: string) => {
    const snapshot = await gitGateway.branches(at(repositoryPath));
    const current = snapshot.branches.find(
      (branch) => branch.current && !branch.remote,
    );
    const named = current?.upstream?.split("/")[0];
    const remote =
      named && snapshot.remotes.includes(named) ? named : snapshot.remotes[0];
    if (!current || !remote) {
      toast.error(t("gitCommit.pushUnavailable"));
      return;
    }
    writes.request(repositoryPath, {
      action: {
        kind: "push",
        remote,
        branch: current.name,
        setUpstream: !current.upstream,
        // 覆盖远端历史要单独复核那一个远端提交，那条路留在分支面板上；这里
        // 的推送永远是普通推送，被拒就是被拒。
        forceWithLease: null,
      },
      expected: { ...snapshot.head },
    });
  };
  const commit = async (options: { push: boolean }) => {
    const text = message.trim();
    if (!text || targets.length === 0 || busy) return;
    setCommitting(true);
    setOutcomes(
      targets.map((group) => ({
        repositoryPath: group.repositoryPath,
        name: group.name,
        state: "queued" as const,
      })),
    );
    const update = (repositoryPath: string, patch: Partial<CommitOutcome>) =>
      setOutcomes((current) =>
        current.map((outcome) =>
          outcome.repositoryPath === repositoryPath
            ? { ...outcome, ...patch }
            : outcome,
        ),
      );
    const committed: string[] = [];
    for (const group of targets) {
      update(group.repositoryPath, { state: "running" });
      try {
        const result = await gitGateway.commit(
          at(group.repositoryPath),
          text,
          `commit/${group.repositoryPath}/${crypto.randomUUID()}`,
          undefined,
          amend && head.data
            ? {
                expectedHead: head.data.oid,
                allowPublished: acknowledgePublished,
              }
            : undefined,
        );
        committed.push(group.repositoryPath);
        update(group.repositoryPath, {
          state: "committed",
          commit: result.commit,
        });
      } catch (error) {
        // 一个仓库失败不该把已经提交出去的那几个说成没提交：每行各自留结论。
        update(group.repositoryPath, {
          state: "failed",
          error: error instanceof Error ? error.message : t("scm.failed"),
        });
      }
    }
    setCommitting(false);
    invalidateGitQueries(client, workspaceId);
    if (committed.length > 0) {
      setHistory(rememberMessage(workspaceId, text));
      setMessage("");
      setAmend(false);
      setAcknowledgePublished(false);
      if (options.push) for (const path of committed) await push(path);
    }
  };
  const revert = (input: {
    path: string;
    source: GitRestoreSource;
    repository: string;
  }) => {
    void gitGateway
      .revert(
        at(input.repository),
        [input.path],
        input.source,
        `revert/${input.repository}/${crypto.randomUUID()}`,
      )
      .then(() => invalidateGitQueries(client, workspaceId))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : t("scm.failed")),
      );
  };

  const tree = (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      {repositories.error && (
        <ReadError
          error={repositories.error}
          retry={() => void repositories.refetch()}
        />
      )}
      {status.error && (
        <ReadError error={status.error} retry={() => void status.refetch()} />
      )}
      {status.isPending && paths.length > 0 && (
        <p role="status" className="px-4 py-3 text-xs">
          {t("gitRepo.loading")}
        </p>
      )}
      <ChangeTree
        groups={groups}
        showRepositories={showRepositories}
        selectedId={selected?.id ?? null}
        onSelect={select}
        onToggle={staging.toggle}
        onResolve={resolve}
        pending={staging.pending}
        disabled={busy}
      />
    </ScrollArea>
  );
  const diff = <ChangeDiff workspaceId={workspaceId} node={selected} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {compact && drilled ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-8 px-2"
            onClick={() => setDrilled(false)}
          >
            <ChevronLeft aria-hidden />
            {t("scm.back")}
          </Button>
        ) : (
          <>
            <IconButton label={t("gitRepo.refresh")} onClick={refresh}>
              <RotateCw />
            </IconButton>
            <IconButton
              label={t(layout === "tree" ? "gitCommit.flat" : "gitCommit.tree")}
              onClick={toggleLayout}
            >
              {layout === "tree" ? <ListTree /> : <Rows3 />}
            </IconButton>
            <Button
              size="sm"
              variant="ghost"
              disabled={records.length === 0}
              onClick={() => setStashOpen(true)}
            >
              <Archive aria-hidden />
              {t("gitCommit.stash")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={records.length === 0}
              onClick={() => setUnstashOpen(true)}
            >
              <ArchiveRestore aria-hidden />
              {t("gitCommit.unstash")}
            </Button>
            <IconButton
              label={t("gitCommit.discard")}
              disabled={!selected}
              onClick={() =>
                selected &&
                setRestore({
                  path: selected.path,
                  untracked: selected.status === "?",
                  repository: selected.repositoryPath,
                })
              }
            >
              <Undo2 />
            </IconButton>
          </>
        )}
      </div>
      <OperationBanner
        entries={banners}
        busy={busy}
        showRepositories={showRepositories}
        onResume={writes.request}
      />
      {compact ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {drilled ? diff : tree}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 w-[min(45%,26rem)] shrink-0 flex-col border-r border-border">
            {tree}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{diff}</div>
        </div>
      )}
      {!(compact && drilled) && (
        <CommitMessage
          workspaceId={workspaceId}
          message={message}
          onMessageChange={setMessage}
          history={history}
          amend={amend}
          onAmendChange={(next) => {
            setAmend(next);
            setAcknowledgePublished(false);
            if (next && head.data && !head.data.truncated && !message.trim())
              setMessage(head.data.message);
          }}
          head={amendTarget ? (head.data ?? null) : null}
          acknowledgePublished={acknowledgePublished}
          onAcknowledgePublished={setAcknowledgePublished}
          targets={targets}
          outcomes={outcomes}
          busy={busy}
          showRepositories={showRepositories}
          onCommit={(options) => void commit(options)}
        />
      )}
      <StashDialog
        open={stashOpen}
        onOpenChange={setStashOpen}
        workspaceId={workspaceId}
        repositories={records}
        busy={busy}
        onRequest={writes.request}
      />
      <UnstashDialog
        open={unstashOpen}
        onOpenChange={setUnstashOpen}
        workspaceId={workspaceId}
        repositories={records}
        busy={busy}
        onRequest={writes.request}
      />
      {/* 丢弃走的是抽屉里那扇门：从索引还原和从 HEAD 还原丢掉的东西不一样，
          所以它问的是两个动作，而不是一个「还原」。新建仓库那半在这里用不到。 */}
      <SourceControlDialogs
        confirmInit={false}
        setConfirmInit={() => undefined}
        init={() => undefined}
        restore={restore}
        setRestore={setRestore}
        revert={revert}
      />
      <RepositoryConfirmDialog
        confirmation={writes.confirmation}
        setConfirmation={(value) => {
          if (value === null && writes.confirmation)
            writes.dismiss(writes.confirmation.id);
        }}
        acknowledged={writes.acknowledged}
        setAcknowledged={writes.setAcknowledged}
        blocked={busy}
        repositoryPath={writes.confirmation?.repositoryPath ?? "."}
        submit={() => writes.submit()}
      />
    </div>
  );
}
