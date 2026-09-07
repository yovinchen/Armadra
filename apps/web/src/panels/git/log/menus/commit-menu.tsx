import type { ReactNode } from "react";
import type { GitLogCommit, GitRepositoryAction } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { writeClipboard } from "../../../../terminal/TerminalSurface";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../../../ui/context-menu";
import {
  checkoutCommit,
  mainlineOf,
  resetToCommit,
  revertCommit,
} from "../../actions/commit";
import * as refActions from "../../actions/refs";
import type { MenuContext } from "./context";

/**
 * 提交行的右键菜单（Git 工具窗口设计 §2.2）。
 *
 * cherry-pick 与交互式 rebase 走对话框而不是直接发动作：一个要选 mainline 并
 * 先看差异，另一个要审阅整份 todo。两件事都无法在一个菜单项里表达，从前它们
 * 长在「合并与冲突」页签里，现在挂回它们真正的入口——那一行提交。
 */

export function CommitContextMenu({
  commit,
  context,
  children,
}: {
  commit: GitLogCommit;
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
            context.onCherryPick({
              repositoryPath: repository,
              oid: commit.oid,
            })
          }
        >
          {t("gitLog.menu.cherryPick")}
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
          {t("gitLog.menu.rebaseOnto")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!idle || context.busy}
          onSelect={() =>
            context.onInteractiveRebase({
              repositoryPath: repository,
              oid: commit.oid,
            })
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
