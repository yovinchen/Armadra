/**
 * 工具栏上的 `Stash…` 与 `Unstash…`（Git 工具窗口设计 §2.3）。
 *
 * 两个对话框只负责问清楚要对哪个仓库的哪一条做什么；动作本身由
 * `actions/stash.ts` 拼，和页签版 Stash 页用的是同一组规则——差异一旦出现，
 * 表现就是「同一条 stash 在两个界面里一个能应用一个不能」。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { gitGateway } from "../../../git/gateway";
import { useGitTarget } from "../../../git/target";
import { useT } from "../../../app/preferences-store";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import { Check, Field, ReadError, selectClass } from "../forms";
import type { RepositoryRequest } from "../actions/integration";
import {
  canCreateStash,
  createStashAction,
  isUniqueStash,
  stashEntryAction,
  type StashEntryAction,
} from "../actions/stash";

export interface StashRepository {
  /** 工作空间相对路径。 */
  repositoryPath: string;
  name: string;
}

interface Shared {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  repositories: readonly StashRepository[];
  busy: boolean;
  onRequest: (repositoryPath: string, request: RepositoryRequest) => void;
}

/** 多仓库时先说清是哪一个；单仓库时这一行不出现。 */
function RepositoryPicker({
  repositories,
  value,
  onChange,
}: {
  repositories: readonly StashRepository[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  if (repositories.length <= 1) return null;
  return (
    <Field label={t("gitRepo.repository")}>
      <select
        className={selectClass}
        aria-label={t("gitRepo.repository")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {repositories.map((repository) => (
          <option
            key={repository.repositoryPath}
            value={repository.repositoryPath}
          >
            {repository.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function useStashes(
  workspaceId: string,
  repositoryPath: string,
  enabled: boolean,
) {
  const target = useGitTarget(workspaceId, repositoryPath);
  return useQuery({
    queryKey: ["git-repository-stashes", workspaceId, repositoryPath],
    queryFn: ({ signal }) => gitGateway.stashes(target, signal),
    enabled,
    retry: false,
  });
}

export function StashDialog({
  open,
  onOpenChange,
  workspaceId,
  repositories,
  busy,
  onRequest,
}: Shared) {
  const t = useT();
  const [repositoryPath, setRepositoryPath] = useState(
    repositories[0]?.repositoryPath ?? ".",
  );
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const snapshot = useStashes(workspaceId, repositoryPath, open);
  const state = snapshot.data ?? null;
  const submit = () => {
    const created = createStashAction(state, { message, includeUntracked });
    if (!created || busy) return;
    onRequest(repositoryPath, created);
    onOpenChange(false);
    setMessage("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("gitCommit.stash")}</DialogTitle>
          <DialogDescription>{t("gitStash.safety")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          <RepositoryPicker
            repositories={repositories}
            value={repositoryPath}
            onChange={setRepositoryPath}
          />
          <Field label={t("gitStash.message")}>
            <Input
              value={message}
              maxLength={4096}
              onChange={(event) => setMessage(event.target.value)}
            />
          </Field>
          <Check
            label={t("gitStash.includeUntracked")}
            checked={includeUntracked}
            onChange={setIncludeUntracked}
          />
          {snapshot.error && (
            <ReadError
              error={snapshot.error}
              retry={() => void snapshot.refetch()}
            />
          )}
          {state && !state.dirty && <p>{t("gitStash.noChanges")}</p>}
          {state?.hasConflicts && (
            <p role="alert" className="text-[var(--warn)]">
              {t("gitStash.existingConflicts")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("gitRepo.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy || !canCreateStash(state)}
            onClick={submit}
          >
            {t("gitRepo.createStash")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UnstashDialog({
  open,
  onOpenChange,
  workspaceId,
  repositories,
  busy,
  onRequest,
}: Shared) {
  const t = useT();
  const [repositoryPath, setRepositoryPath] = useState(
    repositories[0]?.repositoryPath ?? ".",
  );
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const snapshot = useStashes(workspaceId, repositoryPath, open);
  const state = snapshot.data ?? null;
  const selected =
    state?.stashes.find((entry) => entry.oid === selectedOid) ?? null;
  const target = useGitTarget(workspaceId, repositoryPath);
  const detail = useQuery({
    queryKey: [
      "git-repository-stash-detail",
      workspaceId,
      repositoryPath,
      selected?.oid,
    ],
    queryFn: async ({ signal }) => {
      const result = await gitGateway.stashDetail(
        target,
        selected!.oid,
        signal,
      );
      if (result.oid !== selected!.oid) throw new Error(t("gitStash.changed"));
      return result;
    },
    enabled: open && Boolean(selected),
    retry: false,
  });
  // 差异要和选中的那一条对得上才算「看过」。删除是唯一不需要它的动作——它删的
  // 是记录本身，不往工作区写任何东西。
  const reviewed =
    Boolean(selected) &&
    detail.data?.oid === selected?.oid &&
    !detail.isFetching &&
    !detail.isError;
  const act = (kind: StashEntryAction) => {
    if (busy) return;
    if (kind !== "dropStash" && !reviewed) return;
    const request = stashEntryAction(state, selected, kind, { reinstateIndex });
    if (!request) return;
    onRequest(repositoryPath, request);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("gitCommit.unstash")}</DialogTitle>
          <DialogDescription>{t("gitStash.conflictSafety")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          <RepositoryPicker
            repositories={repositories}
            value={repositoryPath}
            onChange={(next) => {
              setRepositoryPath(next);
              setSelectedOid(null);
            }}
          />
          {snapshot.error && (
            <ReadError
              error={snapshot.error}
              retry={() => void snapshot.refetch()}
            />
          )}
          {state?.stashes.length === 0 && <p>{t("gitStash.empty")}</p>}
          <ul aria-label={t("gitStash.title")} className="space-y-1">
            {state?.stashes.map((entry) => (
              <li key={`${entry.selector}:${entry.oid}`}>
                <button
                  type="button"
                  aria-pressed={entry.oid === selectedOid}
                  onClick={() => setSelectedOid(entry.oid)}
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted aria-pressed:bg-muted"
                >
                  <span className="min-w-0 truncate font-medium">
                    {entry.subject}
                  </span>
                  <span className="min-w-0 truncate font-mono text-muted-foreground">
                    {entry.selector} · {entry.authorName} · {entry.authorTime}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <section aria-label={selected.oid} className="space-y-2">
              {detail.isPending && <p role="status">{t("gitRepo.loading")}</p>}
              {detail.error && (
                <ReadError
                  error={detail.error}
                  retry={() => void detail.refetch()}
                />
              )}
              {reviewed && detail.data && (
                <pre
                  className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]"
                  tabIndex={0}
                >
                  {detail.data.patch || t("gitStash.noPatch")}
                </pre>
              )}
              <Check
                label={t("gitStash.reinstateIndex")}
                checked={reinstateIndex}
                onChange={setReinstateIndex}
              />
              {!isUniqueStash(state, selected) && (
                <p role="alert">{t("gitStash.duplicate")}</p>
              )}
              <p className="text-muted-foreground">
                {t("gitStash.dropSafety")}
              </p>
            </section>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !reviewed || state?.hasConflicts}
            onClick={() => act("applyStash")}
          >
            {t("gitRepo.applyStash")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !reviewed || state?.hasConflicts}
            onClick={() => act("popStash")}
          >
            {t("gitRepo.popStash")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || !selected}
            onClick={() => act("dropStash")}
          >
            {t("gitRepo.dropStash")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
