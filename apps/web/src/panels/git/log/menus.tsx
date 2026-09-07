import { useState, type ReactNode } from "react";
import type { GitRepositoryAction } from "@armadra/shared";

import { useT } from "../../../app/preferences-store";
import { writeClipboard } from "../../../terminal/TerminalSurface";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../../ui/context-menu";
import {
  checkoutCommit,
  cherryPickCommit,
  mainlineOf,
  resetToCommit,
  revertCommit,
} from "../actions/commit";
import { refKey, type BranchTreeNode } from "./build-tree";
import * as refActions from "../actions/refs";
import type { LogCommit } from "./types";

/**
 * 日志页的右键菜单（Git 工具窗口设计 §2.2）。
 *
 * 菜单只造动作，**不发请求**：每一项都调 `request(action)`，由日志页交给
 * `GitRepositoryPanel` 那套已有的确认门（`RepositoryConfirmDialog`）与队列。
 * 动作本身来自 `actions/*.ts`，和旧的八个页签是同一批构造。
 *
 * 需要名字的两项（新建分支 / 新建标签）走一个小对话框：把输入框塞进右键菜单
 * 里，菜单一失焦就连着输入一起消失。
 */

export interface NamePrompt {
  kind: "branch" | "tag";
  /** 从哪个提交开始 / 打在哪个提交上。 */
  oid: string;
  repositoryPath: string;
}

export interface MenuContext {
  /** 交给确认门；日志页负责接上当前仓库。 */
  request: (repositoryPath: string, action: GitRepositoryAction) => void;
  /** 有写在跑，或者读回来的快照已经过期。 */
  busy: boolean;
  /** 仓库空闲（没有进行中的合并 / rebase / cherry-pick）才允许序列类动作。 */
  idle: (repositoryPath: string) => boolean;
  /** 该仓库当前的 state token；没有就不发需要它的动作。 */
  stateToken: (repositoryPath: string) => string | null;
  /** 当前分支名，用于「合并到当前分支」这类措辞与目标。 */
  currentBranch: (repositoryPath: string) => string | null;
  /** 本地分支列表，用于「与分支比较」子菜单。 */
  branches: (repositoryPath: string) => readonly string[];
  /** 与某个基线比较：`null` 回到「与第一父比」。 */
  onCompare: (base: string | null) => void;
  /** 在画布上引用这个提交。 */
  onReference: (commit: LogCommit) => void;
  /** 打开「引用日志…」。 */
  onReflog: (repositoryPath: string) => void;
  onPrompt: (prompt: NamePrompt) => void;
  onToggleFavorite: (key: string) => void;
}

