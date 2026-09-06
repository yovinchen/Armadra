import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { CanvasNode, FrameBinding } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { gitGateway } from "@/git/gateway";
import { gitTarget } from "@/git/target";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useCanvasStore } from "@/store/canvas-store";
import {
  bindingRepairState,
  consumeArmedInitScript,
  frameBindingOf,
  repositoryForBinding,
} from "../../frame-binding";

/**
 * 绑定徽章（roadmap §3.4 G03）。
 *
 * 宿主是 `flow/nodes/GroupNode.tsx`：Frame 现在是一个真的 DOM 节点，徽章
 * 直接贴在它的左上角，旧引擎里那一层「按 `nodeBox()` 算页面坐标再绝对定位」
 * 的 `WorktreeBindingLayer` 整个删掉了。
 *
 * 三件事在这里做：读出分支 / 路径 / 未提交变更数，判定 checkout 还在不在，
 * 以及把创建时排好队的初始化脚本发出去（只发一次，闸在 `frame-binding.ts`）。
 */

/** 路径太长时只留尾巴；完整值在 `title` 里。 */
const MAX_PATH = 34;

/**
 * 服务端的判定 → 徽章要给出的那条修法。
 *
 * 「目录没了」和「这里已经不是这个仓库的 worktree 了」都只能重建或解绑；
 * 「分支被切走了」不是——那个检出还在，重建它只会失败，所以那一档只提供
 * 解绑，并说清发生了什么。
 */
const BINDING_CODES = {
  ok: "ok",
  pathMissing: "missing",
  notAWorktree: "missing",
  repositoryMismatch: "mismatch",
  branchChanged: "branchChanged",
} as const;

type BindingReason = (typeof BINDING_CODES)[keyof typeof BINDING_CODES];

export function truncatePath(path: string, max = MAX_PATH): string {
  return path.length <= max ? path : `…${path.slice(path.length - max + 1)}`;
}

export function WorktreeBindingBadge({ node }: { node: CanvasNode }) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const workspaceId = workspace?.id ?? null;
  const binding = frameBindingOf(node);

  const repositories = useQuery({
    queryKey: ["git-repositories", workspaceId],
    queryFn: ({ signal }) =>
      gitGateway.repositories(
        gitTarget(workspaceId ?? "", workspace?.rootPath, "."),
        {},
        signal,
      ),
    enabled: Boolean(workspaceId),
    retry: false,
  });
  /**
   * 服务端对这条绑定的判定（Git 设计 §5.1）。
   *
   * 仓库发现只能回答「这个路径在不在扫描结果里」，而绑定能坏的方式不止一
   * 种：目录没了、目录还在但不再是这个仓库的 worktree、分支被人切走了。
   * 每一种对应的修法不同，所以判定要带理由，不能只有一个布尔值。
   *
   * 它是**补充**而不是替代：这次检查本身失败时（探不到、没有执行权限），
   * 徽章退回发现结果那一档，而不是宣布绑定坏了。
   */
  const verdict = useQuery({
    queryKey: [
      "git-worktree-binding",
      workspaceId,
      binding?.worktreePath,
      binding?.branch,
      binding?.repositoryId,
    ],
    queryFn: ({ signal }) =>
      gitGateway.worktreeBinding(
        gitTarget(workspaceId ?? "", workspace?.rootPath, "."),
        {
          worktreePath: binding!.worktreePath,
          branch: binding!.branch,
          repositoryId: binding!.repositoryId,
        },
        signal,
      ),
    enabled: Boolean(workspaceId) && Boolean(binding),
    retry: false,
  });

  useInitScript(node, binding);

  if (!binding) return null;
  const list = repositories.data;
  const root = list?.workspaceRoot ?? workspace?.rootPath;
  // 扫描被截断时不下「不存在」的结论：列表本来就不全。
  const known = list && !list.truncated ? list.repositories : undefined;
  const repair = verdict.data
    ? BINDING_CODES[verdict.data.code]
    : bindingRepairState(binding, known, undefined, { workspaceRoot: root });
  const record = repositoryForBinding(binding, list?.repositories, {
    workspaceRoot: root,
  });

  return (
    <div
      className="flex max-w-full flex-col gap-1 rounded-md border border-border bg-card/90 p-1.5 text-xs shadow-sm backdrop-blur-sm"
      data-testid="worktree-binding-badge"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Badge variant="secondary">{t("frameBinding.worktree")}</Badge>
        <span className="truncate font-medium" title={binding.branch}>
          {binding.branch}
        </span>
        <span
          className="truncate font-mono text-muted-foreground"
          title={binding.worktreePath}
        >
          {truncatePath(binding.worktreePath)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <DirtyBadge count={record ? record.dirtyCount : undefined} />
        <InitScriptBadge binding={binding} />
      </div>
      {repair !== "ok" ? (
        <RepairPrompt node={node} binding={binding} reason={repair} />
      ) : null}
    </div>
  );
}

/**
 * 未提交变更数。`null` 是**未知**（没有工作区执行权限，数不了），和 0 是
 * 两回事，所以分成两条不同的文案与两种底色。
 */
function DirtyBadge({ count }: { count: number | null | undefined }) {
  const t = useT();
  if (count === undefined) return null;
  if (count === null)
    return <Badge variant="outline">{t("frameBinding.dirtyUnknown")}</Badge>;
  return (
    <Badge variant={count === 0 ? "outline" : "default"}>
      {count === 0
        ? t("frameBinding.dirtyClean")
        : t("frameBinding.dirtyCount", { count })}
    </Badge>
  );
}

