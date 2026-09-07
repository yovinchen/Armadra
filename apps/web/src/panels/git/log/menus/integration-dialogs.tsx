import type {
  GitCherryPickPreview,
  GitIntegrationSnapshot,
  GitRebaseTodoPreview,
  GitRepositoryAction,
} from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { writeClipboard } from "../../../../terminal/TerminalSurface";
import { Button } from "../../../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../../ui/dialog";
import { CherryPick } from "../../CherryPick";
import { RebaseTodo } from "../../RebaseTodo";
import type { CommitDialogTarget } from "./context";

/**
 * 交互式 rebase 与 cherry-pick 的入口，从「合并与冲突」页签搬到提交行右键。
 *
 * 两个组件原样复用：它们各自的审阅（整份 todo、mainline 与差异预览）才是这两
 * 件事的全部难点，重写一遍等于把那份审阅重写一遍。这里只负责把它们放进对话框，
 * 并且在它们发出请求之后关掉自己——写仍然落在日志页那一个确认门上。
 */

export function RebaseTodoDialog({
  target,
  workspaceId,
  state,
  busy,
  loadPreview,
  request,
  onClose,
}: {
  target: CommitDialogTarget | null;
  workspaceId: string;
  /** 目标仓库的整合快照；缺席时按钮自己会灰着。 */
  state: GitIntegrationSnapshot | undefined;
  busy: boolean;
  loadPreview: (
    repositoryPath: string,
    onto: string,
    signal: AbortSignal,
  ) => Promise<GitRebaseTodoPreview>;
  request: (repositoryPath: string, action: GitRepositoryAction) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("gitRepo.rebaseTodo")}</DialogTitle>
          <DialogDescription className="break-all font-mono">
            {target?.oid.slice(0, 12)}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] min-w-0 overflow-auto text-xs">
          {target && (
            <RebaseTodo
              key={`${target.repositoryPath}:${target.oid}`}
              workspaceId={workspaceId}
              repositoryKey={target.repositoryPath}
              onto={target.oid}
              state={state}
              disabled={busy}
              loadPreview={(onto, signal) =>
                loadPreview(target.repositoryPath, onto, signal)
              }
              request={(action) => {
                request(target.repositoryPath, action);
                onClose();
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CherryPickDialog({
  target,
  workspaceId,
  state,
  busy,
  loadPreview,
  request,
  onClose,
}: {
  target: CommitDialogTarget | null;
  workspaceId: string;
  state: GitIntegrationSnapshot | null;
  busy: boolean;
  loadPreview: (
    repositoryPath: string,
    oid: string,
    mainline: number | null,
    signal: AbortSignal,
  ) => Promise<GitCherryPickPreview>;
  request: (repositoryPath: string, action: GitRepositoryAction) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("gitIntegration.cherryPick")}</DialogTitle>
          <DialogDescription>
            {t("gitLog.menu.cherryPickPasteOid")}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <Button
            variant="outline"
            size="sm"
            className="justify-start font-mono"
            onClick={() => writeClipboard(target.oid)}
          >
            {target.oid}
          </Button>
        )}
        <div className="max-h-[60vh] min-w-0 overflow-auto text-xs">
          {target && state && (
            <CherryPick
              key={`${target.repositoryPath}:${target.oid}`}
              workspaceId={workspaceId}
              repositoryKey={target.repositoryPath}
              state={state}
              disabled={busy}
              canRequest={() => !busy}
              loadPreview={(oid, mainline, signal) =>
                loadPreview(target.repositoryPath, oid, mainline, signal)
              }
              request={(action) => {
                request(target.repositoryPath, action);
                onClose();
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