export function CommitContextMenu({
  commit,
  context,
  children,
}: {
  commit: LogCommit;
  context: MenuContext;
  children: ReactNode;
}) {
  const t = useT();
  const repository = commit.repositoryPath;
  const token = context.stateToken(repository);
  const idle = context.idle(repository) && token !== null;
  const mainline = mainlineOf(commit.parents);
  const send = (action: GitRepositoryAction) =>
    context.request(repository, action);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuItem
          disabled={context.busy}
          onSelect={() => send(checkoutCommit(commit.oid))}
        >
          {t("gitRepo.checkoutCommit")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={context.busy}
          onSelect={() =>
            context.onPrompt({
              kind: "branch",
              oid: commit.oid,
              repositoryPath: repository,
            })
          }
        >
          {t("gitLog.menu.branchFromHere")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={context.busy}
          onSelect={() =>
            context.onPrompt({
              kind: "tag",
              oid: commit.oid,
              repositoryPath: repository,
            })
          }
        >
          {t("gitLog.menu.tagFromHere")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!idle || context.busy}
          onSelect={() =>
            token && send(cherryPickCommit(commit.oid, mainline, token))
          }
        >
          {t("gitRepo.startCherryPick")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!idle || context.busy}
          onSelect={() =>
            token && send(revertCommit(commit.oid, mainline, token))
          }
        >
          {t("gitRepo.revert")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!idle || context.busy}>
            {t("gitLog.menu.resetHere")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(["soft", "mixed", "hard"] as const).map((mode) => (
              <ContextMenuItem
                key={mode}
                variant={mode === "hard" ? "destructive" : "default"}
                onSelect={() =>
                  token &&
                  send(
                    resetToCommit(
                      mode,
                      commit.oid,
                      token,
                      // 确认框会复述「hard 会丢掉未提交的内容」，勾选在那里。
                      mode === "hard",
                    ),
                  )
                }
              >
                {t(`gitRepo.reset.${mode}`)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          disabled={!idle || context.busy}
          onSelect={() =>
            token && send(refActions.rebaseOnto(commit.oid, token))
          }
        >
          {t("gitLog.menu.rebaseFromHere")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => context.onCompare("HEAD")}>
          {t("gitLog.menu.compareWithLocal")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t("gitLog.menu.compareWithBranch")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-72 overflow-auto">
            {context.branches(repository).map((branch) => (
              <ContextMenuItem
                key={branch}
                onSelect={() => context.onCompare(branch)}
              >
                {branch}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => writeClipboard(commit.oid)}>
          {t("gitRepo.copyOid")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => writeClipboard(commit.subject)}>
          {t("gitLog.menu.copyMessage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => context.onReference(commit)}>
          {t("gitLog.menu.referenceOnCanvas")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function BranchContextMenu({
  node,
  context,
  children,
}: {
  node: BranchTreeNode;
  context: MenuContext;
  children: ReactNode;
}) {
  const t = useT();
  if (node.kind === "head") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => context.onReflog(".")}>
            {t("gitLog.menu.reflog")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
  if (node.kind !== "branch" || !node.repositoryPath || !node.reference) {
    return <>{children}</>;
  }
  const repository = node.repositoryPath;
  const reference = node.reference;
  const oid = node.oid ?? null;
  const token = context.stateToken(repository);
  const idle = context.idle(repository) && token !== null;
  const branch = context.currentBranch(repository);
  const remote = reference.includes("/") ? reference.split("/")[0]! : "origin";
  const send = (action: GitRepositoryAction) =>
    context.request(repository, action);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel className="truncate">{reference}</ContextMenuLabel>
        <ContextMenuItem
          disabled={context.busy || !oid || node.current}
          onSelect={() => oid && send(refActions.switchBranch(reference, oid))}
        >
          {t("gitRepo.switchBranch")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={context.busy || !oid}
          onSelect={() =>
            oid &&
            context.onPrompt({
              kind: "branch",
              oid,
              repositoryPath: repository,
            })
          }
        >
          {t("gitLog.menu.branchFromHere")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!idle || context.busy || !oid}
          onSelect={() =>
            oid && token && send(refActions.mergeInto(oid, "", token))
          }
        >
          {t("gitLog.menu.merge")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!idle || context.busy}
          onSelect={() =>
            token && send(refActions.rebaseOnto(reference, token))
          }
        >
          {t("gitLog.menu.rebaseOnto")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={context.busy || !branch}
          onSelect={() =>
            branch && send(refActions.pushBranch(remote, branch, false, null))
          }
        >
          {t("gitRepo.push")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={context.busy || !branch}
          onSelect={() =>
            branch && send(refActions.pushBranch(remote, branch, true, null))
          }
        >
          {t("gitLog.menu.setUpstream")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={context.busy || !branch}
          onSelect={() => branch && send(refActions.pullBranch(remote, branch))}
        >
          {t("gitRepo.pull")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={context.busy}
          onSelect={() => send(refActions.fetchRemote(remote, false))}
        >
          {t("gitRepo.fetch")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => context.onCompare(reference)}>
          {t("gitLog.menu.compareWithBranch")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => context.onCompare("HEAD")}>
          {t("gitLog.menu.diffWithWorktree")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            context.onToggleFavorite(refKey(repository, reference))
          }
        >
          {t(node.favorite ? "gitLog.tree.unfavorite" : "gitLog.tree.favorite")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={context.busy || !oid || node.current}
          onSelect={() => oid && send(refActions.deleteBranch(reference, oid))}
        >
          {t("gitRepo.deleteBranch")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 新建分支 / 新建标签要一个名字；菜单里放不下一个输入框。 */
export function NamePromptDialog({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: NamePrompt | null;
  onClose: () => void;
  onSubmit: (prompt: NamePrompt, name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          setName("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              prompt?.kind === "tag"
                ? "gitLog.menu.tagFromHere"
                : "gitLog.menu.branchFromHere",
            )}
          </DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          aria-label={t(
            prompt?.kind === "tag" ? "gitRepo.tagName" : "gitRepo.branchName",
          )}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !prompt || name.trim() === "") return;
            event.preventDefault();
            onSubmit(prompt, name.trim());
            setName("");
          }}
        />
        <p className="text-xs text-muted-foreground">
          {prompt?.oid.slice(0, 12)}
        </p>
        <DialogFooter>
          <Button
            disabled={!prompt || name.trim() === ""}
            onClick={() => {
              if (!prompt || name.trim() === "") return;
              onSubmit(prompt, name.trim());
              setName("");
            }}
          >
            {t("gitRepo.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
