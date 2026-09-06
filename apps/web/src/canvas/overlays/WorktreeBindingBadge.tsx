import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { CanvasNode, FrameBinding } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useCanvasStore } from "@/store/canvas-store";
import {
  bindingRepairState,
  boundFrames,
  consumeArmedInitScript,
  frameBindingOf,
  repositoryForBinding,
} from "../frame-binding";
import { nodeBox } from "../geometry";

/**
 * 绑定徽章（roadmap §3.4 G03）。
 *
 * 挂在 `CanvasOverlays` 里，所以坐标就是页面坐标；徽章自己把指针事件收回来
 * （修复提示上有按钮），外面那层仍然是 `pointer-events: none`。
 *
 * 三件事在这里做：读出分支 / 路径 / 未提交变更数，判定 checkout 还在不在，
 * 以及把创建时排好队的初始化脚本发出去（只发一次，闸在 `frame-binding.ts`）。
 */

/** 徽章相对 frame 左上角的内缩，避开 分组自己的标题。 */
const INSET = 8;

/** 路径太长时只留尾巴；完整值在 `title` 里。 */
const MAX_PATH = 34;

export function truncatePath(path: string, max = MAX_PATH): string {
  return path.length <= max ? path : `…${path.slice(path.length - max + 1)}`;
}

/* --------------------------------- 整层 ----------------------------------- */

export function WorktreeBindingLayer() {
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const frames = React.useMemo(() => boundFrames(nodes ?? []), [nodes]);
  if (frames.length === 0) return null;
  const list = nodes ?? [];
  return (
    <>
      {frames.map((frame) => {
        const box = nodeBox(list, frame);
        return (
          <div
            key={frame.id}
            className="absolute"
            style={{
              left: box.x + INSET,
              top: box.y + INSET,
              maxWidth: Math.max(box.width - INSET * 2, 160),
              pointerEvents: "all",
            }}
          >
            <WorktreeBindingBadge node={frame} />
          </div>
        );
      })}
    </>
  );
}

/* -------------------------------- 单个徽章 -------------------------------- */

export function WorktreeBindingBadge({ node }: { node: CanvasNode }) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const workspaceId = workspace?.id ?? null;
  const binding = frameBindingOf(node);

  const repositories = useQuery({
    queryKey: ["git-repositories", workspaceId],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositories(workspaceId!, {}, signal),
    enabled: Boolean(workspaceId),
    retry: false,
  });

  useInitScript(node, binding);

  if (!binding) return null;
  const list = repositories.data;
  const root = list?.workspaceRoot ?? workspace?.rootPath;
  // 扫描被截断时不下「不存在」的结论：列表本来就不全。
  const known = list && !list.truncated ? list.repositories : undefined;
  const repair = bindingRepairState(binding, known, undefined, {
    workspaceRoot: root,
  });
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
      {repair === "missing" ? (
        <RepairPrompt node={node} binding={binding} />
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
}: {
  node: CanvasNode;
  binding: FrameBinding;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const [busy, setBusy] = React.useState(false);
  const branches = useQuery({
    queryKey: ["git-repository-branches", workspaceId, "."],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositoryBranches(workspaceId!, ".", signal),
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
    void runtimeApi
      .gitRepositoryOperate(
        workspaceId,
        {
          kind: "createWorktree",
          path: binding.worktreePath,
          branch: binding.branch,
          createBranch: false,
          expectedOid: source.oid,
          startPoint: null,
        },
        branches.data.head,
      )
      .finally(() => setBusy(false));
  };

  return (
    <div role="alert" className="space-y-1">
      <p className="font-medium text-destructive">
        {t("frameBinding.missing")}
      </p>
      <p className="text-muted-foreground">{t("frameBinding.missingHint")}</p>
      <div className="flex gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !source}
          onClick={recreate}
        >
          {t("frameBinding.recreate")}
        </Button>
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

export default WorktreeBindingLayer;
