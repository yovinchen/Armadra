import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitExpectedState,
  GitRepositoryAction,
  GitStashDetail,
  GitStashSnapshot,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Check, Field, ReadError } from "./forms";
import {
  createStashAction,
  isUniqueStash,
  stashEntryAction,
  type StashEntryAction,
} from "./actions/stash";

export interface StashesProps {
  workspaceId: string;
  repositoryKey: string;
  busy: boolean;
  loadSnapshot: (signal: AbortSignal) => Promise<GitStashSnapshot>;
  loadDetail: (oid: string, signal: AbortSignal) => Promise<GitStashDetail>;
  /** Opens the enclosing repository confirmation dialog; never auto-submits. */
  request: (action: GitRepositoryAction, expected: GitExpectedState) => void;
}

export function Stashes(props: StashesProps) {
  // Remount local form/selection state when its repository authority changes.
  return (
    <StashSession
      key={`${props.workspaceId}:${props.repositoryKey}`}
      {...props}
    />
  );
}

function StashSession({
  workspaceId,
  repositoryKey,
  busy,
  loadSnapshot,
  loadDetail,
  request,
}: StashesProps) {
  const t = useT();
  const client = useQueryClient();
  const queryKey = ["git-repository-stashes", workspaceId, repositoryKey];
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const snapshot = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await loadSnapshot(signal);
      if (`${result.repositoryId}:${result.repositoryPath}` !== repositoryKey)
        throw new Error(t("gitStash.changed"));
      return result;
    },
    retry: false,
  });
  const selected = snapshot.data?.stashes.find(
    (entry) => entry.oid === selectedOid,
  );
  const detail = useQuery({
    queryKey: [
      "git-repository-stash-detail",
      workspaceId,
      repositoryKey,
      selected?.oid,
    ],
    queryFn: async ({ signal }) => {
      const oid = selected!.oid;
      const result = await loadDetail(oid, signal);
      if (result.oid !== oid) throw new Error(t("gitStash.changed"));
      return result;
    },
    enabled: Boolean(selected),
    retry: false,
  });
  const currentlyBlocked = () =>
    busy ||
    snapshot.isError ||
    !snapshot.data ||
    client.getQueryState(queryKey)?.fetchStatus === "fetching" ||
    client.getQueryData(queryKey) !== snapshot.data;
  const blocked = currentlyBlocked();
  const state = snapshot.data;
  const confirmedDetail =
    selected &&
    detail.data?.oid === selected.oid &&
    !detail.isFetching &&
    !detail.isError;
  const unique = isUniqueStash(state, selected);
  const act = (kind: StashEntryAction) => {
    if (currentlyBlocked() || !confirmedDetail) return;
    const requested = stashEntryAction(state, selected, kind, {
      reinstateIndex,
    });
    if (requested) request(requested.action, requested.expected);
  };
  return (
    <div className="min-w-0 space-y-3 p-3 text-xs">
      <Button
        variant="outline"
        size="sm"
        disabled={snapshot.isFetching}
        onClick={() => void snapshot.refetch()}
      >
        {t("gitRepo.refresh")}
      </Button>
      {snapshot.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {snapshot.error && (
        <ReadError
          error={snapshot.error}
          retry={() => void snapshot.refetch()}
        />
      )}
      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (currentlyBlocked()) return;
          const created = createStashAction(state, {
            message,
            includeUntracked,
          });
          if (created) request(created.action, created.expected);
        }}
      >
        <fieldset
          className="min-w-0 space-y-2"
          disabled={blocked || state?.hasConflicts || !state?.head.headOid}
        >
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
          <p className="text-muted-foreground">{t("gitStash.safety")}</p>
          <Button type="submit" size="sm" disabled={!state?.dirty}>
            {t("gitRepo.createStash")}
          </Button>
          {state && !state.dirty && (
            <p className="text-muted-foreground">{t("gitStash.noChanges")}</p>
          )}
        </fieldset>
      </form>
      <p className="text-muted-foreground">{t("gitStash.conflictSafety")}</p>
      {state?.hasConflicts && (
        <p role="alert" className="text-[var(--warn)]">
          {t("gitStash.existingConflicts")}
        </p>
      )}
      {state?.stashes.length === 0 && <p>{t("gitStash.empty")}</p>}
      <div className="space-y-2" aria-label={t("gitStash.title")}>
        {state?.stashes.map((entry) => (
          <section
            key={`${entry.selector}:${entry.oid}`}
            className="min-w-0 space-y-1 rounded-md border border-border p-2"
          >
            <h3 className="break-words font-medium">{entry.subject}</h3>
            <p className="break-all font-mono text-muted-foreground">
              {entry.selector} · {entry.oid}
            </p>
            <p className="break-words text-muted-foreground">
              {entry.authorName} · {entry.authorTime}
            </p>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={entry.oid === selectedOid}
              onClick={() => setSelectedOid(entry.oid)}
            >
              {t("gitStash.view")}
            </Button>
          </section>
        ))}
      </div>
      {selected && (
        <section
          aria-label={selected.oid}
          className="min-w-0 space-y-3 rounded-md border border-border p-3"
        >
          <h3 className="break-all font-mono">{selected.oid}</h3>
          {detail.isPending && <p role="status">{t("gitRepo.loading")}</p>}
          {detail.error && (
            <ReadError
              error={detail.error}
              retry={() => void detail.refetch()}
            />
          )}
          {confirmedDetail && detail.data && (
            <>
              <details>
                <summary>{t("gitStash.parents")}</summary>
                {detail.data.parents.map((oid) => (
                  <p key={oid} className="break-all font-mono">
                    {oid}
                  </p>
                ))}
              </details>
              {(
                [
                  ["gitStash.patch", detail.data.patch],
                  ["gitStash.stagedPatch", detail.data.stagedPatch],
                  ["gitStash.untrackedPatch", detail.data.untrackedPatch],
                ] as const
              ).map(([label, patch]) => (
                <details key={label} open={label === "gitStash.patch"}>
                  <summary className="cursor-pointer">{t(label)}</summary>
                  <pre
                    className="max-h-80 overflow-auto rounded bg-muted p-2 text-[11px]"
                    tabIndex={0}
                  >
                    {patch || t("gitStash.noPatch")}
                  </pre>
                </details>
              ))}
            </>
          )}
          <fieldset
            className="space-y-2"
            disabled={blocked || !confirmedDetail || !unique}
          >
            <Check
              label={t("gitStash.reinstateIndex")}
              checked={reinstateIndex}
              onChange={setReinstateIndex}
            />
            {!unique && <p role="alert">{t("gitStash.duplicate")}</p>}
            <p className="text-muted-foreground">{t("gitStash.dropSafety")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={state?.hasConflicts}
                onClick={() => act("applyStash")}
              >
                {t("gitRepo.applyStash")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={state?.hasConflicts}
                onClick={() => act("popStash")}
              >
                {t("gitRepo.popStash")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => act("dropStash")}
              >
                {t("gitRepo.dropStash")}
              </Button>
            </div>
          </fieldset>
        </section>
      )}
    </div>
  );
}