const INIT_LABELS = {
  pending: "frameBinding.initPending",
  running: "frameBinding.initRunning",
  succeeded: "frameBinding.initSucceeded",
  failed: "frameBinding.initFailed",
} as const;

function InitScriptBadge({ binding }: { binding: FrameBinding }) {
  const t = useT();
  const state = binding.initScriptState;
  if (state === "none") return null;
  return (
    <Badge variant={state === "failed" ? "destructive" : "outline"}>
      {t(INIT_LABELS[state])}
    </Badge>
  );
}

/* -------------------------------- 修复提示 -------------------------------- */

/**
 * checkout 没了：两个出口。
 *
 * 「重新创建」走的还是仓库服务那条 `createWorktree`；「解绑」只清 `binding`，
 * 一个字节都不碰磁盘——这两件事必须一眼能分开，所以解绑不是 destructive。
 */
function RepairPrompt({
  node,
  binding,
  reason,
}: {
  node: CanvasNode;
  binding: FrameBinding;
  reason: Exclude<BindingReason, "ok">;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const [busy, setBusy] = React.useState(false);
  const workspaceRoot = useCanvasStore(
    (state) => state.workspace?.rootPath ?? undefined,
  );
  const target = gitTarget(workspaceId ?? "", workspaceRoot, ".");
  const branches = useQuery({
    queryKey: ["git-repository-branches", workspaceId, "."],
    queryFn: ({ signal }) => gitGateway.branches(target, signal),
    enabled: Boolean(workspaceId),
    retry: false,
  });
  const source = branches.data?.branches.find(
    (record) => !record.remote && record.name === binding.branch,
  );

  const unbind = () => {
    useCanvasStore.getState().updateNodeData(node.id, { binding: null });
  };

  const recreate = () => {
    if (!workspaceId || !source || !branches.data || busy) return;
    setBusy(true);
    void gitGateway
      .operate(
        target,
        {
          kind: "createWorktree",
          path: binding.worktreePath,
          branch: binding.branch,
          createBranch: false,
          expectedOid: source.oid,
          startPoint: null,
        },
        branches.data.head,
        `binding-repair/${crypto.randomUUID()}`,
      )
      .finally(() => setBusy(false));
  };

  const recreatable = reason === "missing";
  return (
    <div role="alert" className="space-y-1">
      <p className="font-medium text-destructive">
        {t(`frameBinding.reason.${reason}`)}
      </p>
      <p className="text-muted-foreground">
        {t(`frameBinding.reasonHint.${reason}`)}
      </p>
      <div className="flex gap-1">
        {recreatable && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !source}
            onClick={recreate}
          >
            {t("frameBinding.recreate")}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={unbind}>
          {t("frameBinding.unbind")}
        </Button>
      </div>
      <p className="text-muted-foreground">{t("frameBinding.unbindHint")}</p>
    </div>
  );
}

/* ------------------------------- 初始化脚本 ------------------------------- */

/**
 * 创建向导排好队的那条脚本，在终端会话起来之后发一次。
 *
 * 发之前先把 `initScriptState` 落盘成 `running`：即使这一刻应用被关掉，
 * 下次打开看到的也不再是 `pending`。会话结束时把退出码翻译成成功 / 失败，
 * 这样 `failed` 的输出还留在那个终端里可以看。
 */
function useInitScript(node: CanvasNode, binding: FrameBinding | null) {
  const terminalId = binding?.initScriptNodeId ?? null;
  const script = binding?.initScript ?? null;
  const state = binding?.initScriptState ?? "none";
  const terminal = useCanvasStore((store) => {
    if (!terminalId) return null;
    const found = store.document?.nodes.find((item) => item.id === terminalId);
    return found?.data.kind === "terminal" ? found.data : null;
  });
  const sessionId = terminal?.sessionId;
  const exitCode = terminal?.lastExitCode;

  React.useEffect(() => {
    if (state !== "pending" || !script || !sessionId) return;
    if (!consumeArmedInitScript(node.id)) return;
    const store = useCanvasStore.getState();
    const current = frameBindingOf(
      store.document?.nodes.find((item) => item.id === node.id),
    );
    if (!current) return;
    store.updateNodeData(node.id, {
      binding: { ...current, initScriptState: "running" },
    });
    void runtimeApi.pasteTerminal(sessionId, script, true).catch(() => {
      settleInitScript(node.id, "failed");
    });
  }, [node.id, script, sessionId, state]);

  React.useEffect(() => {
    if (state !== "running" || exitCode === undefined || exitCode === null)
      return;
    settleInitScript(node.id, exitCode === 0 ? "succeeded" : "failed");
  }, [exitCode, node.id, state]);
}

function settleInitScript(
  frameNodeId: string,
  next: "succeeded" | "failed",
): void {
  const store = useCanvasStore.getState();
  const current = frameBindingOf(
    store.document?.nodes.find((item) => item.id === frameNodeId),
  );
  if (!current || current.initScriptState !== "running") return;
  store.updateNodeData(frameNodeId, {
    binding: { ...current, initScriptState: next },
  });
}

export default WorktreeBindingBadge;
