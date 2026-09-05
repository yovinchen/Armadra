import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitBranchRecord,
  GitCherryPickPreview,
  GitConflictSide,
  GitExpectedState,
  GitIntegrationSnapshot,
  GitRebaseTodoPreview,
  GitRepositoryAction,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Field, ReadError, selectClass } from "./forms";
import { CherryPick } from "./CherryPick";
import { RebaseTodo } from "./RebaseTodo";
import { invalidateGitQueries } from "./queries";

export interface IntegrationsProps {
  workspaceId: string;
  repositoryKey: string;
  branches: GitBranchRecord[];
  busy: boolean;
  loadSnapshot: (signal: AbortSignal) => Promise<GitIntegrationSnapshot>;
  loadCherryPick: (
    oid: string,
    mainline: number | null,
    signal: AbortSignal,
  ) => Promise<GitCherryPickPreview>;
  /** The commits an interactive rebase onto that commit would replay. */
  loadRebaseTodo: (
    onto: string,
    signal: AbortSignal,
  ) => Promise<GitRebaseTodoPreview>;
  request: (action: GitRepositoryAction, expected: GitExpectedState) => void;
  openFile: (path: string) => void;
  /**
   * Stage one resolved path. Rejected by the service while the file still
   * holds conflict markers, so the failure text carries their line numbers.
   */
  markResolved: (path: string) => Promise<unknown>;
}
// Only owned kinds reach the recovery buttons, so merge is the safe default.
function recoveryLabel(kind: GitIntegrationSnapshot["kind"]) {
  return kind === "cherryPick"
    ? "Pick"
    : kind === "rebase"
      ? "Rebase"
      : kind === "revert"
        ? "Revert"
        : "Merge";
}
export function Integrations(props: IntegrationsProps) {
  return (
    <IntegrationSession
      key={`${props.workspaceId}:${props.repositoryKey}`}
      {...props}
    />
  );
}
function IntegrationSession({
  workspaceId,
  repositoryKey,
  branches,
  busy,
  loadSnapshot,
  loadCherryPick,
  loadRebaseTodo,
  request,
  openFile,
  markResolved,
}: IntegrationsProps) {
  const t = useT();
  const client = useQueryClient();
  const queryKey = ["git-repository-integration", workspaceId, repositoryKey];
  // Saving a merged file is not resolving it: this action stages the path and
  // reports the exact lines the service refused it on.
  const [resolveError, setResolveError] = useState<{
    path: string;
    message: string;
  } | null>(null);
  const resolve = useMutation({
    mutationFn: (path: string) => markResolved(path),
    onMutate: () => setResolveError(null),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey });
      invalidateGitQueries(client, workspaceId);
    },
    onError: (error, path) =>
      setResolveError({
        path,
        message:
          error instanceof Error ? error.message : t("gitIntegration.failed"),
      }),
  });
  const [targetRef, setTargetRef] = useState("");
  const [rebaseRef, setRebaseRef] = useState("");
  const [message, setMessage] = useState("");
  const targets = branches.filter(
    (branch) => !branch.current && !branch.symbolicTarget,
  );
  const target = targets.find((branch) => branch.fullRef === targetRef);
  const onto = targets.find((branch) => branch.fullRef === rebaseRef);
  const status = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await loadSnapshot(signal);
      if (`${result.repositoryId}:${result.repositoryPath}` !== repositoryKey)
        throw new Error(t("gitIntegration.changed"));
      if (signal.aborted)
        throw new DOMException("Request cancelled", "AbortError");
      // The server may have reconciled/released an old merge owner. Refresh
      // history after this read, but never invalidate this integration query.
      void client.invalidateQueries({
        queryKey: [
          "git-repository-operations",
          workspaceId,
          result.repositoryId,
          result.repositoryPath,
        ],
      });
      return result;
    },
    retry: false,
    refetchInterval: busy ? 1000 : false,
  });
  const state = status.data;
  const currentlyBlocked = () =>
    busy ||
    status.isError ||
    !state ||
    client.getQueryState(queryKey)?.fetchStatus === "fetching" ||
    client.getQueryData(queryKey) !== state;
  const blocked = currentlyBlocked();
  const canStart =
    !blocked &&
    state?.kind === "none" &&
    !state.dirty &&
    !state.conflicts.length &&
    state.head.branch &&
    state.head.headOid;
  const resume = (mode: "continue" | "abort" | "skip") => {
    if (
      currentlyBlocked() ||
      !state?.owned ||
      !state.sessionId ||
      (mode === "continue" && !state.canContinue) ||
      (mode === "skip" && !state.canSkip)
    )
      return;
    request(
      {
        kind:
          mode === "abort"
            ? "abortIntegration"
            : mode === "skip"
              ? "skipIntegration"
              : "continueIntegration",
        sessionId: state.sessionId,
        expectedStateToken: state.stateToken,
      },
      { ...state.head },
    );
  };
  return (
    <div className="min-w-0 space-y-3 p-3 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={status.isFetching}
        onClick={() => void status.refetch()}
      >
        {t("gitRepo.refresh")}
      </Button>
      {status.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {status.error && (
        <ReadError error={status.error} retry={() => void status.refetch()} />
      )}
      {state?.kind === "none" && (
        <>
          <p>{t("gitIntegration.none")}</p>
          <form
            className="space-y-2 rounded-md border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (canStart && !currentlyBlocked() && target && state)
                request(
                  {
                    kind: "startMerge",
                    targetOid: target.oid,
                    message,
                    expectedStateToken: state.stateToken,
                  },
                  { ...state.head },
                );
            }}
          >
            <fieldset disabled={!canStart} className="min-w-0 space-y-2">
              <Field label={t("gitIntegration.target")}>
                <select
                  className={selectClass}
                  value={target?.fullRef ?? ""}
                  onChange={(event) => setTargetRef(event.target.value)}
                  required
                >
                  <option value="">{t("gitRepo.chooseBranch")}</option>
                  {targets.map((branch) => (
                    <option key={branch.fullRef} value={branch.fullRef}>
                      {branch.name} · {branch.oid.slice(0, 12)}
                    </option>
                  ))}
                </select>
              </Field>
              {target && <p className="break-all font-mono">{target.oid}</p>}
              <Field label={t("gitIntegration.message")}>
                <Input
                  maxLength={4096}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </Field>
              <p className="text-muted-foreground">
                {t("gitIntegration.startSafety")}
              </p>
              <Button type="submit" size="sm" disabled={!target}>
                {t("gitRepo.startMerge")}
              </Button>
            </fieldset>
            {state.dirty && <p>{t("gitIntegration.dirty")}</p>}
          </form>
          <form
            className="space-y-2 rounded-md border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (canStart && !currentlyBlocked() && onto && state)
                request(
                  {
                    kind: "startRebase",
                    // Send the reviewed object ID, not a name that could move
                    // between this render and the queued operation.
                    onto: onto.oid,
                    expectedStateToken: state.stateToken,
                  },
                  { ...state.head },
                );
            }}
          >
            <fieldset disabled={!canStart} className="min-w-0 space-y-2">
              <Field label={t("gitIntegration.rebaseOnto")}>
                <select
                  className={selectClass}
                  value={onto?.fullRef ?? ""}
                  onChange={(event) => setRebaseRef(event.target.value)}
                  required
                >
                  <option value="">{t("gitRepo.chooseBranch")}</option>
                  {targets.map((branch) => (
                    <option key={branch.fullRef} value={branch.fullRef}>
                      {branch.name} · {branch.oid.slice(0, 12)}
                    </option>
                  ))}
                </select>
              </Field>
              {onto && <p className="break-all font-mono">{onto.oid}</p>}
              <p className="text-muted-foreground">
                {t("gitIntegration.rebaseSafety")}
              </p>
              <Button type="submit" size="sm" disabled={!onto}>
                {t("gitRepo.startRebase")}
              </Button>
            </fieldset>
          </form>
          <RebaseTodo
            workspaceId={workspaceId}
            repositoryKey={repositoryKey}
            onto={onto?.oid ?? ""}
            state={state}
            disabled={!canStart}
            loadPreview={loadRebaseTodo}
            request={request}
          />
          <CherryPick
            workspaceId={workspaceId}
            repositoryKey={repositoryKey}
            state={state}
            disabled={!canStart}
            canRequest={() => Boolean(canStart) && !currentlyBlocked()}
            loadPreview={loadCherryPick}
            request={request}
          />
        </>
      )}
      {state && state.kind !== "none" && (
        <section className="space-y-2 rounded-md border border-border p-3">
          <h3 className="font-medium">
            {t(`gitIntegration.kind.${state.kind}`)}
          </h3>
          <p className="break-all font-mono">
            {state.head.branch ?? t("gitRepo.detached")} · {state.head.headOid}
          </p>
          {state.originalBranch && (
            <p className="break-all text-muted-foreground">
              {t("gitIntegration.originalBranch")}:{" "}
              <span className="font-mono">{state.originalBranch}</span>
            </p>
          )}
          {state.originalHead && (
            <p className="break-all font-mono text-muted-foreground">
              {state.originalHead} → {state.targetOid ?? "—"}
            </p>
          )}
          {state.message && (
            <details>
              <summary>{t("gitIntegration.message")}</summary>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words p-2">
                {state.message}
              </pre>
            </details>
          )}
          {!state.owned && (
            <div role="alert" className="space-y-1 text-[var(--warn)]">
              <p>{t("gitIntegration.external")}</p>
              <p>{t("gitIntegration.restart")}</p>
            </div>
          )}
          {state.owned && (
            <>
              <p role="status">
                {t(
                  state.empty
                    ? "gitIntegration.emptyPick"
                    : state.canContinue
                      ? state.kind === "cherryPick"
                        ? "gitIntegration.pickReady"
                        : state.kind === "rebase"
                          ? "gitIntegration.rebaseReady"
                          : "gitIntegration.pending"
                      : "gitIntegration.stageFirst",
                )}
              </p>
              <p className="text-muted-foreground">
                {t("gitIntegration.abortSafety")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={blocked || !state.canContinue}
                  onClick={() => resume("continue")}
                >
                  {t(`gitIntegration.continue${recoveryLabel(state.kind)}`)}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={blocked}
                  onClick={() => resume("abort")}
                >
                  {t(`gitIntegration.abort${recoveryLabel(state.kind)}`)}
                </Button>
                {state.kind === "cherryPick" && state.empty && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={blocked || !state.canSkip}
                    onClick={() => resume("skip")}
                  >
                    {t("gitRepo.skipIntegration")}
                  </Button>
                )}
              </div>
              {state.mainline && (
                <p className="font-mono">
                  {t("gitIntegration.mainline")}: {state.mainline}
                </p>
              )}
              {state.empty && (
                <p className="text-muted-foreground">
                  {t("gitIntegration.skipSafety")}
                </p>
              )}
            </>
          )}
        </section>
      )}
      {Boolean(state?.conflicts.length) && (
        <p className="text-muted-foreground">
          {t("gitIntegration.stageFirst")}
        </p>
      )}
      {state?.conflicts.map((file) => (
        <section
          key={file.path}
          className="min-w-0 space-y-2 rounded-md border border-border p-3"
        >
          <h3 className="whitespace-pre-wrap break-all font-mono font-medium">
            {file.path}
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              onClick={() => {
                if (!currentlyBlocked()) openFile(file.path);
              }}
            >
              {t("gitIntegration.open")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || resolve.isPending}
              onClick={() => {
                if (!currentlyBlocked()) resolve.mutate(file.path);
              }}
            >
              {t("gitIntegration.markResolved")}
            </Button>
          </div>
          <p className="text-muted-foreground">
            {t("gitIntegration.markResolvedSafety")}
          </p>
          {resolveError?.path === file.path && (
            <p role="alert" className="break-words text-destructive">
              {resolveError.message}
            </p>
          )}
          {(["base", "ours", "theirs"] as const).map((name) => (
            <details key={name} open={name !== "base"}>
              <summary className="cursor-pointer">
                {t(`gitIntegration.${name}`)}
              </summary>
              <Side side={file[name]} />
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
function Side({ side }: { side: GitConflictSide | null }) {
  const t = useT();
  if (!side)
    return (
      <p className="p-2 text-muted-foreground">{t("gitIntegration.absent")}</p>
    );
  return (
    <div className="space-y-1 py-2">
      <p className="break-all font-mono text-muted-foreground">
        {side.oid} · {side.mode} · {side.size} B
      </p>
      {side.mode === "160000" ? (
        <p>{t("gitIntegration.submodule")}</p>
      ) : side.truncated ? (
        <p>{t("gitIntegration.truncated")}</p>
      ) : side.binary ? (
        <p>{t("gitIntegration.binary")}</p>
      ) : (
        <pre
          className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]"
          tabIndex={0}
        >
          {side.preview}
        </pre>
      )}
    </div>
  );
}
