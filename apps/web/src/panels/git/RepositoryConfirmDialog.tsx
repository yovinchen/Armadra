import type { GitExpectedState, GitRepositoryAction } from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { actionTarget, type Confirmation } from "./operations";

/**
 * 一次仓库写操作的确认框：复述将要发生的事和被比对的期望状态，强推这类不可逆
 * 动作还要第二次勾选。什么时候不能提交由调用方算好后传进来。
 */
export function RepositoryConfirmDialog({
  confirmation,
  setConfirmation,
  acknowledged,
  setAcknowledged,
  blocked,
  repositoryPath,
  submit,
}: {
  confirmation: Confirmation | null;
  setConfirmation: (value: Confirmation | null) => void;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  blocked: boolean;
  repositoryPath: string;
  submit: (input: {
    action: GitRepositoryAction;
    expected: GitExpectedState;
  }) => void;
}) {
  const t = useT();
  const lease =
    confirmation?.action.kind === "push"
      ? confirmation.action.forceWithLease
      : null;
  return (
    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmation(null);
      }}
    >
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("gitRepo.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("gitRepo.confirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {confirmation && (
          <dl className="space-y-2 break-all text-xs">
            {confirmation.review && (
              <div>
                <dt className="text-muted-foreground">
                  {t("gitIntegration.commitOid")}
                </dt>
                <dd className="font-mono">{confirmation.review.oid}</dd>
                {confirmation.review.mainline && (
                  <dd>
                    {t("gitIntegration.mainline")}:{" "}
                    {confirmation.review.mainline}
                    {confirmation.review.parentOid && (
                      <span className="font-mono">
                        {" "}
                        · {confirmation.review.parentOid}
                      </span>
                    )}
                  </dd>
                )}
              </div>
            )}
            {confirmation.action.kind === "startCherryPick" && (
              <div>
                <dt>{t("gitIntegration.pickSafety")}</dt>
                <dd>
                  {confirmation.action.recordOrigin ? "✓ " : "— "}
                  {t("gitIntegration.recordOrigin")}
                </dd>
                {confirmation.action.mainline && (
                  <dd>
                    {t("gitIntegration.mainline")}:{" "}
                    {confirmation.action.mainline}
                  </dd>
                )}
              </div>
            )}
            {confirmation.action.kind === "revert" && (
              <div>
                <dd>{t("gitRepo.revertSafety")}</dd>
                {confirmation.action.mainline && (
                  <dd>
                    {t("gitIntegration.mainline")}:{" "}
                    {confirmation.action.mainline}
                  </dd>
                )}
              </div>
            )}
            {confirmation.action.kind === "checkoutCommit" && (
              <div>
                <dd>{t("gitRepo.detachedSafety")}</dd>
              </div>
            )}
            {confirmation.action.kind === "reset" && (
              <div>
                <dd>{t(`gitRepo.resetSafety.${confirmation.action.mode}`)}</dd>
                {confirmation.action.discardChanges && (
                  <dd>{t("gitRepo.resetRecovery")}</dd>
                )}
              </div>
            )}
            {confirmation.action.kind === "skipIntegration" && (
              <div>
                <dd>{t("gitIntegration.skipSafety")}</dd>
              </div>
            )}
            {confirmation.action.kind === "startMerge" && (
              <div>
                <dd>{t("gitIntegration.startSafety")}</dd>
              </div>
            )}
            {confirmation.action.kind === "startRebase" && (
              <div>
                <dd>{t("gitIntegration.rebaseSafety")}</dd>
              </div>
            )}
            {confirmation.action.kind === "startInteractiveRebase" && (
              <div>
                <dd>{t("gitRepo.rebaseTodoSafety")}</dd>
                <dd>{t("gitIntegration.rebaseSafety")}</dd>
              </div>
            )}
            {confirmation.action.kind === "sync" && (
              <div>
                <dt className="text-muted-foreground">
                  {t("gitRepo.remoteOid")}
                </dt>
                <dd className="font-mono">
                  {confirmation.action.expectedRemoteOid ??
                    t("gitRepo.remoteBranchMissing")}
                </dd>
                <dd>{t("gitRepo.syncSafety")}</dd>
              </div>
            )}
            {lease && (
              <div className="space-y-1 rounded-md border border-destructive p-2">
                <dt className="text-muted-foreground">
                  {t("gitRepo.leaseReplaces")}
                </dt>
                <dd className="font-mono">{lease.expectedRemoteOid}</dd>
                <dd>{t("gitRepo.leaseSafety")}</dd>
                <dd>
                  <label className="flex min-h-9 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--brand)]"
                      checked={acknowledged}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                    />
                    {t("gitRepo.leaseAcknowledge")}
                  </label>
                </dd>
              </div>
            )}
            {confirmation.action.kind === "abortIntegration" && (
              <div>
                <dd>{t("gitIntegration.abortSafety")}</dd>
              </div>
            )}
            {confirmation.action.kind === "createStash" && (
              <div>
                <dt>{t("gitStash.safety")}</dt>
                <dd>
                  {confirmation.action.includeUntracked ? "✓ " : "— "}
                  {t("gitStash.includeUntracked")}
                </dd>
              </div>
            )}
            {(confirmation.action.kind === "applyStash" ||
              confirmation.action.kind === "popStash") && (
              <div>
                <dt>{t("gitStash.conflictSafety")}</dt>
                <dd>
                  {confirmation.action.reinstateIndex ? "✓ " : "— "}
                  {t("gitStash.reinstateIndex")}
                </dd>
              </div>
            )}
            {(confirmation.action.kind === "popStash" ||
              confirmation.action.kind === "dropStash") && (
              <div>
                <dd>{t("gitStash.dropSafety")}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">
                {t("gitRepo.repository")}
              </dt>
              <dd>{repositoryPath}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t(`gitRepo.${confirmation.action.kind}`)}
              </dt>
              <dd>{actionTarget(confirmation.action)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("gitRepo.head")}</dt>
              <dd>
                {confirmation.expected.branch ?? t("gitRepo.detached")} ·{" "}
                {confirmation.expected.headOid ?? t("gitRepo.unborn")}
              </dd>
            </div>
          </dl>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("gitRepo.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={blocked || (Boolean(lease) && !acknowledged)}
            onClick={() => {
              if (confirmation && !blocked && (!lease || acknowledged)) {
                submit(confirmation);
                setConfirmation(null);
              }
            }}
          >
            {t(lease ? "gitRepo.confirmForce" : "gitRepo.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
