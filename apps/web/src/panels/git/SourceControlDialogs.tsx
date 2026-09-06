// 抽屉里两个「先问一次」的对话框：新建仓库，以及还原一个文件。两者都会丢掉
// 工作，所以都由调用方给出确认后的动作，这里只负责问清楚丢的是什么。
import type { GitRestoreSource } from "@armadra/shared";
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

/** 待还原的文件：属于哪个仓库、是不是未跟踪，决定问法与可选动作。 */
export type RestoreTarget = {
  path: string;
  untracked: boolean;
  repository: string;
};

export function SourceControlDialogs({
  confirmInit,
  setConfirmInit,
  init,
  restore,
  setRestore,
  revert,
}: {
  confirmInit: boolean;
  setConfirmInit: (next: boolean) => void;
  init: () => void;
  restore: RestoreTarget | null;
  setRestore: (next: RestoreTarget | null) => void;
  revert: (input: {
    path: string;
    source: GitRestoreSource;
    repository: string;
  }) => void;
}) {
  const t = useT();
  return (
    <>
      <AlertDialog
        open={confirmInit}
        onOpenChange={(next) => {
          if (!next) setConfirmInit(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("scm.initTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("scm.initDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("scm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmInit(false);
                init();
              }}
            >
              {t("scm.initConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
       * Restoring from the index and restoring from HEAD lose different work,
       * so they are two labelled actions rather than one “revert” whose
       * effect the user has to guess.
       */}
      <AlertDialog
        open={restore !== null}
        onOpenChange={(next) => {
          if (!next) setRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("scm.revertTitle", { path: restore?.path ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                restore?.untracked
                  ? "scm.restoreUntracked"
                  : "scm.restoreDescription",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("scm.cancel")}</AlertDialogCancel>
            {restore?.untracked ? (
              <AlertDialogAction
                onClick={() => {
                  if (restore)
                    revert({
                      path: restore.path,
                      source: "index",
                      repository: restore.repository,
                    });
                  setRestore(null);
                }}
              >
                {t("scm.restoreDelete")}
              </AlertDialogAction>
            ) : (
              (["index", "head"] as const).map((source) => (
                <AlertDialogAction
                  key={source}
                  onClick={() => {
                    if (restore)
                      revert({
                        path: restore.path,
                        source,
                        repository: restore.repository,
                      });
                    setRestore(null);
                  }}
                >
                  {t(
                    source === "index"
                      ? "scm.restoreFromIndex"
                      : "scm.restoreFromHead",
                  )}
                </AlertDialogAction>
              ))
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
