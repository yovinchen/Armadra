import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  GitExpectedState,
  GitIntegrationSnapshot,
  GitRebaseTodoCommand,
  GitRebaseTodoEntry,
  GitRebaseTodoPreview,
  GitRepositoryAction,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Field, ReadError, selectClass } from "./forms";

export interface RebaseTodoProps {
  workspaceId: string;
  repositoryKey: string;
  /** The reviewed commit to replay onto; empty means no preview is read. */
  onto: string;
  state: GitIntegrationSnapshot | undefined;
  disabled: boolean;
  loadPreview: (
    onto: string,
    signal: AbortSignal,
  ) => Promise<GitRebaseTodoPreview>;
  request: (action: GitRepositoryAction, expected: GitExpectedState) => void;
}

/**
 * 可审阅的 rebase todo：先展示将被重放的提交（最旧在前），允许调整顺序、
 * squash 或 drop，再以非交互方式执行。列表必须覆盖区间内的全部提交——
 * 丢弃只能显式写 drop，不能靠「不列出来」，服务端也按这一条复核。
 */
export function RebaseTodo({
  workspaceId,
  repositoryKey,
  onto,
  state,
  disabled,
  loadPreview,
  request,
}: RebaseTodoProps) {
  const t = useT();
  const [entries, setEntries] = useState<GitRebaseTodoEntry[]>([]);
  const preview = useQuery({
    queryKey: ["git-repository-rebase-todo", workspaceId, repositoryKey, onto],
    queryFn: ({ signal }) => loadPreview(onto, signal),
    enabled: Boolean(onto),
    retry: false,
  });
  const commits = preview.data?.commits;
  useEffect(() => {
    setEntries(
      (commits ?? []).map((commit) => ({
        oid: commit.oid,
        command: "pick" as GitRebaseTodoCommand,
      })),
    );
  }, [commits]);
  const subject = (oid: string) =>
    commits?.find((commit) => commit.oid === oid)?.subject ?? oid.slice(0, 12);
  const move = (index: number, delta: number) =>
    setEntries((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  const setCommand = (index: number, command: GitRebaseTodoCommand) =>
    setEntries((current) =>
      current.map((entry, position) =>
        position === index ? { ...entry, command } : entry,
      ),
    );
  // A squash needs a kept commit before it, and dropping everything would
  // leave nothing to replay. Both are refused by the service too.
  const keptBefore = entries.map((_, index) =>
    entries.slice(0, index).some((entry) => entry.command !== "drop"),
  );
  const invalid =
    entries.length === 0 ||
    entries.every((entry) => entry.command === "drop") ||
    entries.some(
      (entry, index) => entry.command === "squash" && !keptBefore[index],
    );
  const blocked =
    disabled || invalid || !state || Boolean(preview.data?.hasMerges);
  return (
    <section className="min-w-0 space-y-2 rounded-md border border-border p-3">
      <h3 className="font-medium">{t("gitRepo.rebaseTodo")}</h3>
      <p className="text-muted-foreground">{t("gitRepo.rebaseTodoSafety")}</p>
      {!onto && <p>{t("gitRepo.rebaseTodoChoose")}</p>}
      {preview.isPending && onto && <p role="status">{t("gitRepo.loading")}</p>}
      {preview.error && (
        <ReadError error={preview.error} retry={() => void preview.refetch()} />
      )}
      {preview.data?.hasMerges && (
        <p role="alert" className="text-[var(--warn)]">
          {t("gitRepo.rebaseTodoMerges")}
        </p>
      )}
      {preview.data && entries.length === 0 && !preview.data.hasMerges && (
        <p>{t("gitRepo.rebaseTodoEmpty")}</p>
      )}
      <ol className="space-y-2">
        {entries.map((entry, index) => (
          <li
            key={entry.oid}
            className="min-w-0 space-y-1 rounded-md border border-border p-2"
          >
            <p className="break-words">{subject(entry.oid)}</p>
            <p className="break-all font-mono text-muted-foreground">
              {entry.oid.slice(0, 12)}
            </p>
            <Field label={t("gitRepo.rebaseTodoCommand")}>
              <select
                className={selectClass}
                value={entry.command}
                disabled={disabled}
                onChange={(event) =>
                  setCommand(index, event.target.value as GitRebaseTodoCommand)
                }
              >
                {(["pick", "squash", "drop"] as const).map((command) => (
                  <option key={command} value={command}>
                    {t(`gitRepo.rebaseTodo.${command}`)}
                  </option>
                ))}
              </select>
            </Field>
            {entry.command === "squash" && !keptBefore[index] && (
              <p role="alert" className="text-destructive">
                {t("gitRepo.rebaseTodoSquashNeedsKept")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                {t("gitRepo.rebaseTodoUp")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={disabled || index === entries.length - 1}
                onClick={() => move(index, 1)}
              >
                {t("gitRepo.rebaseTodoDown")}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {entries.length > 0 && (
        <Button
          size="sm"
          disabled={blocked}
          onClick={() => {
            if (blocked || !state) return;
            request(
              {
                kind: "startInteractiveRebase",
                // The reviewed object ID, not a name that could move between
                // this render and the queued operation.
                onto: preview.data?.onto ?? onto,
                todo: entries,
                expectedStateToken: state.stateToken,
              },
              { ...state.head },
            );
          }}
        >
          {t("gitRepo.startInteractiveRebase")}
        </Button>
      )}
    </section>
  );
}
