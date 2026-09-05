import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitRepositoryAction, GitBranchRecord } from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { useCanvasStore } from "../../store/canvas-store";
import {
  armInitScript,
  boundFrameForPath,
  frameBindingOf,
  samePath,
} from "../../canvas/frame-binding";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Check, Field, ReadError, selectClass } from "./forms";
import { createWorktreeAction, localBranch } from "./worktree";

/** 绑定 Frame 的默认尺寸：装得下一个默认终端还留出边距。 */
const FRAME_SIZE = { width: 720, height: 560 };
/** 初始化终端在 Frame 里的落点（相对 Frame 左上角，让开徽章）。 */
const INIT_TERMINAL_POSITION = { x: 24, y: 72 };

/** 这一次创建请求附带的画布意图；worktree 真的出现在列表里之后才兑现。 */
interface FrameIntent {
  path: string;
  branch: string;
  script: string;
}

export function Worktrees({
  workspaceId,
  repositoryKey,
  branches,
  busy,
  request,
}: {
  workspaceId: string;
  repositoryKey: string;
  branches: GitBranchRecord[];
  busy: boolean;
  request: (action: GitRepositoryAction) => void;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [startPoint, setStartPoint] = useState("");
  const [createFrame, setCreateFrame] = useState(false);
  const [initScript, setInitScript] = useState("");
  const selectedBranch = localBranch(branches, branch);
  const validBranch = createBranch
    ? Boolean(branch.trim())
    : Boolean(selectedBranch);
  const worktrees = useQuery({
    queryKey: ["git-repository-worktrees", workspaceId, repositoryKey],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositoryWorktrees(workspaceId, signal),
    retry: false,
  });

  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  /**
   * 兑现凭据是 worktree 列表本身：这一步失败了，那条 checkout 就不会出现，
   * 画布上也就不会多出一个指向空目录的 Frame。意图放 ref 而不是 state——
   * 它只驱动一次副作用，不参与渲染。
   */
  const intent = useRef<FrameIntent | null>(null);

  useEffect(() => {
    const pending = intent.current;
    const list = worktrees.data;
    if (!pending || !list) return;
    const created = list.some(
      (record) =>
        record.accessible && samePath(record.path, pending.path, workspaceRoot),
    );
    if (!created) return;
    intent.current = null;
    const store = useCanvasStore.getState();
    const existing = store.document?.nodes ?? [];
    if (boundFrameForPath(existing, pending.path, { workspaceRoot })) return;
    const script = pending.script.trim();
    const frameId = store.addNode("group", {
      title: pending.branch,
      size: FRAME_SIZE,
      data: {
        kind: "group",
        binding: {
          worktreePath: pending.path,
          branch: pending.branch,
          // 发现服务还没跑过，先用路径认这条 checkout；刷新之后由发现结果对齐。
          repositoryId: pending.path,
          initScript: script || null,
          initScriptState: script ? "pending" : "none",
          initScriptNodeId: null,
        },
      },
    });
    if (!frameId || !script) return;
    // cwd 不用在这里拼：`addNode` 认得父 Frame 上的绑定，会把 worktree 目录
    // 继承下来（`canvas/frame-binding.ts`）。
    const terminalId = store.addNode("terminal", {
      parentId: frameId,
      position: INIT_TERMINAL_POSITION,
      title: t("frameBinding.initTerminalTitle"),
    });
    const binding = frameBindingOf(
      useCanvasStore.getState().document?.nodes.find((n) => n.id === frameId),
    );
    if (!binding) return;
    useCanvasStore.getState().updateNodeData(frameId, {
      binding: { ...binding, initScriptNodeId: terminalId || null },
    });
    // 开闸：脚本只有被这一次创建排过队才会被发出去，且只发一次。
    if (terminalId) armInitScript(frameId);
  }, [t, workspaceRoot, worktrees.data]);

  return (
    <div className="space-y-3 p-3">
      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const action = createWorktreeAction({
            path,
            branch,
            createBranch,
            startPoint,
            existing: selectedBranch,
          });
          if (!action) return;
          intent.current = createFrame
            ? {
                path: path.trim(),
                branch: branch.trim(),
                script: initScript,
              }
            : null;
          request(action);
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.worktreePath")}>
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
            />
          </Field>
          <Field label={t("gitRepo.branchName")}>
            {createBranch ? (
              <Input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                required
              />
            ) : (
              <select
                className={selectClass}
                value={selectedBranch?.name ?? ""}
                onChange={(event) => setBranch(event.target.value)}
                required
              >
                <option value="">{t("gitRepo.chooseBranch")}</option>
                {branches
                  .filter((record) => !record.remote)
                  .map((record) => (
                    <option key={record.fullRef} value={record.name}>
                      {record.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <Check
            label={t("gitRepo.newWorktreeBranch")}
            checked={createBranch}
            onChange={setCreateBranch}
          />
          {createBranch && (
            <Field label={t("gitRepo.startPoint")}>
              <Input
                value={startPoint}
                onChange={(event) => setStartPoint(event.target.value)}
              />
            </Field>
          )}
          <Check
            label={t("frameBinding.createFrame")}
            checked={createFrame}
            onChange={setCreateFrame}
          />
          {createFrame && (
            <Field label={t("frameBinding.initScript")}>
              <Input
                value={initScript}
                onChange={(event) => setInitScript(event.target.value)}
              />
            </Field>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={!path.trim() || !validBranch}
          >
            {t("gitRepo.createWorktree")}
          </Button>
        </fieldset>
      </form>
      <p className="text-xs text-muted-foreground">
        {t("gitRepo.worktreeSafety")}
      </p>
      {worktrees.isPending && (
        <p role="status" className="text-xs">
          {t("gitRepo.loading")}
        </p>
      )}
      {worktrees.error && (
        <ReadError
          error={worktrees.error}
          retry={() => void worktrees.refetch()}
        />
      )}
      {worktrees.data?.map((tree) => {
        const frame = boundFrameForPath(nodes ?? [], tree.path, {
          workspaceRoot,
        });
        return (
          <section
            key={tree.path}
            className="space-y-2 rounded-md border border-border p-3 text-xs"
          >
            <h3 className="break-all font-mono">{tree.path}</h3>
            <p className="break-all">{tree.branch ?? t("gitRepo.detached")}</p>
            <p className="break-all font-mono text-muted-foreground">
              {tree.headOid ?? t("gitRepo.unborn")}
            </p>
            <div className="flex flex-wrap gap-1">
              {tree.isMain && (
                <Badge variant="outline">{t("gitRepo.mainWorktree")}</Badge>
              )}
              {tree.locked && (
                <Badge variant="outline">{t("gitRepo.locked")}</Badge>
              )}
              {tree.prunable && (
                <Badge variant="outline">{t("gitRepo.prunable")}</Badge>
              )}
            </div>
            <p>
              {!tree.accessible
                ? t("gitRepo.inaccessible")
                : t(
                    tree.dirty === null
                      ? "gitRepo.dirtyUnknown"
                      : tree.dirty
                        ? "gitRepo.dirty"
                        : "gitRepo.clean",
                  )}
            </p>
            {(tree.lockReason || tree.pruneReason) && (
              <p className="break-words text-muted-foreground">
                {tree.lockReason ?? tree.pruneReason}
              </p>
            )}
            {frame && (
              <p className="break-all">
                {t("frameBinding.boundFrame", { title: frame.title })}
              </p>
            )}
            <div className="flex flex-wrap gap-1">
              {/* 删 checkout 和解绑是两件事，所以一个是 destructive，一个不是。 */}
              <Button
                variant="destructive"
                size="sm"
                disabled={
                  busy ||
                  worktrees.isFetching ||
                  !tree.accessible ||
                  tree.isMain ||
                  tree.bare ||
                  tree.locked ||
                  tree.prunable ||
                  tree.dirty !== false ||
                  !tree.headOid
                }
                onClick={() =>
                  request({
                    kind: "removeWorktree",
                    path: tree.path,
                    expectedOid: tree.headOid!,
                    allowUnpublished: false,
                  })
                }
              >
                {t("gitRepo.removeWorktree")}
              </Button>
              {frame && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    useCanvasStore
                      .getState()
                      .updateNodeData(frame.id, { binding: null })
                  }
                >
                  {t("frameBinding.unbindFrame")}
                </Button>
              )}
            </div>
            {frame && (
              <>
                <p className="text-muted-foreground">
                  {t("frameBinding.unbindHint")}
                </p>
                <p className="text-muted-foreground">
                  {t("frameBinding.removeHint")}
                </p>
              </>
            )}
          </section>
        );
      })}
      {worktrees.data?.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("gitRepo.noWorktrees")}
        </p>
      )}
    </div>
  );
}
